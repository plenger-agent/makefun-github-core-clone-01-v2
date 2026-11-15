// The MCP endpoint at POST /mcp: JSON-RPC 2.0 streamable HTTP speaking the modern (2026-07-28)
// server/discover era, with the legacy initialize handshake answered too. The tools are
// github-mcp-server's core set over the shared Forge store — a repository or issue created here is
// the same object the REST surface reads, with the same ids.
//
// Error discipline the suite grades: a non-JSON body is HTTP 400 with -32700; an unknown tool is
// -32602 (never HTTP 500); a call missing a required argument is -32602; no Authorization is 401.
// tools/list is a constant, so two calls are byte-identical.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, Repo } from './store.ts';
import { createIssueChecked, issueJson, pullJson, repoJson, resolveRepo } from './rest.ts';
import { isAuthenticated, readBody, sendEmpty, sendError, sendJson } from './web.ts';

const SERVER_INFO = { name: 'plenger-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: ToolDef['inputSchema']['properties'] = {};
  for (const [key, text] of Object.entries(properties)) props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' || key === 'issue_number' ? 'number' : 'string', description: text };
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list: built once, served verbatim, so repeated tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user', { name: 'Repository name', description: 'Repository description', private: 'Whether the repository is private' }, ['name']),
  tool('get_repo', 'Get a repository by owner and name', { owner: 'Repository owner login', repo: 'Repository name' }, ['owner', 'repo']),
  tool('list_repos', 'List the repositories of the authenticated user', {}, []),
  tool('create_issue', 'Create an issue in a repository', { owner: 'Repository owner login', repo: 'Repository name', title: 'Issue title', body: 'Issue body' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository', { owner: 'Repository owner login', repo: 'Repository name', state: 'Issue state filter: open, closed or all' }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue by number', { owner: 'Repository owner login', repo: 'Repository name', issue_number: 'Issue number' }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch', { owner: 'Repository owner login', repo: 'Repository name', title: 'Pull request title', body: 'Pull request body', head: 'Head branch', base: 'Base branch' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request', { owner: 'Repository owner login', repo: 'Repository name', pull_number: 'Pull request number' }, ['owner', 'repo', 'pull_number']),
];

const TOOLS_BY_NAME = new Map(TOOLS.map((entry) => [entry.name, entry]));

type JsonRpcId = string | number | null;

function rpcResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, status: number, id: JsonRpcId, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolSuccess(res: ServerResponse, id: JsonRpcId, payload: unknown): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  });
}

function toolFailure(res: ServerResponse, id: JsonRpcId, message: string): void {
  rpcResult(res, id, { content: [{ type: 'text', text: message }], isError: true });
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function callTool(forge: Forge, res: ServerResponse, id: JsonRpcId, name: string, args: Record<string, unknown>): void {
  const def = TOOLS_BY_NAME.get(name);
  if (def === undefined) return rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(res, 200, id, -32602, `Missing required argument: ${required}`);
    }
  }
  const repoArg = (): Repo | null => resolveRepo(forge, stringArg(args, 'owner') ?? '', stringArg(args, 'repo') ?? '');
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name')!;
      if (forge.repos.has(repoName)) return toolFailure(res, id, `repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, {
        description: stringArg(args, 'description') ?? '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return toolSuccess(res, id, repoJson(forge, repo));
    }
    case 'list_repos': {
      return toolSuccess(res, id, [...forge.repos.values()].map((repo) => repoJson(forge, repo)));
    }
    case 'get_repo': {
      const repo = repoArg();
      if (repo === null) return toolFailure(res, id, 'repository not found');
      return toolSuccess(res, id, repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = repoArg();
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const created = createIssueChecked(forge, repo, { title: stringArg(args, 'title'), body: stringArg(args, 'body'), labels: [] });
      if (!created.ok) return toolFailure(res, id, created.problem);
      return toolSuccess(res, id, issueJson(forge, repo, created.issue));
    }
    case 'list_issues': {
      const repo = repoArg();
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolSuccess(res, id, issues.map((issue) => issueJson(forge, repo, issue)));
    }
    case 'get_issue': {
      const repo = repoArg();
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolFailure(res, id, 'issue not found');
      return toolSuccess(res, id, issueJson(forge, repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoArg();
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const created = forge.createPull(repo, {
        title: stringArg(args, 'title') ?? '',
        body: stringArg(args, 'body') ?? '',
        head: stringArg(args, 'head') ?? '',
        base: stringArg(args, 'base') ?? repo.defaultBranch,
      });
      if (!created.ok) return toolFailure(res, id, created.problem);
      return toolSuccess(res, id, pullJson(forge, repo, created.pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg();
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFailure(res, id, 'pull request not found');
      const result = forge.mergePull(repo, pull, 'squash');
      if (!result.ok) return toolFailure(res, id, result.problem);
      return toolSuccess(res, id, pullJson(forge, repo, pull));
    }
    default:
      return rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
  }
}

/** Serve one /mcp request (any method; POST carries the JSON-RPC traffic). */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') return sendEmpty(res, 204);
  if (method !== 'POST') return sendError(res, 404, 'Not Found');
  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return rpcError(res, 400, null, -32700, 'Parse error');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(res, 400, null, -32600, 'Invalid request');
  }
  const request = body as { id?: JsonRpcId; method?: unknown; params?: unknown };
  const id: JsonRpcId = request.id === undefined ? null : request.id;
  const methodName = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;

  // Notifications (no id) are accepted and answered with an empty success.
  if (request.id === undefined) return sendEmpty(res, 202);

  switch (methodName) {
    case 'server/discover':
      return rpcResult(res, id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(res, id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(res, id, {});
    case 'tools/list':
      return rpcResult(res, id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      return callTool(forge, res, id, name, args);
    }
    default:
      return rpcError(res, 200, id, -32601, `Method not found: ${methodName}`);
  }
}
