// The REST v3 surface: repositories, branches, commits, contents, labels, issues, comments and pull
// requests under /api/v3, in GitHub's shapes. Everything reads and writes the one Forge store, so the
// REST view is the same data the git, GraphQL and MCP surfaces see.
//
// Wire discipline (the protocol group grades it): every answer is JSON with an X-GitHub-Request-Id
// (set centrally in app.ts), error bodies are {"message": ...}, a missing token is 401, a repository
// under another owner is 404 (never 403), and a malformed JSON body is 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, parseCommit, parseIdent, type IssueRec, type PullRec, type Repo } from './store.ts';
import { decodeSegment, intParam, isAuthenticated, paginate, readJsonBody, sendEmpty, sendError, sendJson } from './web.ts';

const API_VERSION = '1.0.0';

/** The public JSON shape of a repository. */
export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const login = forge.login ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.isoAt(repo.seq),
    updated_at: forge.isoAt(repo.seq),
  };
}

/** The public JSON shape of an issue (labels as objects, as the checks' shape requires). */
export function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: forge.login ?? '', id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: forge.isoAt(issue.seq),
    updated_at: forge.isoAt(issue.seq),
  };
}

/** The public JSON shape of a pull request (head/base as {ref, sha} objects). */
export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? forge.isoAt(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${forge.login ?? ''}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${forge.login ?? ''}:${pull.baseRef}` },
    user: { login: forge.login ?? '', id: 1, type: 'User' },
    created_at: forge.isoAt(pull.seq),
    updated_at: forge.isoAt(pull.seq),
  };
}

/** Resolve /repos/{owner}/{name}: 404 for a foreign owner or a missing name (adopting the login). */
function findRepo(forge: Forge, owner: string, name: string): Repo | null {
  const repo = forge.repos.get(name);
  if (repo === undefined) return null;
  if (!forge.ownerMatches(owner)) return null;
  forge.adoptLogin(owner);
  return repo;
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Serve one /api/v3 request. `segments` are the decoded path segments after the /api/v3 prefix. */
export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
  const method = req.method ?? 'GET';

  // The API root and meta are the suite's liveness surface; they answer without a repository.
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: API_VERSION, github_services_sha: 'forge' });
  }

  // Everything below the root needs the token.
  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');

  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    if (forge.login === null) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { login: forge.login, id: 1, type: 'User' });
  }

  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(forge, req, res, url);
    if (method === 'POST') return createUserRepo(forge, req, res);
    return sendError(res, 404, 'Not Found');
  }

  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    const repo = findRepo(forge, owner, name);
    if (repo === null) return sendError(res, 404, 'Not Found');
    return handleRepo(forge, req, res, url, repo, rest);
  }

  return sendError(res, 404, 'Not Found');
}

function listUserRepos(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const all = [...forge.repos.values()].sort((a, b) => a.seq - b.seq);
  const perPage = Math.min(100, intParam(url, 'per_page', 30));
  const page = intParam(url, 'page', 1);
  const items = paginate(all, url).map((repo) => repoJson(forge, repo));
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const next = new URL(url.pathname, `http://${host}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const last = new URL(url.pathname, `http://${host}`);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(Math.ceil(all.length / perPage)));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  sendJson(res, 200, items, headers);
}

async function createUserRepo(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
  const name = stringField(parsed.value, 'name');
  if (name === undefined || name === '') return sendError(res, 422, 'Repository creation failed: name is required');
  if (forge.repos.has(name)) return sendError(res, 422, 'Repository creation failed: name already exists on this account');
  const repo = forge.createRepo(name, {
    description: stringField(parsed.value, 'description') ?? '',
    isPrivate: boolField(parsed.value, 'private') ?? false,
  });
  return sendJson(res, 201, repoJson(forge, repo));
}

