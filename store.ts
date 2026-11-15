// The forge's in-memory core: the git object store (SHA-1 addressed blobs, trees, commits and tags),
// the repositories built on it, and the issue / pull-request domain the REST, GraphQL and MCP surfaces
// all share. One store serves every surface, so an object created through any of them is the same
// object through the others.
//
// Determinism is a scoring rule (a trial's final state export must replay byte for byte), so nothing
// here reads the wall clock or a random source: timestamps come from a monotonic sequence laid over a
// fixed base epoch, ids from counters, and request ids from a counter too.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const BASE_EPOCH_SEC = 1_700_000_000;

/** SHA-1 of a git object: `<type> <byte length>\0` followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: by name, with directory names compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries into a tree object's raw bytes (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
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
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object: its `object` header names the target. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Split an ident line ("Name <email> 1700000000 +0000") into its parts. */
export function parseIdent(line: string): { name: string; email: string; epochSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line.trim(), email: '', epochSec: BASE_EPOCH_SEC };
  return { name: match[1] ?? '', email: match[2] ?? '', epochSec: Number(match[3] ?? BASE_EPOCH_SEC) };
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
  private seqCounter = 0;
  private repoIdCounter = 0;
  private issueIdCounter = 0;
  private commentIdCounter = 0;
  private requestCounter = 0;

  /** The next deterministic sequence number (timestamps, ordering). */
  seq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** A deterministic ISO timestamp for a sequence number. */
  isoAt(seq: number): string {
    return new Date((BASE_EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** An epoch-second timestamp for a sequence number (commit objects). */
  epochAt(seq: number): number {
    return BASE_EPOCH_SEC + seq;
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `FORGE-${this.requestCounter.toString(36).toUpperCase()}`;
  }

  /**
   * Learn the token owner's login from a request that names an owner. The first owner that arrives
   * with a repository that exists (or before any repository exists, the owner a creation flow names)
   * becomes the login; after that the login is fixed for the life of the process.
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
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Every object reachable from the given tips (commits, their trees and blobs, tags). */
  reachable(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** Whether `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
    return false;
  }

  /** A best common ancestor of two commits (breadth-first from both sides), or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, depth] = queueA.shift()!;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.set(oid, depth);
      const object = this.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
      }
    }
    const seenB = new Set<string>();
    const queueB: Array<[string, number]> = [[b, 0]];
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    while (queueB.length > 0) {
      const [oid, depth] = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const depthA = ancestorsOfA.get(oid);
      if (depthA !== undefined && depthA + depth < bestScore) {
        best = oid;
        bestScore = depthA + depth;
      }
      const object = this.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
      }
    }
    return best;
  }

  /** The commits reachable from a tip, newest first (depth-first in parent order). */
  history(tip: string): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(oid);
      ordered.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    return ordered;
  }

  // -------------------------------------------------------------------------------------------
  // trees and files
  // -------------------------------------------------------------------------------------------

  /** Flatten a tree (recursively) into a path -> blob oid map. */
  treeFiles(treeOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** The flattened file map of a commit's tree. */
  commitFiles(commitOid: string): Map<string, { oid: string; mode: string }> {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    return this.treeFiles(parseCommit(object.data).tree);
  }

  /** Build (and store) a tree hierarchy holding exactly the given path -> blob map. */
  treeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Resolve a repo-relative path at a commit; '' names the root directory. */
  pathAt(commitOid: string, path: string): PathHit {
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      const tree = this.objects.get(treeOid);
      return tree === undefined ? null : { kind: 'dir', entries: parseTree(tree.data) };
    }
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const tree = this.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      const isLast = index === segments.length - 1;
      if (!isLast) {
        if (entry.mode !== '40000' && entry.mode !== '040000') return null;
        treeOid = entry.oid;
        continue;
      }
      if (entry.mode === '40000' || entry.mode === '040000') {
        const dirTree = this.objects.get(entry.oid);
        return dirTree === undefined ? null : { kind: 'dir', entries: parseTree(dirTree.data) };
      }
      const blob = this.objects.get(entry.oid);
      return blob === undefined ? null : { kind: 'file', oid: entry.oid, data: blob.data, mode: entry.mode };
    }
    return null;
  }

  /** Create a commit object with the forge's deterministic identity line. */
  makeCommit(tree: string, parents: readonly string[], message: string, seq: number): string {
    const stamp = this.epochAt(seq);
    const ident = `Forge <forge@example.invalid> ${stamp} +0000`;
    const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${ident}`, `committer ${ident}`];
    return this.putObject('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): Repo {
    this.repoIdCounter += 1;
    const repo: Repo = {
      id: this.repoIdCounter,
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
    this.repos.set(name, repo);
    return repo;
  }

  /** The ref the repository's HEAD names. */
  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The commit a branch name (or full ref) points at, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveCommit(repo: Repo, refish: string): string | null {
    const byBranch = this.branchTip(repo, refish);
    if (byBranch !== null) return this.peelToCommit(byBranch);
    const object = this.objects.get(refish);
    if (object !== undefined && object.type === 'commit') return refish;
    if (object !== undefined && object.type === 'tag') return this.peelToCommit(refish);
    return null;
  }

  /**
   * Write (or delete, with content null) a file on a branch, committing on top of the branch tip.
   * Creates the branch when the repository is still unborn or when the branch is missing and the
   * repository has a default tip to start from. Answers a problem string, or the new commit oid.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): { ok: true; commit: string; blob: string | null } | { ok: false; status: number; problem: string } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null) {
      const defaultTip = repo.refs.get(this.headRef(repo)) ?? null;
      if (defaultTip !== null && ref !== this.headRef(repo)) tip = defaultTip;
    }
    const baseCommit = tip === null ? null : this.peelToCommit(tip);
    const files = baseCommit === null ? new Map<string, { oid: string; mode: string }>() : this.commitFiles(baseCommit);
    const existing = files.get(path);
    if (content === null) {
      if (existing === undefined) return { ok: false, status: 404, problem: 'Not Found' };
      if (expectedSha !== undefined && expectedSha !== existing.oid) {
        return { ok: false, status: 409, problem: 'Conflict: the file has changed since the given sha' };
      }
      files.delete(path);
      const tree = this.treeFromFiles(files);
      const commit = this.makeCommit(tree, baseCommit === null ? [] : [baseCommit], message, this.seq());
      repo.refs.set(ref, commit);
      return { ok: true, commit, blob: null };
    }
    if (existing !== undefined && expectedSha !== undefined && expectedSha !== existing.oid) {
      return { ok: false, status: 409, problem: 'Conflict: the file has changed since the given sha' };
    }
    if (existing === undefined && expectedSha !== undefined) {
      return { ok: false, status: 422, problem: 'Invalid request: sha supplied for a file that does not exist' };
    }
    const blob = this.putObject('blob', content);
    files.set(path, { oid: blob, mode: existing?.mode ?? '100644' });
    const tree = this.treeFromFiles(files);
    const commit = this.makeCommit(tree, baseCommit === null ? [] : [baseCommit], message, this.seq());
    repo.refs.set(ref, commit);
    return { ok: true, commit, blob };
  }

  /** Whether a write created its file (used for the contents API's 201 vs 200). */
  fileExists(repo: Repo, branch: string, path: string): boolean {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return false;
    const commit = this.peelToCommit(tip);
    if (commit === null) return false;
    return this.pathAt(commit, path)?.kind === 'file';
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  addIssue(repo: Repo, input: { title: string; body: string; labels: string[] }): IssueRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    this.issueIdCounter += 1;
    const issue: IssueRec = {
      number,
      id: this.issueIdCounter,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      comments: [],
      seq: this.seq(),
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(subject: { comments: CommentRec[] }, body: string): CommentRec {
    this.commentIdCounter += 1;
    const comment: CommentRec = { id: this.commentIdCounter, body, seq: this.seq() };
    subject.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    input: { title: string; body: string; head: string; base: string },
  ): { ok: true; pull: PullRec } | { ok: false; problem: string } {
    const head = input.head.replace(/^refs\/heads\//, '');
    const base = input.base.replace(/^refs\/heads\//, '');
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === null) return { ok: false, problem: `head branch ${head} does not exist` };
    if (baseTip === null) return { ok: false, problem: `base branch ${base} does not exist` };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        return { ok: false, problem: `a pull request already exists for ${head} into ${base}` };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    this.issueIdCounter += 1;
    const pull: PullRec = {
      number,
      id: this.issueIdCounter,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha: this.peelToCommit(headTip) ?? headTip,
      baseSha: this.peelToCommit(baseTip) ?? baseTip,
      mergeCommitSha: null,
      mergedSeq: 0,
      comments: [],
      seq: this.seq(),
    };
    repo.pulls.set(number, pull);
    return { ok: true, pull };
  }

  /**
   * The live merge picture of a pull request: its merge base and whether base and head changed the
   * same file differently since (a conflict). Null when a branch tip is gone.
   */
  pullView(repo: Repo, pull: PullRec): { base: string; headTip: string; baseTip: string; conflict: boolean } | null {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return null;
    const headCommit = this.peelToCommit(headTip);
    const baseCommit = this.peelToCommit(baseTip);
    if (headCommit === null || baseCommit === null) return null;
    const base = this.mergeBase(headCommit, baseCommit);
    if (base === null) return { base: '', headTip: headCommit, baseTip: baseCommit, conflict: true };
    const atBase = this.commitFiles(base);
    const atHead = this.commitFiles(headCommit);
    const atBaseTip = this.commitFiles(baseCommit);
    let conflict = false;
    const paths = new Set([...atBase.keys(), ...atHead.keys(), ...atBaseTip.keys()]);
    for (const path of paths) {
      const inBase = atBase.get(path)?.oid;
      const inHead = atHead.get(path)?.oid;
      const inTip = atBaseTip.get(path)?.oid;
      const headChanged = inHead !== inBase;
      const baseChanged = inTip !== inBase;
      if (headChanged && baseChanged && inHead !== inTip) conflict = true;
    }
    return { base, headTip: headCommit, baseTip: baseCommit, conflict };
  }

  /** The changed-file list of a pull request, diffed merge-base -> head. */
  pullFiles(repo: Repo, pull: PullRec): Array<{ path: string; status: string; additions: number; deletions: number }> {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headCommit = this.peelToCommit(headTip) ?? headTip;
    const baseCommit = this.peelToCommit(baseTip) ?? baseTip;
    const mergeBase = this.mergeBase(headCommit, baseCommit) ?? baseCommit;
    return diffFiles(this, this.commitFiles(mergeBase), this.commitFiles(headCommit));
  }

  /**
   * Merge a pull request into its base branch: 'squash' lands one commit with the head's changes,
   * 'merge' a two-parent commit, 'rebase' replays the head's own commits. A conflicted pull is
   * refused with 405, as GitHub answers.
   */
  mergePull(
    repo: Repo,
    pull: PullRec,
    method: 'merge' | 'squash' | 'rebase',
  ): { ok: true; sha: string } | { ok: false; status: number; problem: string } {
    if (pull.merged) return { ok: false, status: 405, problem: 'Pull Request was already merged' };
    if (pull.state === 'closed') return { ok: false, status: 405, problem: 'Pull Request is closed' };
    const view = this.pullView(repo, pull);
    if (view === null) return { ok: false, status: 405, problem: 'Pull Request is not mergeable' };
    if (view.conflict) return { ok: false, status: 405, problem: 'Pull Request is not mergeable: conflicts must be resolved first' };
    const { base, headTip, baseTip } = view;
    const atBase = this.commitFiles(base);
    const atHead = this.commitFiles(headTip);
    const mergedFiles = new Map(this.commitFiles(baseTip));
    for (const path of new Set([...atBase.keys(), ...atHead.keys()])) {
      const inHead = atHead.get(path);
      if (inHead?.oid !== atBase.get(path)?.oid) {
        if (inHead === undefined) mergedFiles.delete(path);
        else mergedFiles.set(path, inHead);
      }
    }
    const tree = this.treeFromFiles(mergedFiles);
    let sha: string;
    if (method === 'merge') {
      sha = this.makeCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number}: ${pull.title}`, this.seq());
    } else if (method === 'rebase') {
      const chain: string[] = [];
      const seen = new Set<string>();
      const collect = (oid: string): void => {
        if (oid === base || seen.has(oid)) return;
        const object = this.getObject(oid);
        if (object === undefined || object.type !== 'commit') return;
        seen.add(oid);
        chain.push(oid);
        for (const parent of parseCommit(object.data).parents) collect(parent);
      };
      collect(headTip);
      chain.reverse();
      let tip = baseTip;
      sha = baseTip;
      for (const old of chain) {
        const info = parseCommit(this.getObject(old)!.data);
        sha = this.makeCommit(info.tree, [tip], info.message, this.seq());
        tip = sha;
      }
      if (chain.length === 0) sha = this.makeCommit(tree, [baseTip], pull.title, this.seq());
    } else {
      sha = this.makeCommit(tree, [baseTip], pull.title, this.seq());
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedSeq = this.seq();
    return { ok: true, sha };
  }
}

/** Count line additions/deletions between two file versions (multi-set line difference). */
function lineDelta(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const count = (data: Buffer | null): Map<string, number> => {
    const counts = new Map<string, number>();
    if (data === null) return counts;
    for (const line of data.toString('utf8').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = count(oldData);
  const newCounts = count(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
  for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

/** Diff two flattened file maps into the pull-request file list. */
export function diffFiles(
  forge: Forge,
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    const oldData = oldEntry === undefined ? null : (forge.getObject(oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (forge.getObject(newEntry.oid)?.data ?? null);
    const { additions, deletions } = lineDelta(oldData, newData);
    files.push({
      path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
    });
  }
  return files;
}
