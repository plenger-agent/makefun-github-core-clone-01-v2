// The forge's in-memory core: the git object store (SHA-1 addressed blobs,
// trees, commits and tags), the repositories built on it, and the issue /
// pull-request domain the REST, GraphQL and MCP surfaces all share. One
// store serves every surface, so an object created through any of them is
// the same object through the others.
//
// Determinism is a scoring rule (a trial's final state export must replay
// byte for byte), so nothing here reads the wall clock or a random source:
// timestamps come from a monotonic sequence laid over a fixed base epoch,
// ids from counters, and request ids from a counter too.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const EPOCH_BASE_SEC = 1_700_000_000;

/** SHA-1 of a git object: `<type> <byte length>\0` followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const prefix = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(prefix).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const rows: TreeEntry[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    const spaceAt = data.indexOf(0x20, cursor);
    const nulAt = data.indexOf(0x00, spaceAt);
    const modeText = data.toString('ascii', cursor, spaceAt);
    const nameText = data.toString('utf8', spaceAt + 1, nulAt);
    const oidHex = data.toString('hex', nulAt + 1, nulAt + 21);
    rows.push({ mode: modeText, name: nameText, oid: oidHex });
    cursor = nulAt + 21;
  }
  return rows;
}

/** Git's tree ordering: by name, with directory names compared as if they ended in '/'. */
function treeOrderKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries into a tree object's raw bytes (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => {
    const keyA = treeOrderKey(a);
    const keyB = treeOrderKey(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const row of ordered) {
    chunks.push(Buffer.from(`${row.mode} ${row.name}\0`, 'utf8'));
    chunks.push(Buffer.from(row.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object: headers (tree, parents, author, committer), a blank line, then the message. */
export function parseCommit(data: Buffer): CommitInfo {
  const rawText = data.toString('utf8');
  const splitAt = rawText.indexOf('\n\n');
  const headerBlock = splitAt === -1 ? rawText : rawText.slice(0, splitAt);
  const bodyText = splitAt === -1 ? '' : rawText.slice(splitAt + 2);
  let treeOid = '';
  let authorLine = '';
  let committerLine = '';
  const parentOids: string[] = [];
  for (const headerLine of headerBlock.split('\n')) {
    if (headerLine.startsWith('tree ')) treeOid = headerLine.slice(5).trim();
    else if (headerLine.startsWith('parent ')) parentOids.push(headerLine.slice(7).trim());
    else if (headerLine.startsWith('author ')) authorLine = headerLine.slice(7);
    else if (headerLine.startsWith('committer ')) committerLine = headerLine.slice(10);
  }
  return { tree: treeOid, parents: parentOids, author: authorLine, committer: committerLine, message: bodyText };
}

/** Parse an annotated tag object: its `object` header names the target. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const rawText = data.toString('utf8');
  let targetOid = '';
  let targetType = '';
  let tagName = '';
  for (const headerLine of rawText.split('\n')) {
    if (headerLine === '') break;
    if (headerLine.startsWith('object ')) targetOid = headerLine.slice(7).trim();
    else if (headerLine.startsWith('type ')) targetType = headerLine.slice(5).trim();
    else if (headerLine.startsWith('tag ')) tagName = headerLine.slice(4).trim();
  }
  return { object: targetOid, type: targetType, tag: tagName };
}

/** Split an ident line ("Name <email> 1700000000 +0000") into its parts. */
export function parseIdent(identLine: string): { name: string; email: string; epochSec: number } {
  const found = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(identLine.trim());
  if (found === null) return { name: identLine.trim(), email: '', epochSec: EPOCH_BASE_SEC };
  return { name: found[1] ?? '', email: found[2] ?? '', epochSec: Number(found[3] ?? EPOCH_BASE_SEC) };
}

// ---------------------------------------------------------------------------------------------
// domain records
// ---------------------------------------------------------------------------------------------

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedSeq: number;
  comments: CommentRec[];
  seq: number;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name ("refs/heads/main") -> commit oid. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  seq: number;
}

/** What a path inside a tree resolves to: a file's blob, or a directory's entries. */
export type PathHit =
  | { kind: 'file'; oid: string; data: Buffer; mode: string }
  | { kind: 'dir'; entries: TreeEntry[] }
  | null;

export class Forge {
  readonly objects = new Map<string, GitObj>();
  readonly repos = new Map<string, Repo>();
  /** The token owner's login, adopted from the first owner-bearing request that names it. */
  login: string | null = null;
  private tickCounter = 0;
  private nextRepoId = 0;
  private nextIssueId = 0;
  private nextCommentId = 0;
  private nextRequestNo = 0;

  /** The next deterministic sequence number (timestamps, ordering). */
  seq(): number {
    this.tickCounter += 1;
    return this.tickCounter;
  }

  /** A deterministic ISO timestamp for a sequence number. */
  isoAt(seq: number): string {
    return new Date((EPOCH_BASE_SEC + seq) * 1000).toISOString();
  }

  /** An epoch-second timestamp for a sequence number (commit objects). */
  epochAt(seq: number): number {
    return EPOCH_BASE_SEC + seq;
  }

  nextRequestId(): string {
    this.nextRequestNo += 1;
    return `FORGE-${this.nextRequestNo.toString(36).toUpperCase()}`;
  }

  /**
   * Learn the token owner's login from a request that names an owner. The
   * first owner that arrives with a repository that exists (or, before any
   * repository exists, the owner a creation flow names) becomes the login;
   * after that the login is fixed for the life of the process.
   */
  adoptLogin(owner: string): void {
    if (this.login === null && owner !== '') this.login = owner;
  }

  /** Whether `owner` is (or could still become) the token owner's login. */
  ownerMatches(owner: string): boolean {
    return this.login === null || this.login === owner;
  }

  // -------------------------------------------------------------------------------------------
  // object store
  // -------------------------------------------------------------------------------------------

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  /** Follow tag objects to the commit they ultimately name; null when the chain ends elsewhere. */
  peelToCommit(oid: string): string | null {
    let cursor = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const obj = this.objects.get(cursor);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return cursor;
      if (obj.type === 'tag') {
        cursor = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Every object reachable from the given tips (commits, their trees and blobs, tags). */
  reachable(tips: Iterable<string>): Set<string> {
    const visited = new Set<string>();
    const pending = [...tips];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      const obj = this.objects.get(current);
      if (obj === undefined) continue;
      visited.add(current);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        pending.push(info.tree, ...info.parents);
      } else if (obj.type === 'tree') {
        for (const row of parseTree(obj.data)) pending.push(row.oid);
      } else if (obj.type === 'tag') {
        pending.push(parseTag(obj.data).object);
      }
    }
    return visited;
  }

  /** Whether `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const visited = new Set<string>();
    const pending = [descendant];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === ancestor) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const obj = this.objects.get(current);
      if (obj !== undefined && obj.type === 'commit') pending.push(...parseCommit(obj.data).parents);
    }
    return false;
  }

  /** A best common ancestor of two commits (breadth-first from both sides), or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const depthFromA = new Map<string, number>();
    const frontierA: Array<[string, number]> = [[a, 0]];
    while (frontierA.length > 0) {
      const [current, dist] = frontierA.shift()!;
      if (depthFromA.has(current)) continue;
      depthFromA.set(current, dist);
      const obj = this.objects.get(current);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parentOid of parseCommit(obj.data).parents) frontierA.push([parentOid, dist + 1]);
      }
    }
    const visitedB = new Set<string>();
    const frontierB: Array<[string, number]> = [[b, 0]];
    let winner: string | null = null;
    let winnerScore = Number.POSITIVE_INFINITY;
    while (frontierB.length > 0) {
      const [current, dist] = frontierB.shift()!;
      if (visitedB.has(current)) continue;
      visitedB.add(current);
      const distA = depthFromA.get(current);
      if (distA !== undefined && distA + dist < winnerScore) {
        winner = current;
        winnerScore = distA + dist;
      }
      const obj = this.objects.get(current);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parentOid of parseCommit(obj.data).parents) frontierB.push([parentOid, dist + 1]);
      }
    }
    return winner;
  }

  /** The commits reachable from a tip, newest first (depth-first in parent order). */
  history(tip: string): string[] {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const descend = (current: string): void => {
      if (visited.has(current)) return;
      const obj = this.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') return;
      visited.add(current);
      ordered.push(current);
      for (const parentOid of parseCommit(obj.data).parents) descend(parentOid);
    };
    descend(tip);
    return ordered;
  }

  // -------------------------------------------------------------------------------------------
  // trees and files
  // -------------------------------------------------------------------------------------------

  /** Flatten a tree (recursively) into a path -> blob oid map. */
  treeFiles(treeOid: string): Map<string, { oid: string; mode: string }> {
    const flat = new Map<string, { oid: string; mode: string }>();
    const descend = (currentTree: string, pathPrefix: string): void => {
      const obj = this.objects.get(currentTree);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const row of parseTree(obj.data)) {
        const fullPath = pathPrefix === '' ? row.name : `${pathPrefix}/${row.name}`;
        if (row.mode === '40000' || row.mode === '040000') descend(row.oid, fullPath);
        else flat.set(fullPath, { oid: row.oid, mode: row.mode });
      }
    };
    descend(treeOid, '');
    return flat;
  }

  /** The flattened file map of a commit's tree. */
  commitFiles(commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = this.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return this.treeFiles(parseCommit(obj.data).tree);
  }

  /** Build (and store) a tree hierarchy holding exactly the given path -> blob map. */
  treeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface TreeNode {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, TreeNode>;
    }
    const newNode = (): TreeNode => ({ files: new Map(), dirs: new Map() });
    const rootNode = newNode();
    for (const [filePath, fileRec] of files) {
      const parts = filePath.split('/');
      let cursorNode = rootNode;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const segName = parts[index]!;
        if (!cursorNode.dirs.has(segName)) cursorNode.dirs.set(segName, newNode());
        cursorNode = cursorNode.dirs.get(segName)!;
      }
      cursorNode.files.set(parts[parts.length - 1]!, fileRec);
    }
    const emit = (node: TreeNode): string => {
      const rows: TreeEntry[] = [];
      for (const [name, fileRec] of node.files) rows.push({ mode: fileRec.mode, name, oid: fileRec.oid });
      for (const [name, childNode] of node.dirs) rows.push({ mode: '40000', name, oid: emit(childNode) });
      return this.putObject('tree', buildTree(rows));
    };
    return emit(rootNode);
  }

  /** Resolve a repo-relative path at a commit; '' names the root directory. */
  pathAt(commitOid: string, path: string): PathHit {
    const commitObj = this.objects.get(commitOid);
    if (commitObj === undefined || commitObj.type !== 'commit') return null;
    let currentTree = parseCommit(commitObj.data).tree;
    if (path === '') {
      const treeObj = this.objects.get(currentTree);
      return treeObj === undefined ? null : { kind: 'dir', entries: parseTree(treeObj.data) };
    }
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const treeObj = this.objects.get(currentTree);
      if (treeObj === undefined || treeObj.type !== 'tree') return null;
      const row = parseTree(treeObj.data).find((candidate) => candidate.name === parts[index]);
      if (row === undefined) return null;
      const isLast = index === parts.length - 1;
      if (!isLast) {
        if (row.mode !== '40000' && row.mode !== '040000') return null;
        currentTree = row.oid;
        continue;
      }
      if (row.mode === '40000' || row.mode === '040000') {
        const subTree = this.objects.get(row.oid);
        return subTree === undefined ? null : { kind: 'dir', entries: parseTree(subTree.data) };
      }
      const blobObj = this.objects.get(row.oid);
      return blobObj === undefined ? null : { kind: 'file', oid: row.oid, data: blobObj.data, mode: row.mode };
    }
    return null;
  }

  /** Create a commit object with the forge's deterministic identity line. */
  makeCommit(treeOid: string, parentOids: readonly string[], messageText: string, seq: number): string {
    const stamp = this.epochAt(seq);
    const identLine = `Forge <forge@example.invalid> ${stamp} +0000`;
    const headerLines = [`tree ${treeOid}`, ...parentOids.map((parentOid) => `parent ${parentOid}`), `author ${identLine}`, `committer ${identLine}`];
    return this.putObject('commit', Buffer.from(`${headerLines.join('\n')}\n\n${messageText}`, 'utf8'));
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): Repo {
    this.nextRepoId += 1;
    const created: Repo = {
      id: this.nextRepoId,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.seq(),
    };
    this.repos.set(name, created);
    return created;
  }

  /** The ref the repository's HEAD names. */
  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The commit a branch name (or full ref) points at, or null. */
  branchTip(repo: Repo, branchName: string): string | null {
    const fullRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`;
    return repo.refs.get(fullRef) ?? null;
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveCommit(repo: Repo, refish: string): string | null {
    const viaBranch = this.branchTip(repo, refish);
    if (viaBranch !== null) return this.peelToCommit(viaBranch);
    const obj = this.objects.get(refish);
    if (obj !== undefined && obj.type === 'commit') return refish;
    if (obj !== undefined && obj.type === 'tag') return this.peelToCommit(refish);
    return null;
  }

  /**
   * Write (or delete, with content null) a file on a branch, committing on
   * top of the branch tip. Creates the branch when the repository is still
   * unborn or when the branch is missing and the repository has a default
   * tip to start from. Answers a problem string, or the new commit oid.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): { ok: true; commit: string; blob: string | null } | { ok: false; status: number; problem: string } {
    const fullRef = `refs/heads/${branch}`;
    let tipOid = repo.refs.get(fullRef) ?? null;
    if (tipOid === null) {
      const fallbackTip = repo.refs.get(this.headRef(repo)) ?? null;
      if (fallbackTip !== null && fullRef !== this.headRef(repo)) tipOid = fallbackTip;
    }
    const baseOid = tipOid === null ? null : this.peelToCommit(tipOid);
    const flat = baseOid === null ? new Map<string, { oid: string; mode: string }>() : this.commitFiles(baseOid);
    const prior = flat.get(path);
    if (content === null) {
      if (prior === undefined) return { ok: false, status: 404, problem: 'Not Found' };
      if (expectedSha !== undefined && expectedSha !== prior.oid) {
        return { ok: false, status: 409, problem: 'Conflict: the file has changed since the given sha' };
      }
      flat.delete(path);
      const treeOid = this.treeFromFiles(flat);
      const commitOid = this.makeCommit(treeOid, baseOid === null ? [] : [baseOid], message, this.seq());
      repo.refs.set(fullRef, commitOid);
      return { ok: true, commit: commitOid, blob: null };
    }
    if (prior !== undefined && expectedSha !== undefined && expectedSha !== prior.oid) {
      return { ok: false, status: 409, problem: 'Conflict: the file has changed since the given sha' };
    }
    if (prior === undefined && expectedSha !== undefined) {
      return { ok: false, status: 422, problem: 'Invalid request: sha supplied for a file that does not exist' };
    }
    const blobOid = this.putObject('blob', content);
    flat.set(path, { oid: blobOid, mode: prior?.mode ?? '100644' });
    const treeOid = this.treeFromFiles(flat);
    const commitOid = this.makeCommit(treeOid, baseOid === null ? [] : [baseOid], message, this.seq());
    repo.refs.set(fullRef, commitOid);
    return { ok: true, commit: commitOid, blob: blobOid };
  }

  /** Whether a write created its file (used for the contents API's 201 vs 200). */
  fileExists(repo: Repo, branch: string, path: string): boolean {
    const tipOid = this.branchTip(repo, branch);
    if (tipOid === null) return false;
    const commitOid = this.peelToCommit(tipOid);
    if (commitOid === null) return false;
    return this.pathAt(commitOid, path)?.kind === 'file';
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  addIssue(repo: Repo, input: { title: string; body: string; labels: string[] }): IssueRec {
    const issueNumber = repo.nextNumber;
    repo.nextNumber += 1;
    this.nextIssueId += 1;
    const created: IssueRec = {
      number: issueNumber,
      id: this.nextIssueId,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      comments: [],
      seq: this.seq(),
    };
    repo.issues.set(issueNumber, created);
    return created;
  }

  addComment(target: { comments: CommentRec[] }, body: string): CommentRec {
    this.nextCommentId += 1;
    const created: CommentRec = { id: this.nextCommentId, body, seq: this.seq() };
    target.comments.push(created);
    return created;
  }

  createPull(
    repo: Repo,
    input: { title: string; body: string; head: string; base: string },
  ): { ok: true; pull: PullRec } | { ok: false; problem: string } {
    const headName = input.head.replace(/^refs\/heads\//, '');
    const baseName = input.base.replace(/^refs\/heads\//, '');
    const headOid = this.branchTip(repo, headName);
    const baseOid = this.branchTip(repo, baseName);
    if (headOid === null) return { ok: false, problem: `head branch ${headName} does not exist` };
    if (baseOid === null) return { ok: false, problem: `base branch ${baseName} does not exist` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headName && existing.baseRef === baseName) {
        return { ok: false, problem: `a pull request already exists for ${headName} into ${baseName}` };
      }
    }
    const pullNumber = repo.nextNumber;
    repo.nextNumber += 1;
    this.nextIssueId += 1;
    const created: PullRec = {
      number: pullNumber,
      id: this.nextIssueId,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      headRef: headName,
      baseRef: baseName,
      headSha: this.peelToCommit(headOid) ?? headOid,
      baseSha: this.peelToCommit(baseOid) ?? baseOid,
      mergeCommitSha: null,
      mergedSeq: 0,
      comments: [],
      seq: this.seq(),
    };
    repo.pulls.set(pullNumber, created);
    return { ok: true, pull: created };
  }

  /**
   * The live merge picture of a pull request: its merge base and whether
   * base and head changed the same file differently since (a conflict).
   * Null when a branch tip is gone.
   */
  pullView(repo: Repo, pull: PullRec): { commonBase: string; headCommit: string; baseCommit: string; conflict: boolean } | null {
    const rawHead = this.branchTip(repo, pull.headRef);
    const rawBase = this.branchTip(repo, pull.baseRef);
    if (rawHead === null || rawBase === null) return null;
    const headTipCommit = this.peelToCommit(rawHead);
    const baseTipCommit = this.peelToCommit(rawBase);
    if (headTipCommit === null || baseTipCommit === null) return null;
    const commonBase = this.mergeBase(headTipCommit, baseTipCommit);
    if (commonBase === null) return { commonBase: '', headCommit: headTipCommit, baseCommit: baseTipCommit, conflict: true };
    const filesAtBase = this.commitFiles(commonBase);
    const filesAtHead = this.commitFiles(headTipCommit);
    const filesAtBaseTip = this.commitFiles(baseTipCommit);
    let conflict = false;
    const allPaths = new Set([...filesAtBase.keys(), ...filesAtHead.keys(), ...filesAtBaseTip.keys()]);
    for (const filePath of allPaths) {
      const baseEntry = filesAtBase.get(filePath)?.oid;
      const headEntry = filesAtHead.get(filePath)?.oid;
      const tipEntry = filesAtBaseTip.get(filePath)?.oid;
      const headMoved = headEntry !== baseEntry;
      const baseMoved = tipEntry !== baseEntry;
      if (headMoved && baseMoved && headEntry !== tipEntry) conflict = true;
    }
    return { commonBase, headCommit: headTipCommit, baseCommit: baseTipCommit, conflict };
  }

  /** The changed-file list of a pull request, diffed merge-base -> head. */
  pullFiles(repo: Repo, pull: PullRec): Array<{ path: string; status: string; additions: number; deletions: number }> {
    const headRefOid = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseRefOid = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headOid = this.peelToCommit(headRefOid) ?? headRefOid;
    const baseOid = this.peelToCommit(baseRefOid) ?? baseRefOid;
    const commonBase = this.mergeBase(headOid, baseOid) ?? baseOid;
    return diffFiles(this, this.commitFiles(commonBase), this.commitFiles(headOid));
  }

  /**
   * Merge a pull request into its base branch: 'squash' lands one commit
   * with the head's changes, 'merge' a two-parent commit, 'rebase' replays
   * the head's own commits. A conflicted pull is refused with 405, as
   * GitHub answers.
   */
  mergePull(
    repo: Repo,
    pull: PullRec,
    method: 'merge' | 'squash' | 'rebase',
  ): { ok: true; sha: string } | { ok: false; status: number; problem: string } {
    if (pull.merged) return { ok: false, status: 405, problem: 'Pull Request was already merged' };
    if (pull.state === 'closed') return { ok: false, status: 405, problem: 'Pull Request is closed' };
    const picture = this.pullView(repo, pull);
    if (picture === null) return { ok: false, status: 405, problem: 'Pull Request is not mergeable' };
    if (picture.conflict) return { ok: false, status: 405, problem: 'Pull Request is not mergeable: conflicts must be resolved first' };
    const { commonBase, headCommit, baseCommit } = picture;
    const filesAtBase = this.commitFiles(commonBase);
    const filesAtHead = this.commitFiles(headCommit);
    const combinedFiles = new Map(this.commitFiles(baseCommit));
    for (const filePath of new Set([...filesAtBase.keys(), ...filesAtHead.keys()])) {
      const headEntry = filesAtHead.get(filePath);
      if (headEntry?.oid !== filesAtBase.get(filePath)?.oid) {
        if (headEntry === undefined) combinedFiles.delete(filePath);
        else combinedFiles.set(filePath, headEntry);
      }
    }
    const mergedTree = this.treeFromFiles(combinedFiles);
    let landedSha: string;
    if (method === 'merge') {
      landedSha = this.makeCommit(mergedTree, [baseCommit, headCommit], `Merge pull request #${pull.number}: ${pull.title}`, this.seq());
    } else if (method === 'rebase') {
      const replayChain: string[] = [];
      const visited = new Set<string>();
      const gather = (current: string): void => {
        if (current === commonBase || visited.has(current)) return;
        const obj = this.getObject(current);
        if (obj === undefined || obj.type !== 'commit') return;
        visited.add(current);
        replayChain.push(current);
        for (const parentOid of parseCommit(obj.data).parents) gather(parentOid);
      };
      gather(headCommit);
      replayChain.reverse();
      let cursorTip = baseCommit;
      landedSha = baseCommit;
      for (const oldOid of replayChain) {
        const oldInfo = parseCommit(this.getObject(oldOid)!.data);
        landedSha = this.makeCommit(oldInfo.tree, [cursorTip], oldInfo.message, this.seq());
        cursorTip = landedSha;
      }
      if (replayChain.length === 0) landedSha = this.makeCommit(mergedTree, [baseCommit], pull.title, this.seq());
    } else {
      landedSha = this.makeCommit(mergedTree, [baseCommit], pull.title, this.seq());
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, landedSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = landedSha;
    pull.mergedSeq = this.seq();
    return { ok: true, sha: landedSha };
  }
}

