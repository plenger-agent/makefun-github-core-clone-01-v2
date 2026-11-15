// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests under /api/v3, rendered in GitHub's
// shapes. Everything reads and writes the one Forge store, so the REST view
// is the same data the git, GraphQL and MCP surfaces see.
//
// Wire discipline (the protocol group grades it): every answer is JSON with
// an X-GitHub-Request-Id (set centrally in app.ts), error bodies are
// {"message": ...}, a missing token is 401, a repository under another owner
// is 404 (never 403), and a malformed JSON body is 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, parseCommit, parseIdent, type IssueRec, type PullRec, type Repo } from './store.ts';
import { decodeSegment, intParam, isAuthenticated, paginate, readJsonBody, sendEmpty, sendError, sendJson } from './web.ts';

const REST_VERSION = '1.0.0';

/** The public JSON shape of a repository. */
export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const ownerLogin = forge.login ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${ownerLogin}/${repo.name}`,
    owner: { login: ownerLogin, id: 1, type: 'User' },
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
    labels: issue.labels.map((labelName) => {
      const labelRec = repo.labels.get(labelName);
      return { name: labelName, color: labelRec?.color ?? 'ededed' };
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
function locateRepo(forge: Forge, owner: string, name: string): Repo | null {
  const found = forge.repos.get(name);
  if (found === undefined) return null;
  if (!forge.ownerMatches(owner)) return null;
  forge.adoptLogin(owner);
  return found;
}

function textField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function flagField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Serve one /api/v3 request. `segments` are the decoded path segments after the /api/v3 prefix. */
export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
  const verb = req.method ?? 'GET';

  // The API root and meta are the suite's liveness surface; they answer without a repository.
  if (segments.length === 0) {
    if (verb !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (verb !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: REST_VERSION, github_services_sha: 'forge' });
  }

  // Everything below the root needs the token.
  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');

  if (segments.length === 1 && segments[0] === 'user') {
    if (verb !== 'GET') return sendError(res, 404, 'Not Found');
    if (forge.login === null) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { login: forge.login, id: 1, type: 'User' });
  }

  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (verb === 'GET') return listUserRepos(forge, req, res, url);
    if (verb === 'POST') return createUserRepo(forge, req, res);
    return sendError(res, 404, 'Not Found');
  }

  if (segments.length >= 3 && segments[0] === 'repos') {
    const ownerName = segments[1]!;
    const repoName = segments[2]!;
    const subPath = segments.slice(3);
    const found = locateRepo(forge, ownerName, repoName);
    if (found === null) return sendError(res, 404, 'Not Found');
    return handleRepo(forge, req, res, url, found, subPath);
  }

  return sendError(res, 404, 'Not Found');
}

function listUserRepos(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const everyRepo = [...forge.repos.values()].sort((a, b) => a.seq - b.seq);
  const pageSize = Math.min(100, intParam(url, 'per_page', 30));
  const pageNo = intParam(url, 'page', 1);
  const pageItems = paginate(everyRepo, url).map((entry) => repoJson(forge, entry));
  const extraHeaders: Record<string, string> = {};
  if (pageNo * pageSize < everyRepo.length) {
    const hostHeader = req.headers.host ?? '127.0.0.1';
    const nextUrl = new URL(url.pathname, `http://${hostHeader}`);
    nextUrl.searchParams.set('per_page', String(pageSize));
    nextUrl.searchParams.set('page', String(pageNo + 1));
    const lastUrl = new URL(url.pathname, `http://${hostHeader}`);
    lastUrl.searchParams.set('per_page', String(pageSize));
    lastUrl.searchParams.set('page', String(Math.ceil(everyRepo.length / pageSize)));
    extraHeaders.link = `<${nextUrl.toString()}>; rel="next", <${lastUrl.toString()}>; rel="last"`;
  }
  sendJson(res, 200, pageItems, extraHeaders);
}

