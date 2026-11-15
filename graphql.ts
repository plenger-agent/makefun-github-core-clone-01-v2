// GraphQL v4 at POST /api/graphql: the documents gh and github-mcp-server actually send — viewer,
// repository reads, issue/pull-request connections with cursor pagination, the create/close/merge
// mutations, Relay node(id:), batching, and the __type introspection probes. Implemented as a small
// parser plus a resolver executor over the shared Forge store; no schema library, no dependencies.
//
// Global ids are opaque base64 ("R:<repoId>", "I:<repoId>:<number>", ...) — stable across reads and
// never the plain database id, which the suite's global-id check requires.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { isAuthenticated, readBody, sendError, sendJson } from './web.ts';

// ---------------------------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------------------------

function encodeId(...parts: Array<string | number>): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function decodeId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// lexer and parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: input.slice(i + 3, end === -1 ? input.length : end) });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) {
        text += input[j];
        j += 1;
      }
      const value = Number(text);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      let value = '';
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) {
        value += input[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Map<string, Value>;
  selectionSet?: SelectionItem[];
}

type SelectionItem = { kind: 'field'; field: FieldNode } | { kind: 'inline'; typeCondition: string; selectionSet: SelectionItem[] } | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionItem[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionItem[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionItem[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword, name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionItem[] {
    this.expectPunct('{');
    const items: SelectionItem[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          items.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          items.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : new Map<string, Value>();
      this.skipDirectives();
      const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
      items.push({ kind: 'field', field: { alias, name, args, selectionSet } });
    }
    return items;
  }
}

/** Evaluate an argument value against the operation's variables. */
function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) object[key] = valueOf(entry, variables);
      return object;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of field.args) args[key] = valueOf(value, variables);
  return args;
}

// ---------------------------------------------------------------------------------------------
// schema: type field lists for the introspection probes
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Organization: ['login', 'id', 'name'],
  Ref: ['name', 'target', 'repository'],
  Commit: ['oid', 'message', 'author'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'viewerPermission',
    'hasIssuesEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url', 'labels', 'refs', 'ref', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'repository',
    'createdAt', 'updatedAt', 'url', 'closed', 'closedAt',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'commits', 'comments', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
    'createdAt', 'updatedAt', 'url', 'closed', 'mergedAt',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestChangedFileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionItem[] }>;
  errors: Array<{ message: string }>;
}

type Source = Record<string, unknown> & { __typename: string };

function userSource(forge: Forge): Source {
  return { __typename: 'User', login: forge.login ?? '' };
}

function repoSource(forge: Forge, repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: IssueRec): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: PullRec): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function executeSelection(ctx: Ctx, typeName: string, source: Source | null, selection: SelectionItem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'inline') {
      if (source !== null && source.__typename === item.typeCondition) {
        Object.assign(out, executeSelection(ctx, item.typeCondition, source, item.selectionSet));
      }
      continue;
    }
    if (item.kind === 'spread') {
      const fragment = ctx.fragments.get(item.name);
      if (fragment !== undefined && source !== null && source.__typename === fragment.typeCondition) {
        Object.assign(out, executeSelection(ctx, fragment.typeCondition, source, fragment.selectionSet));
      }
      continue;
    }
    const field = item.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const value = resolveField(ctx, typeName, source, field);
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

/** Apply a field's selection set to its resolved value (objects, lists, nulls). */
function completeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (typeof value === 'object' && typeof (value as Source).__typename === 'string') {
    const source = value as Source;
    return executeSelection(ctx, source.__typename, source, field.selectionSet);
  }
  return value;
}