/** Count line additions/deletions between two file versions (multi-set line difference). */
function countLineDelta(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const tally = (data: Buffer | null): Map<string, number> => {
    const counts = new Map<string, number>();
    if (data === null) return counts;
    for (const lineText of data.toString('utf8').split('\n')) counts.set(lineText, (counts.get(lineText) ?? 0) + 1);
    return counts;
  };
  const beforeCounts = tally(oldData);
  const afterCounts = tally(newData);
  let added = 0;
  let removed = 0;
  for (const [lineText, times] of afterCounts) added += Math.max(0, times - (beforeCounts.get(lineText) ?? 0));
  for (const [lineText, times] of beforeCounts) removed += Math.max(0, times - (afterCounts.get(lineText) ?? 0));
  return { additions: added, deletions: removed };
}

/** Diff two flattened file maps into the pull-request file list. */
export function diffFiles(
  forge: Forge,
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const rows: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const filePath of allPaths) {
    const beforeEntry = before.get(filePath);
    const afterEntry = after.get(filePath);
    if (beforeEntry?.oid === afterEntry?.oid) continue;
    const beforeBytes = beforeEntry === undefined ? null : (forge.getObject(beforeEntry.oid)?.data ?? null);
    const afterBytes = afterEntry === undefined ? null : (forge.getObject(afterEntry.oid)?.data ?? null);
    const { additions, deletions } = countLineDelta(beforeBytes, afterBytes);
    rows.push({
      path: filePath,
      status: beforeEntry === undefined ? 'added' : afterEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
    });
  }
  return rows;
}