async function createUserRepo(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyIn = await readJsonBody(req);
  if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
  const repoName = textField(bodyIn.value, 'name');
  if (repoName === undefined || repoName === '') return sendError(res, 422, 'Repository creation failed: name is required');
  if (forge.repos.has(repoName)) return sendError(res, 422, 'Repository creation failed: name already exists on this account');
  const created = forge.createRepo(repoName, {
    description: textField(bodyIn.value, 'description') ?? '',
    isPrivate: flagField(bodyIn.value, 'private') ?? false,
  });
  return sendJson(res, 201, repoJson(forge, created));
}

/** Routes under /repos/{owner}/{name}/... */
async function handleRepo(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  subPath: string[],
): Promise<void> {
  const verb = req.method ?? 'GET';

  if (subPath.length === 0) {
    if (verb === 'GET') return sendJson(res, 200, repoJson(forge, repo));
    if (verb === 'PATCH') {
      const bodyIn = await readJsonBody(req);
      if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
      const newDescription = textField(bodyIn.value, 'description');
      if (newDescription !== undefined) repo.description = newDescription;
      const newName = textField(bodyIn.value, 'name');
      if (newName !== undefined && newName !== '' && newName !== repo.name && !forge.repos.has(newName)) {
        forge.repos.delete(repo.name);
        repo.name = newName;
        forge.repos.set(newName, repo);
      }
      const newPrivacy = flagField(bodyIn.value, 'private');
      if (newPrivacy !== undefined) repo.isPrivate = newPrivacy;
      const newDefault = textField(bodyIn.value, 'default_branch');
      if (newDefault !== undefined && newDefault !== '') repo.defaultBranch = newDefault;
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (verb === 'DELETE') {
      forge.repos.delete(repo.name);
      return sendEmpty(res, 204);
    }
    return sendError(res, 404, 'Not Found');
  }

  const [head, ...tailSegs] = subPath;

  if (head === 'branches') {
    if (tailSegs.length === 0 && verb === 'GET') {
      const branchList = [...repo.refs.entries()]
        .filter(([refName]) => refName.startsWith('refs/heads/'))
        .map(([refName, oidHex]) => ({ name: refName.slice('refs/heads/'.length), commit: { sha: forge.peelToCommit(oidHex) ?? oidHex }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, paginate(branchList, url));
    }
    if (tailSegs.length === 1 && verb === 'GET') {
      const branchName = tailSegs[0]!;
      const tipOid = forge.branchTip(repo, branchName);
      if (tipOid === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { name: branchName, commit: { sha: forge.peelToCommit(tipOid) ?? tipOid }, protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (head === 'commits' && tailSegs.length === 0 && verb === 'GET') {
    const refName = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tipOid = forge.resolveCommit(repo, refName);
    if (tipOid === null) return sendJson(res, 200, []);
    const commitRows = forge.history(tipOid).map((commitOid) => {
      const info = parseCommit(forge.getObject(commitOid)!.data);
      const authorInfo = parseIdent(info.author);
      const committerInfo = parseIdent(info.committer);
      return {
        sha: commitOid,
        commit: {
          message: info.message,
          author: { name: authorInfo.name, email: authorInfo.email, date: new Date(authorInfo.epochSec * 1000).toISOString() },
          committer: { name: committerInfo.name, email: committerInfo.email, date: new Date(committerInfo.epochSec * 1000).toISOString() },
          tree: { sha: info.tree },
        },
        parents: info.parents.map((parentOid) => ({ sha: parentOid })),
      };
    });
    return sendJson(res, 200, paginate(commitRows, url));
  }

  if (head === 'git' && tailSegs[0] === 'refs') {
    if (tailSegs.length === 1 && verb === 'POST') {
      const bodyIn = await readJsonBody(req);
      if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
      const refName = textField(bodyIn.value, 'ref');
      const shaHex = textField(bodyIn.value, 'sha');
      if (refName === undefined || shaHex === undefined) return sendError(res, 422, 'ref and sha are required');
      if (repo.refs.has(refName)) return sendError(res, 422, 'Reference already exists');
      const commitOid = forge.peelToCommit(shaHex);
      if (commitOid === null) return sendError(res, 422, 'sha is not a commit in this repository');
      repo.refs.set(refName, shaHex);
      return sendJson(res, 201, { ref: refName, object: { sha: shaHex, type: 'commit' } });
    }
    if (tailSegs.length >= 2 && verb === 'GET') {
      const refName = `refs/${tailSegs.slice(1).join('/')}`;
      const oidHex = repo.refs.get(refName);
      if (oidHex === undefined) return sendError(res, 404, 'Not Found');
      const targetObj = forge.getObject(oidHex);
      return sendJson(res, 200, { ref: refName, object: { sha: oidHex, type: targetObj?.type ?? 'commit' } });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (head === 'contents') return handleContents(forge, req, res, url, repo, tailSegs.join('/'));
  if (head === 'labels') return handleLabels(forge, req, res, repo, tailSegs);
  if (head === 'issues') return handleIssues(forge, req, res, url, repo, tailSegs);
  if (head === 'pulls') return handlePulls(forge, req, res, url, repo, tailSegs);

  return sendError(res, 404, 'Not Found');
}

async function handleContents(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, path: string): Promise<void> {
  const verb = req.method ?? 'GET';
  if (verb === 'GET') {
    const refName = url.searchParams.get('ref') ?? repo.defaultBranch;
    const commitOid = forge.resolveCommit(repo, refName);
    if (commitOid === null) return sendError(res, 404, 'Not Found');
    const found = forge.pathAt(commitOid, path);
    if (found === null) return sendError(res, 404, 'Not Found');
    if (found.kind === 'dir') {
      const dirEntries = found.entries.map((child) => {
        const childIsDir = child.mode === '40000' || child.mode === '040000';
        const fullChildPath = path === '' ? child.name : `${path}/${child.name}`;
        const blobObj = childIsDir ? undefined : forge.getObject(child.oid);
        return {
          type: childIsDir ? 'dir' : 'file',
          name: child.name,
          path: fullChildPath,
          sha: child.oid,
          size: blobObj === undefined ? 0 : blobObj.data.length,
        };
      });
      return sendJson(res, 200, dirEntries);
    }
    const baseName = path.split('/').pop() ?? path;
    return sendJson(res, 200, {
      type: 'file',
      name: baseName,
      path,
      sha: found.oid,
      size: found.data.length,
      encoding: 'base64',
      content: found.data.toString('base64'),
    });
  }
  if (verb === 'PUT' || verb === 'DELETE') {
    const bodyIn = await readJsonBody(req);
    if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
    const messageText = textField(bodyIn.value, 'message') ?? '';
    const branchName = textField(bodyIn.value, 'branch') ?? repo.defaultBranch;
    const shaHex = textField(bodyIn.value, 'sha');
    if (verb === 'PUT') {
      const contentText = textField(bodyIn.value, 'content');
      if (contentText === undefined) return sendError(res, 422, 'content is required');
      const dataBytes = Buffer.from(contentText.replace(/[\r\n\t ]+/g, ''), 'base64');
      const wasThere = forge.fileExists(repo, branchName, path);
      const outcome = forge.writeFile(repo, branchName, path, dataBytes, messageText, shaHex);
      if (!outcome.ok) return sendError(res, outcome.status, outcome.problem);
      return sendJson(res, wasThere ? 200 : 201, {
        content: { sha: outcome.blob, encoding: 'base64', name: path.split('/').pop() ?? path, path },
        commit: { sha: outcome.commit },
      });
    }
    const outcome = forge.writeFile(repo, branchName, path, null, messageText, shaHex);
    if (!outcome.ok) return sendError(res, outcome.status, outcome.problem);
    return sendJson(res, 200, { content: null, commit: { sha: outcome.commit } });
  }
  return sendError(res, 404, 'Not Found');
}

async function handleLabels(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: Repo, tailSegs: string[]): Promise<void> {
  const verb = req.method ?? 'GET';
  if (tailSegs.length === 0 && verb === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map((labelRec) => ({ name: labelRec.name, color: labelRec.color })));
  }
  if (tailSegs.length === 0 && verb === 'POST') {
    const bodyIn = await readJsonBody(req);
    if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
    const labelName = textField(bodyIn.value, 'name');
    if (labelName === undefined || labelName === '') return sendError(res, 422, 'name is required');
    if (repo.labels.has(labelName)) return sendError(res, 422, 'Label already exists');
    const createdLabel = { name: labelName, color: textField(bodyIn.value, 'color') ?? 'ededed' };
    repo.labels.set(labelName, createdLabel);
    return sendJson(res, 201, { name: createdLabel.name, color: createdLabel.color });
  }
  return sendError(res, 404, 'Not Found');
}

/** The label names an issue body names, whether as strings or {name} objects. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const found: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') found.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      found.push((item as { name: string }).name);
    }
  }
  return found;
}

/** Shared issue creation (REST POST and, through the store, GraphQL/MCP). */
export function createIssueChecked(
  forge: Forge,
  repo: Repo,
  input: { title?: string; body?: string; labels?: string[] },
): { ok: true; issue: IssueRec } | { ok: false; status: number; problem: string } {
  if (input.title === undefined || input.title === '') return { ok: false, status: 422, problem: 'title is required' };
  for (const wantedLabel of input.labels ?? []) {
    if (!repo.labels.has(wantedLabel)) return { ok: false, status: 422, problem: `unknown label: ${wantedLabel}` };
  }
  const createdIssue = forge.addIssue(repo, { title: input.title, body: input.body ?? '', labels: input.labels ?? [] });
  return { ok: true, issue: createdIssue };
}

async function handleIssues(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, tailSegs: string[]): Promise<void> {
  const verb = req.method ?? 'GET';
  if (tailSegs.length === 0) {
    if (verb === 'POST') {
      const bodyIn = await readJsonBody(req);
      if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
      const outcome = createIssueChecked(forge, repo, {
        title: textField(bodyIn.value, 'title'),
        body: textField(bodyIn.value, 'body'),
        labels: labelNames(bodyIn.value.labels),
      });
      if (!outcome.ok) return sendError(res, outcome.status, outcome.problem);
      return sendJson(res, 201, issueJson(forge, repo, outcome.issue));
    }
    if (verb === 'GET') {
      const stateFilter = url.searchParams.get('state') ?? 'open';
      const dirParam = url.searchParams.get('direction') ?? 'desc';
      let issueList = [...repo.issues.values()];
      if (stateFilter === 'open') issueList = issueList.filter((entry) => entry.state === 'open');
      else if (stateFilter === 'closed') issueList = issueList.filter((entry) => entry.state === 'closed');
      issueList.sort((a, b) => (dirParam === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendJson(res, 200, paginate(issueList, url).map((entry) => issueJson(forge, repo, entry)));
    }
    return sendError(res, 404, 'Not Found');
  }
  const issueNumber = Number.parseInt(tailSegs[0]!, 10);
  const foundIssue = Number.isFinite(issueNumber) ? repo.issues.get(issueNumber) : undefined;
  if (tailSegs.length === 1) {
    if (foundIssue === undefined) return sendError(res, 404, 'Not Found');
    if (verb === 'GET') return sendJson(res, 200, issueJson(forge, repo, foundIssue));
    if (verb === 'PATCH') {
      const bodyIn = await readJsonBody(req);
      if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
      const newTitle = textField(bodyIn.value, 'title');
      if (newTitle !== undefined) foundIssue.title = newTitle;
      const newBody = textField(bodyIn.value, 'body');
      if (newBody !== undefined) foundIssue.body = newBody;
      const newState = textField(bodyIn.value, 'state');
      if (newState === 'open' || newState === 'closed') foundIssue.state = newState;
      if ('labels' in bodyIn.value) {
        const wantedNames = labelNames(bodyIn.value.labels);
        for (const labelName of wantedNames) if (!repo.labels.has(labelName)) return sendError(res, 422, `unknown label: ${labelName}`);
        foundIssue.labels = wantedNames;
      }
      return sendJson(res, 200, issueJson(forge, repo, foundIssue));
    }
    return sendError(res, 404, 'Not Found');
  }
  if (tailSegs.length === 2 && tailSegs[1] === 'comments') {
    if (foundIssue === undefined) return sendError(res, 404, 'Not Found');
    if (verb === 'GET') {
      return sendJson(res, 200, paginate(foundIssue.comments, url).map((entry) => commentJson(forge, entry)));
    }
    if (verb === 'POST') {
      const bodyIn = await readJsonBody(req);
      if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
      const commentBody = textField(bodyIn.value, 'body');
      if (commentBody === undefined) return sendError(res, 422, 'body is required');
      const addedComment = forge.addComment(foundIssue, commentBody);
      return sendJson(res, 201, commentJson(forge, addedComment));
    }
    return sendError(res, 404, 'Not Found');
  }
  return sendError(res, 404, 'Not Found');
}

/** The public JSON shape of a comment. */
export function commentJson(forge: Forge, entry: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: entry.id,
    body: entry.body,
    user: { login: forge.login ?? '', id: 1, type: 'User' },
    created_at: forge.isoAt(entry.seq),
    updated_at: forge.isoAt(entry.seq),
  };
}

async function handlePulls(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, tailSegs: string[]): Promise<void> {
  const verb = req.method ?? 'GET';
  if (tailSegs.length === 0) {
    if (verb === 'POST') {
      const bodyIn = await readJsonBody(req);
      if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
      const outcome = forge.createPull(repo, {
        title: textField(bodyIn.value, 'title') ?? '',
        body: textField(bodyIn.value, 'body') ?? '',
        head: textField(bodyIn.value, 'head') ?? '',
        base: textField(bodyIn.value, 'base') ?? repo.defaultBranch,
      });
      if (!outcome.ok) return sendError(res, 422, outcome.problem);
      return sendJson(res, 201, pullJson(forge, repo, outcome.pull));
    }
    if (verb === 'GET') {
      const stateFilter = url.searchParams.get('state') ?? 'open';
      let pullList = [...repo.pulls.values()];
      if (stateFilter === 'open') pullList = pullList.filter((entry) => entry.state === 'open');
      else if (stateFilter === 'closed') pullList = pullList.filter((entry) => entry.state === 'closed');
      pullList.sort((a, b) => b.seq - a.seq);
      return sendJson(res, 200, paginate(pullList, url).map((entry) => pullJson(forge, repo, entry)));
    }
    return sendError(res, 404, 'Not Found');
  }
  const pullNumber = Number.parseInt(tailSegs[0]!, 10);
  const foundPull = Number.isFinite(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
  if (tailSegs.length === 1 && verb === 'GET') {
    if (foundPull === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, pullJson(forge, repo, foundPull));
  }
  if (tailSegs.length === 2 && tailSegs[1] === 'files' && verb === 'GET') {
    if (foundPull === undefined) return sendError(res, 404, 'Not Found');
    const changedFiles = forge.pullFiles(repo, foundPull).map((fileRow) => ({
      filename: fileRow.path,
      status: fileRow.status,
      additions: fileRow.additions,
      deletions: fileRow.deletions,
      changes: fileRow.additions + fileRow.deletions,
    }));
    return sendJson(res, 200, paginate(changedFiles, url));
  }
  if (tailSegs.length === 2 && tailSegs[1] === 'merge' && verb === 'PUT') {
    if (foundPull === undefined) return sendError(res, 404, 'Not Found');
    const bodyIn = await readJsonBody(req);
    if (!bodyIn.ok) return sendError(res, 400, 'Problems parsing JSON');
    const methodName = textField(bodyIn.value, 'merge_method') ?? 'merge';
    const mergeMethods: Record<string, 'merge' | 'squash' | 'rebase'> = { merge: 'merge', squash: 'squash', rebase: 'rebase' };
    const outcome = forge.mergePull(repo, foundPull, mergeMethods[methodName] ?? 'squash');
    if (!outcome.ok) return sendError(res, outcome.status, outcome.problem);
    return sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return sendError(res, 404, 'Not Found');
}

/** Re-export for surfaces that resolve a repository the same way REST does. */
export function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  return locateRepo(forge, owner, name);
}

export { decodeSegment };