function resolveField(ctx: Ctx, typeName: string, source: Source | null, field: FieldNode): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx.variables);
  const known = TYPE_FIELDS[typeName];
  if (known !== undefined && !known.includes(field.name) && field.name !== '__type' && field.name !== '__schema') {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  switch (typeName) {
    case 'Query':
      return resolveQuery(ctx, field.name, args);
    case 'Mutation':
      return resolveMutation(ctx, field.name, args);
    case 'User':
      if (field.name === 'login') return (source as Source).login ?? forge.login ?? '';
      if (field.name === 'id') return encodeId('U', 1);
      if (field.name === 'name') return forge.login ?? '';
      return null;
    case 'Repository':
      return resolveRepository(ctx, source!, field.name, args);
    case 'Issue': {
      const issue = (source as Source).issue as IssueRec;
      const repo = (source as Source).repo as Repo;
      switch (field.name) {
        case 'id': return encodeId('I', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return userSource(forge);
        case 'repository': return repoSource(forge, repo);
        case 'createdAt': return forge.isoAt(issue.seq);
        case 'updatedAt': return forge.isoAt(issue.seq);
        case 'closed': return issue.state === 'closed';
        case 'labels': return { __typename: 'LabelConnection', nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })) };
        case 'comments': return { __typename: 'CommentConnection', nodes: issue.comments.map((comment) => commentSource(forge, repo, issue.number, comment)) };
        default: return null;
      }
    }
    case 'PullRequest': {
      const pull = (source as Source).pull as PullRec;
      const repo = (source as Source).repo as Repo;
      switch (field.name) {
        case 'id': return encodeId('P', repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pullMergeable(forge, repo, pull);
        case 'author': return userSource(forge);
        case 'createdAt': return forge.isoAt(pull.seq);
        case 'updatedAt': return forge.isoAt(pull.seq);
        case 'closed': return pull.state === 'closed';
        case 'mergedAt': return pull.merged ? forge.isoAt(pull.mergedSeq) : null;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
        case 'files': {
          const files = forge.pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : files.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path, additions: file.additions, deletions: file.deletions })),
            totalCount: files.length,
          };
        }
        case 'additions': return forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return forge.pullFiles(repo, pull).length;
        case 'comments': return { __typename: 'CommentConnection', nodes: pull.comments.map((comment) => commentSource(forge, repo, pull.number, comment)) };
        default: return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return (source as Source).name ?? null;
      if (field.name === 'target') return { __typename: 'Commit', oid: (source as Source).oid ?? '' };
      return null;
    }
    case 'Commit':
      if (field.name === 'oid') return (source as Source).oid ?? null;
      return null;
    case 'PageInfo':
      return (source as unknown as Record<string, unknown>)[field.name] ?? null;
    case '__Type': {
      const typeDef = (source as Source).typeDef as { name: string; kind: string };
      switch (field.name) {
        case 'name': return typeDef.name;
        case 'kind': return typeDef.kind;
        case 'fields': return (TYPE_FIELDS[typeDef.name] ?? []).map((name) => ({ __typename: '__Field', name }));
        case 'enumValues': return (ENUM_VALUES[typeDef.name] ?? []).map((name) => ({ __typename: '__EnumValue', name }));
        default: return null;
      }
    }
    case '__Field':
    case '__EnumValue':
      if (field.name === 'name') return (source as Source).name ?? null;
      return null;
    default:
      break;
  }
  // Connection-shaped sources: nodes / edges / pageInfo / totalCount read straight off the source.
  if (source !== null && field.name in source) return source[field.name];
  if (TYPE_FIELDS[typeName] === undefined) return null;
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

function commentSource(forge: Forge, repo: Repo, subjectNumber: number, comment: { id: number; body: string; seq: number }): Source {
  return {
    __typename: 'IssueComment',
    id: encodeId('C', repo.id, subjectNumber, comment.id),
    body: comment.body,
    createdAt: forge.isoAt(comment.seq),
    updatedAt: forge.isoAt(comment.seq),
  } as unknown as Source;
}

function pullMergeable(forge: Forge, repo: Repo, pull: PullRec): string {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const view = forge.pullView(repo, pull);
  if (view === null) return 'UNKNOWN';
  return view.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveQuery(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  switch (name) {
    case 'viewer':
      return userSource(forge);
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = forge.repos.get(repoName);
      if (repo === undefined || !forge.ownerMatches(owner)) return null;
      forge.adoptLogin(owner);
      return repoSource(forge, repo);
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      return nodeById(ctx, id);
    }
    case '__type': {
      const typeName = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[typeName] !== undefined) return { __typename: '__Type', typeDef: { name: typeName, kind: 'OBJECT' } };
      if (ENUM_VALUES[typeName] !== undefined) return { __typename: '__Type', typeDef: { name: typeName, kind: 'ENUM' } };
      return null;
    }
    default:
      return null;
  }
}

function nodeById(ctx: Ctx, id: string): Source | null {
  const { forge } = ctx;
  const parts = decodeId(id);
  if (parts === null) return null;
  const [kind, first, second] = parts;
  if (kind === 'R') {
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(first));
    return repo === undefined ? null : repoSource(forge, repo);
  }
  if (kind === 'I' || kind === 'P') {
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(first));
    if (repo === undefined) return null;
    if (kind === 'I') {
      const issue = repo.issues.get(Number(second));
      return issue === undefined ? null : issueSource(repo, issue);
    }
    const pull = repo.pulls.get(Number(second));
    return pull === undefined ? null : pullSource(repo, pull);
  }
  if (kind === 'U') return userSource(forge);
  return null;
}

