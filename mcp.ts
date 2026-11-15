// The MCP endpoint at POST /mcp: JSON-RPC 2.0 streamable HTTP speaking the
// modern (2026-07-28) server/discover era, with the legacy initialize
// handshake answered too. The tools are github-mcp-server's core set over
// the shared Forge store — a repository or issue created here is the same
// object the REST surface reads, with the same ids.
//
// Error discipline the suite grades: a non-JSON body is HTTP 400 with
// -32700; an unknown tool is -32602 (never HTTP 500); a call missing a
// required argument is -32602; no Authorization is 401. tools/list is a
// constant, so two calls are byte-identical.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, Repo } from './store.ts';
import { createIssueChecked, issueJson, pullJson, repoJson, resolveRepo } from './rest.ts';
import { isAuthenticated, readBody, sendEmpty, sendError, sendJson } from './web.ts';

const SERVER_IDENTITY = { name: 'plenger-forge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function defineTool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolSpec {
  const schemaProps: ToolSpec['inputSchema']['properties'] = {};
  for (const [propName, blurb] of Object.entries(properties)) schemaProps[propName] = { type: propName === 'private' ? 'boolean' : propName === 'pull_number' || propName === 'issue_number' ? 'number' : 'string', description: blurb };
  return { name, description, inputSchema: { type: 'object', properties: schemaProps, required } };
}

/** The tool list: built once, served verbatim, so repeated tools/list answers are byte-identical. */
const TOOL_LIST: ToolSpec[] = [
  defineTool('create_repo', 'Create a new repository for the authenticated user', { name: 'Repository name', description: 'Repository description', private: 'Whether the repository is private' }, ['name']),
  defineTool('get_repo', 'Get a repository by owner and name', { owner: 'Repository owner login', repo: 'Repository name' }, ['owner', 'repo']),
  defineTool('list_repos', 'List the repositories of the authenticated user', {}, []),
  defineTool('create_issue', 'Create an issue in a repository', { owner: 'Repository owner login', repo: 'Repository name', title: 'Issue title', body: 'Issue body' }, ['owner', 'repo', 'title']),
  defineTool('list_issues', 'List the issues of a repository', { owner: 'Repository owner login', repo: 'Repository name', state: 'Issue state filter: open, closed or all' }, ['owner', 'repo']),
  defineTool('get_issue', 'Get one issue by number', { owner: 'Repository owner login', repo: 'Repository name', issue_number: 'Issue number' }, ['owner', 'repo', 'issue_number']),
  defineTool('create_pull_request', 'Open a pull request from a head branch into a base branch', { owner: 'Repository owner login', repo: 'Repository name', title: 'Pull request title', body: 'Pull request body', head: 'Head branch', base: 'Base branch' }, ['owner', 'repo', 'title', 'head', 'base']),
  defineTool('merge_pull_request', 'Merge a pull request', { owner: 'Repository owner login', repo: 'Repository name', pull_number: 'Pull request number' }, ['owner', 'repo', 'pull_number']),
];

const TOOL_INDEX = new Map(TOOL_LIST.map((entry) => [entry.name, entry]));

type RpcId = string | number | null;