/** Routes under /repos/{owner}/{name}/... */
async function handleRepo(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  rest: string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(forge, repo));
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const description = stringField(parsed.value, 'description');
      if (description !== undefined) repo.description = description;
      const name = stringField(parsed.value, 'name');
      if (name !== undefined && name !== '' && name !== repo.name && !forge.repos.has(name)) {
        forge.repos.delete(repo.name);
        repo.name = name;
        forge.repos.set(name, repo);
      }
      const isPrivate = boolField(parsed.value, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      const defaultBranch = stringField(parsed.value, 'default_branch');
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      return sendEmpty(res, 204);
    }
    return sendError(res, 404, 'Not Found');
  }

  const [head, ...tail] = rest;

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: forge.peelToCommit(oid) ?? oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, paginate(branches, url));
    }
    if (tail.length === 1 && method === 'GET') {
      const branch = tail[0]!;
      const tip = forge.branchTip(repo, branch);
      if (tip === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { name: branch, commit: { sha: forge.peelToCommit(tip) ?? tip }, protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    const refish = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, refish);
    if (tip === null) return sendJson(res, 200, []);
    const items = forge.history(tip).map((oid) => {
      const commit = parseCommit(forge.getObject(oid)!.data);
      const author = parseIdent(commit.author);
      const committer = parseIdent(commit.committer);
      return {
        sha: oid,
        commit: {
          message: commit.message,
          author: { name: author.name, email: author.email, date: new Date(author.epochSec * 1000).toISOString() },
          committer: { name: committer.name, email: committer.email, date: new Date(committer.epochSec * 1000).toISOString() },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return sendJson(res, 200, paginate(items, url));
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1 && method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const ref = stringField(parsed.value, 'ref');
      const sha = stringField(parsed.value, 'sha');
      if (ref === undefined || sha === undefined) return sendError(res, 422, 'ref and sha are required');
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      const commit = forge.peelToCommit(sha);
      if (commit === null) return sendError(res, 422, 'sha is not a commit in this repository');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    }
    if (tail.length >= 2 && method === 'GET') {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return sendError(res, 404, 'Not Found');
      const object = forge.getObject(oid);
      return sendJson(res, 200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (head === 'contents') return handleContents(forge, req, res, url, repo, tail.join('/'));
  if (head === 'labels') return handleLabels(forge, req, res, repo, tail);
  if (head === 'issues') return handleIssues(forge, req, res, url, repo, tail);
  if (head === 'pulls') return handlePulls(forge, req, res, url, repo, tail);

  return sendError(res, 404, 'Not Found');
}

async function handleContents(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const refish = url.searchParams.get('ref') ?? repo.defaultBranch;
    const commit = forge.resolveCommit(repo, refish);
    if (commit === null) return sendError(res, 404, 'Not Found');
    const hit = forge.pathAt(commit, path);
    if (hit === null) return sendError(res, 404, 'Not Found');
    if (hit.kind === 'dir') {
      const entries = hit.entries.map((entry) => {
        const isDir = entry.mode === '40000' || entry.mode === '040000';
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const blob = isDir ? undefined : forge.getObject(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: childPath,
          sha: entry.oid,
          size: blob === undefined ? 0 : blob.data.length,
        };
      });
      return sendJson(res, 200, entries);
    }
    const name = path.split('/').pop() ?? path;
    return sendJson(res, 200, {
      type: 'file',
      name,
      path,
      sha: hit.oid,
      size: hit.data.length,
      encoding: 'base64',
      content: hit.data.toString('base64'),
    });
  }
  if (method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const message = stringField(parsed.value, 'message') ?? '';
    const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
    const sha = stringField(parsed.value, 'sha');
    if (method === 'PUT') {
      const content = stringField(parsed.value, 'content');
      if (content === undefined) return sendError(res, 422, 'content is required');
      const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const existed = forge.fileExists(repo, branch, path);
      const result = forge.writeFile(repo, branch, path, bytes, message, sha);
      if (!result.ok) return sendError(res, result.status, result.problem);
      return sendJson(res, existed ? 200 : 201, {
        content: { sha: result.blob, encoding: 'base64', name: path.split('/').pop() ?? path, path },
        commit: { sha: result.commit },
      });
    }
    const result = forge.writeFile(repo, branch, path, null, message, sha);
    if (!result.ok) return sendError(res, result.status, result.problem);
    return sendJson(res, 200, { content: null, commit: { sha: result.commit } });
  }
  return sendError(res, 404, 'Not Found');
}

async function handleLabels(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0 && method === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
  }
  if (tail.length === 0 && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const name = stringField(parsed.value, 'name');
    if (name === undefined || name === '') return sendError(res, 422, 'name is required');
    if (repo.labels.has(name)) return sendError(res, 422, 'Label already exists');
    const label = { name, color: stringField(parsed.value, 'color') ?? 'ededed' };
    repo.labels.set(name, label);
    return sendJson(res, 201, { name: label.name, color: label.color });
  }
  return sendError(res, 404, 'Not Found');
}

/** The label names an issue body names, whether as strings or {name} objects. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** Shared issue creation (REST POST and, through the store, GraphQL/MCP). */
export function createIssueChecked(
  forge: Forge,
  repo: Repo,
  input: { title?: string; body?: string; labels?: string[] },
): { ok: true; issue: IssueRec } | { ok: false; status: number; problem: string } {
  if (input.title === undefined || input.title === '') return { ok: false, status: 422, problem: 'title is required' };
  for (const label of input.labels ?? []) {
    if (!repo.labels.has(label)) return { ok: false, status: 422, problem: `unknown label: ${label}` };
  }
  const issue = forge.addIssue(repo, { title: input.title, body: input.body ?? '', labels: input.labels ?? [] });
  return { ok: true, issue };
}

async function handleIssues(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const created = createIssueChecked(forge, repo, {
        title: stringField(parsed.value, 'title'),
        body: stringField(parsed.value, 'body'),
        labels: labelNames(parsed.value.labels),
      });
      if (!created.ok) return sendError(res, created.status, created.problem);
      return sendJson(res, 201, issueJson(forge, repo, created.issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendJson(res, 200, paginate(issues, url).map((issue) => issueJson(forge, repo, issue)));
    }
    return sendError(res, 404, 'Not Found');
  }
  const number = Number.parseInt(tail[0]!, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = stringField(parsed.value, 'title');
      if (title !== undefined) issue.title = title;
      const body = stringField(parsed.value, 'body');
      if (body !== undefined) issue.body = body;
      const state = stringField(parsed.value, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      if ('labels' in parsed.value) {
        const names = labelNames(parsed.value.labels);
        for (const name of names) if (!repo.labels.has(name)) return sendError(res, 422, `unknown label: ${name}`);
        issue.labels = names;
      }
      return sendJson(res, 200, issueJson(forge, repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') {
      return sendJson(res, 200, paginate(issue.comments, url).map((comment) => commentJson(forge, comment)));
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const body = stringField(parsed.value, 'body');
      if (body === undefined) return sendError(res, 422, 'body is required');
      const comment = forge.addComment(issue, body);
      return sendJson(res, 201, commentJson(forge, comment));
    }
    return sendError(res, 404, 'Not Found');
  }
  return sendError(res, 404, 'Not Found');
}

/** The public JSON shape of a comment. */
export function commentJson(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.login ?? '', id: 1, type: 'User' },
    created_at: forge.isoAt(comment.seq),
    updated_at: forge.isoAt(comment.seq),
  };
}

async function handlePulls(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const created = forge.createPull(repo, {
        title: stringField(parsed.value, 'title') ?? '',
        body: stringField(parsed.value, 'body') ?? '',
        head: stringField(parsed.value, 'head') ?? '',
        base: stringField(parsed.value, 'base') ?? repo.defaultBranch,
      });
      if (!created.ok) return sendError(res, 422, created.problem);
      return sendJson(res, 201, pullJson(forge, repo, created.pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      return sendJson(res, 200, paginate(pulls, url).map((pull) => pullJson(forge, repo, pull)));
    }
    return sendError(res, 404, 'Not Found');
  }
  const number = Number.parseInt(tail[0]!, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1 && method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, pullJson(forge, repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
    }));
    return sendJson(res, 200, paginate(files, url));
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const mergeMethod = stringField(parsed.value, 'merge_method') ?? 'merge';
    const methodMap: Record<string, 'merge' | 'squash' | 'rebase'> = { merge: 'merge', squash: 'squash', rebase: 'rebase' };
    const result = forge.mergePull(repo, pull, methodMap[mergeMethod] ?? 'squash');
    if (!result.ok) return sendError(res, result.status, result.problem);
    return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return sendError(res, 404, 'Not Found');
}

/** Re-export for surfaces that resolve a repository the same way REST does. */
export function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  return findRepo(forge, owner, name);
}

export { decodeSegment };