function resolveRepository(ctx: Ctx, source: Source, name: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  const repo = source.repo as Repo;
  switch (name) {
    case 'id': return encodeId('R', repo.id);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${forge.login ?? ''}/${repo.name}`;
    case 'owner': return userSource(forge);
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'createdAt': return forge.isoAt(repo.seq);
    case 'updatedAt': return forge.isoAt(repo.seq);
    case 'defaultBranchRef': {
      const tip = forge.branchTip(repo, repo.defaultBranch);
      return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, oid: tip };
    }
    case 'issue': {
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueSource(repo, issue);
    }
    case 'issues': return issuesConnection(ctx, repo, args);
    case 'pullRequest': {
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullSource(repo, pull);
    }
    case 'pullRequests': {
      const all = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : all.length;
      const page = all.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullSource(repo, pull)),
        totalCount: all.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first < all.length, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    default:
      return null;
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Source {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state).toLowerCase()) : null;
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state));
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy === null ? 'ASC' : 'DESC';
  const field = orderBy?.field ?? 'CREATED_AT';
  const key = (issue: IssueRec): number => (field === 'COMMENTS' ? issue.comments.length * 100000 + issue.seq : issue.seq);
  issues.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return direction === 'DESC' ? -diff : diff;
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberFromCursor(args.after);
    const index = afterNumber === null ? -1 : issues.findIndex((issue) => issue.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : typeof args.after === 'string' ? args.after : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueSource(repo, issue)),
    totalCount: issues.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor,
    },
  } as unknown as Source;
}

function resolveMutation(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repoByGlobalId = (globalId: unknown): Repo | null => {
    const parts = typeof globalId === 'string' ? decodeId(globalId) : null;
    if (parts === null || parts[0] !== 'R') return null;
    return [...forge.repos.values()].find((candidate) => candidate.id === Number(parts[1])) ?? null;
  };
  switch (name) {
    case 'createIssue': {
      const repo = repoByGlobalId(input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const issue = forge.addIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
    }
    case 'closeIssue': {
      const parts = typeof input.issueId === 'string' ? decodeId(input.issueId) : null;
      const repo = parts !== null && parts[0] === 'I' ? [...forge.repos.values()].find((candidate) => candidate.id === Number(parts[1])) : undefined;
      const issue = repo?.issues.get(Number(parts?.[2]));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'issue not found for closeIssue' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue) };
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const created = forge.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
      });
      if (!created.ok) {
        ctx.errors.push({ message: created.problem });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, created.pull) };
    }
    case 'mergePullRequest': {
      const parts = typeof input.pullRequestId === 'string' ? decodeId(input.pullRequestId) : null;
      const repo = parts !== null && parts[0] === 'P' ? [...forge.repos.values()].find((candidate) => candidate.id === Number(parts[1])) : undefined;
      const pull = repo?.pulls.get(Number(parts?.[2]));
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const methodMap: Record<string, 'merge' | 'squash' | 'rebase'> = { MERGE: 'merge', SQUASH: 'squash', REBASE: 'rebase' };
      const method = methodMap[typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH'] ?? 'squash';
      const result = forge.mergePull(repo, pull, method);
      if (!result.ok) {
        ctx.errors.push({ message: result.problem });
        return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull) };
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull) };
    }
    case 'addComment': {
      const parts = typeof input.subjectId === 'string' ? decodeId(input.subjectId) : null;
      const body = typeof input.body === 'string' ? input.body : '';
      if (parts !== null && (parts[0] === 'I' || parts[0] === 'P')) {
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(parts[1]));
        const subject = parts[0] === 'I' ? repo?.issues.get(Number(parts[2])) : repo?.pulls.get(Number(parts[2]));
        if (repo !== undefined && subject !== undefined) {
          const comment = forge.addComment(subject, body);
          const node: Source = {
            __typename: 'IssueComment',
            id: encodeId('C', repo.id, subject.number, comment.id),
            body: comment.body,
            createdAt: forge.isoAt(comment.seq),
          } as unknown as Source;
          return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: cursorFor(subject.number) } };
        }
      }
      ctx.errors.push({ message: 'subject not found for addComment' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

interface OperationResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOne(forge: Forge, body: Record<string, unknown>): OperationResult {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation = document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]!;
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __typename: rootType }, operation.selectionSet);
  const result: OperationResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Serve POST /api/graphql (single operations and JSON-array batches). */
export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(forge, (entry ?? {}) as Record<string, unknown>));
    return sendJson(res, 200, results);
  }
  if (body !== null && typeof body === 'object') {
    return sendJson(res, 200, executeOne(forge, body as Record<string, unknown>));
  }
  return sendJson(res, 400, { errors: [{ message: 'Expected a GraphQL operation object' }] });
}