function replyResult(res: ServerResponse, id: RpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function replyError(res: ServerResponse, status: number, id: RpcId, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function replyToolOk(res: ServerResponse, id: RpcId, payload: unknown): void {
  replyResult(res, id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  });
}

function replyToolFail(res: ServerResponse, id: RpcId, message: string): void {
  replyResult(res, id, { content: [{ type: 'text', text: message }], isError: true });
}

function textArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function callTool(forge: Forge, res: ServerResponse, id: RpcId, name: string, args: Record<string, unknown>): void {
  const spec = TOOL_INDEX.get(name);
  if (spec === undefined) return replyError(res, 200, id, -32602, `Unknown tool: ${name}`);
  for (const requiredName of spec.inputSchema.required) {
    if (args[requiredName] === undefined || args[requiredName] === null || args[requiredName] === '') {
      return replyError(res, 200, id, -32602, `Missing required argument: ${requiredName}`);
    }
  }
  const lookupRepo = (): Repo | null => resolveRepo(forge, textArg(args, 'owner') ?? '', textArg(args, 'repo') ?? '');
  switch (name) {
    case 'create_repo': {
      const newRepoName = textArg(args, 'name')!;
      if (forge.repos.has(newRepoName)) return replyToolFail(res, id, `repository ${newRepoName} already exists`);
      const created = forge.createRepo(newRepoName, {
        description: textArg(args, 'description') ?? '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return replyToolOk(res, id, repoJson(forge, created));
    }
    case 'list_repos': {
      return replyToolOk(res, id, [...forge.repos.values()].map((entry) => repoJson(forge, entry)));
    }
    case 'get_repo': {
      const found = lookupRepo();
      if (found === null) return replyToolFail(res, id, 'repository not found');
      return replyToolOk(res, id, repoJson(forge, found));
    }
    case 'create_issue': {
      const found = lookupRepo();
      if (found === null) return replyToolFail(res, id, 'repository not found');
      const outcome = createIssueChecked(forge, found, { title: textArg(args, 'title'), body: textArg(args, 'body'), labels: [] });
      if (!outcome.ok) return replyToolFail(res, id, outcome.problem);
      return replyToolOk(res, id, issueJson(forge, found, outcome.issue));
    }
    case 'list_issues': {
      const found = lookupRepo();
      if (found === null) return replyToolFail(res, id, 'repository not found');
      const stateArg = textArg(args, 'state') ?? 'open';
      let issueList = [...found.issues.values()].sort((a, b) => a.number - b.number);
      if (stateArg === 'open') issueList = issueList.filter((entry) => entry.state === 'open');
      else if (stateArg === 'closed') issueList = issueList.filter((entry) => entry.state === 'closed');
      return replyToolOk(res, id, issueList.map((entry) => issueJson(forge, found, entry)));
    }
    case 'get_issue': {
      const found = lookupRepo();
      if (found === null) return replyToolFail(res, id, 'repository not found');
      const issueNo = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = found.issues.get(issueNo);
      if (issue === undefined) return replyToolFail(res, id, 'issue not found');
      return replyToolOk(res, id, issueJson(forge, found, issue));
    }
    case 'create_pull_request': {
      const found = lookupRepo();
      if (found === null) return replyToolFail(res, id, 'repository not found');
      const outcome = forge.createPull(found, {
        title: textArg(args, 'title') ?? '',
        body: textArg(args, 'body') ?? '',
        head: textArg(args, 'head') ?? '',
        base: textArg(args, 'base') ?? found.defaultBranch,
      });
      if (!outcome.ok) return replyToolFail(res, id, outcome.problem);
      return replyToolOk(res, id, pullJson(forge, found, outcome.pull));
    }
    case 'merge_pull_request': {
      const found = lookupRepo();
      if (found === null) return replyToolFail(res, id, 'repository not found');
      const pullNo = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = found.pulls.get(pullNo);
      if (pull === undefined) return replyToolFail(res, id, 'pull request not found');
      const outcome = forge.mergePull(found, pull, 'squash');
      if (!outcome.ok) return replyToolFail(res, id, outcome.problem);
      return replyToolOk(res, id, pullJson(forge, found, pull));
    }
    default:
      return replyError(res, 200, id, -32602, `Unknown tool: ${name}`);
  }
}

/** Serve one /mcp request (any method; POST carries the JSON-RPC traffic). */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const verb = req.method ?? 'GET';
  if (verb === 'DELETE') return sendEmpty(res, 204);
  if (verb !== 'POST') return sendError(res, 404, 'Not Found');
  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');
  const rawBytes = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString('utf8')) as unknown;
  } catch {
    return replyError(res, 400, null, -32700, 'Parse error');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return replyError(res, 400, null, -32600, 'Invalid request');
  }
  const rpcRequest = parsed as { id?: RpcId; method?: unknown; params?: unknown };
  const rpcId: RpcId = rpcRequest.id === undefined ? null : rpcRequest.id;
  const rpcMethod = typeof rpcRequest.method === 'string' ? rpcRequest.method : '';
  const rpcParams = (rpcRequest.params !== null && typeof rpcRequest.params === 'object' ? rpcRequest.params : {}) as Record<string, unknown>;

  // Notifications (no id) are accepted and answered with an empty success.
  if (rpcRequest.id === undefined) return sendEmpty(res, 202);

  switch (rpcMethod) {
    case 'server/discover':
      return replyResult(res, rpcId, {
        supportedVersions: PROTOCOL_VERSIONS,
        serverInfo: SERVER_IDENTITY,
        capabilities: { tools: {} },
      });
    case 'initialize': {
      const wantedVersion = typeof rpcParams.protocolVersion === 'string' ? rpcParams.protocolVersion : '2025-11-25';
      const negotiated = PROTOCOL_VERSIONS.includes(wantedVersion) ? wantedVersion : '2025-11-25';
      return replyResult(res, rpcId, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_IDENTITY });
    }
    case 'ping':
      return replyResult(res, rpcId, {});
    case 'tools/list':
      return replyResult(res, rpcId, { tools: TOOL_LIST });
    case 'tools/call': {
      const toolName = typeof rpcParams.name === 'string' ? rpcParams.name : '';
      const toolArgs = (rpcParams.arguments !== null && typeof rpcParams.arguments === 'object' ? rpcParams.arguments : {}) as Record<string, unknown>;
      return callTool(forge, res, rpcId, toolName, toolArgs);
    }
    default:
      return replyError(res, 200, rpcId, -32601, `Method not found: ${rpcMethod}`);
  }
}
