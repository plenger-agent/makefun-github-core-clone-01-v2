// GraphQL v4 at POST /api/graphql: the documents gh and github-mcp-server
// actually send — viewer, repository reads, issue/pull-request connections
// with cursor pagination, the create/close/merge mutations, Relay
// node(id:), batching, and the __type introspection probes. Implemented as
// a small parser plus a resolver executor over the shared Forge store; no
// schema library, no dependencies.
//
// Global ids are opaque base64 ("R:<repoId>", "I:<repoId>:<number>", ...) —
// stable across reads and never the plain database id, which the suite's
// global-id check requires.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { isAuthenticated, readBody, sendError, sendJson } from './web.ts';

// ---------------------------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------------------------

function encodeGlobalId(...parts: Array<string | number>): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function decodeGlobalId(id: string): string[] | null {
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
  const tokenList: Token[] = [];
  let pos = 0;
  while (pos < input.length) {
    const c = input[pos]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') {
      pos += 1;
      continue;
    }
    if (c === '#') {
      while (pos < input.length && input[pos] !== '\n') pos += 1;
      continue;
    }
    if (c === '.' && input.slice(pos, pos + 3) === '...') {
      tokenList.push({ kind: 'spread' });
      pos += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokenList.push({ kind: 'punct', value: c });
      pos += 1;
      continue;
    }
    if (c === '"') {
      if (input.slice(pos, pos + 3) === '"""') {
        const blockEnd = input.indexOf('"""', pos + 3);
        tokenList.push({ kind: 'string', value: input.slice(pos + 3, blockEnd === -1 ? input.length : blockEnd) });
        pos = blockEnd === -1 ? input.length : blockEnd + 3;
        continue;
      }
      let scan = pos + 1;
      let text = '';
      while (scan < input.length && input[scan] !== '"') {
        if (input[scan] === '\\' && scan + 1 < input.length) {
          const esc = input[scan + 1]!;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          scan += 2;
        } else {
          text += input[scan];
          scan += 1;
        }
      }
      tokenList.push({ kind: 'string', value: text });
      pos = scan + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let scan = pos;
      let numText = '';
      while (scan < input.length && /[0-9.eE+-]/.test(input[scan]!)) {
        numText += input[scan];
        scan += 1;
      }
      const numeric = Number(numText);
      tokenList.push(numText.includes('.') || numText.includes('e') || numText.includes('E') ? { kind: 'float', value: numeric } : { kind: 'int', value: numeric });
      pos = scan;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let scan = pos;
      let text = '';
      while (scan < input.length && /[_0-9A-Za-z]/.test(input[scan]!)) {
        text += input[scan];
        scan += 1;
      }
      tokenList.push({ kind: 'name', value: text });
      pos = scan;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokenList.push({ kind: 'eof' });
  return tokenList;
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
  private tokenList: Token[];
  private index = 0;

  constructor(input: string) {
    this.tokenList = lex(input);
  }

  private peekToken(): Token {
    return this.tokenList[this.index]!;
  }

  private nextToken(): Token {
    const token = this.tokenList[this.index]!;
    this.index += 1;
    return token;
  }

  private demandPunct(value: string): void {
    const token = this.nextToken();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private eatPunct(value: string): boolean {
    const token = this.peekToken();
    if (token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private demandName(): string {
    const token = this.nextToken();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const ops: Operation[] = [];
    const frags = new Map<string, { typeCondition: string; selectionSet: SelectionItem[] }>();
    while (this.peekToken().kind !== 'eof') {
      const head = this.peekToken();
      if (head.kind === 'punct' && head.value === '{') {
        ops.push({ type: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      const word = this.demandName();
      if (word === 'query' || word === 'mutation') {
        let opName: string | undefined;
        if (this.peekToken().kind === 'name') opName = this.demandName();
        if (this.peekToken().kind === 'punct' && this.peekToken().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        ops.push({ type: word, name: opName, selectionSet: this.parseSelectionSet() });
      } else if (word === 'fragment') {
        const fragmentName = this.demandName();
        const onKeyword = this.demandName();
        if (onKeyword !== 'on') throw new Error('expected "on" in fragment');
        const onType = this.demandName();
        this.skipDirectives();
        frags.set(fragmentName, { typeCondition: onType, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${word}`);
      }
    }
    return { operations: ops, fragments: frags };
  }

  private parseVariableDefinitions(): void {
    this.demandPunct('(');
    while (!this.eatPunct(')')) {
      this.demandPunct('$');
      this.demandName();
      this.demandPunct(':');
      this.parseType();
      if (this.eatPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.demandPunct(']');
    } else {
      this.demandName();
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.peekToken().kind === 'punct' && this.peekToken().value === '@') {
      this.nextToken();
      this.demandName();
      if (this.peekToken().kind === 'punct' && this.peekToken().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const argMap = new Map<string, Value>();
    this.demandPunct('(');
    while (!this.eatPunct(')')) {
      const argName = this.demandName();
      this.demandPunct(':');
      argMap.set(argName, this.parseValue());
    }
    return argMap;
  }

  private parseValue(): Value {
    const token = this.nextToken();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.demandName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const entries: Value[] = [];
      while (!this.eatPunct(']')) entries.push(this.parseValue());
      return { kind: 'list', items: entries };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fieldMap = new Map<string, Value>();
      while (!this.eatPunct('}')) {
        const propName = this.demandName();
        this.demandPunct(':');
        fieldMap.set(propName, this.parseValue());
      }
      return { kind: 'object', fields: fieldMap };
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
    this.demandPunct('{');
    const entries: SelectionItem[] = [];
    while (!this.eatPunct('}')) {
      if (this.peekToken().kind === 'spread') {
        this.nextToken();
        if (this.peekToken().kind === 'name' && (this.peekToken() as { value: string }).value === 'on') {
          this.nextToken();
          const onType = this.demandName();
          this.skipDirectives();
          entries.push({ kind: 'inline', typeCondition: onType, selectionSet: this.parseSelectionSet() });
        } else {
          entries.push({ kind: 'spread', name: this.demandName() });
        }
        continue;
      }
      let fieldName = this.demandName();
      let aliasName: string | undefined;
      if (this.eatPunct(':')) {
        aliasName = fieldName;
        fieldName = this.demandName();
      }
      const argMap = this.peekToken().kind === 'punct' && this.peekToken().value === '(' ? this.parseArguments() : new Map<string, Value>();
      this.skipDirectives();
      const subSelection = this.peekToken().kind === 'punct' && this.peekToken().value === '{' ? this.parseSelectionSet() : undefined;
      entries.push({ kind: 'field', field: { alias: aliasName, name: fieldName, args: argMap, selectionSet: subSelection } });
    }
    return entries;
  }
}

/** Evaluate an argument value against the operation's variables. */
function valueOf(node: Value, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return vars[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((entry) => valueOf(entry, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [propName, propValue] of node.fields) out[propName] = valueOf(propValue, vars);
      return out;
    }
  }
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [argName, argValue] of field.args) out[argName] = valueOf(argValue, vars);
  return out;
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

function userNode(forge: Forge): Source {
  return { __typename: 'User', login: forge.login ?? '' };
}

function repoNode(forge: Forge, repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: IssueRec): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRec): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberInCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const found = /^cursor:(\d+)$/.exec(text);
    return found === null ? null : Number(found[1]);
  } catch {
    return null;
  }
}

function executeSelection(ctx: Ctx, typeName: string, source: Source | null, selection: SelectionItem[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of selection) {
    if (entry.kind === 'inline') {
      if (source !== null && source.__typename === entry.typeCondition) {
        Object.assign(result, executeSelection(ctx, entry.typeCondition, source, entry.selectionSet));
      }
      continue;
    }
    if (entry.kind === 'spread') {
      const frag = ctx.fragments.get(entry.name);
      if (frag !== undefined && source !== null && source.__typename === frag.typeCondition) {
        Object.assign(result, executeSelection(ctx, frag.typeCondition, source, frag.selectionSet));
      }
      continue;
    }
    const fieldNode = entry.field;
    const resultKey = fieldNode.alias ?? fieldNode.name;
    if (fieldNode.name === '__typename') {
      result[resultKey] = typeName;
      continue;
    }
    const resolved = resolveField(ctx, typeName, source, fieldNode);
    result[resultKey] = completeValue(ctx, resolved, fieldNode);
  }
  return result;
}

/** Apply a field's selection set to its resolved value (objects, lists, nulls). */
function completeValue(ctx: Ctx, resolved: unknown, field: FieldNode): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (field.selectionSet === undefined) return resolved;
  if (Array.isArray(resolved)) return resolved.map((element) => completeValue(ctx, element, field));
  if (typeof resolved === 'object' && typeof (resolved as Source).__typename === 'string') {
    const src = resolved as Source;
    return executeSelection(ctx, src.__typename, src, field.selectionSet);
  }
  return resolved;
}

function resolveField(ctx: Ctx, typeName: string, source: Source | null, field: FieldNode): unknown {
  const { forge } = ctx;
  const fieldArgs = argsOf(field, ctx.variables);
  const knownFields = TYPE_FIELDS[typeName];
  if (knownFields !== undefined && !knownFields.includes(field.name) && field.name !== '__type' && field.name !== '__schema') {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  switch (typeName) {
    case 'Query':
      return resolveQuery(ctx, field.name, fieldArgs);
    case 'Mutation':
      return resolveMutation(ctx, field.name, fieldArgs);
    case 'User':
      if (field.name === 'login') return (source as Source).login ?? forge.login ?? '';
      if (field.name === 'id') return encodeGlobalId('U', 1);
      if (field.name === 'name') return forge.login ?? '';
      return null;
    case 'Repository':
      return resolveRepository(ctx, source!, field.name, fieldArgs);
    case 'Issue': {
      const issueRecord = (source as Source).issue as IssueRec;
      const repoRecord = (source as Source).repo as Repo;
      switch (field.name) {
        case 'id': return encodeGlobalId('I', repoRecord.id, issueRecord.number);
        case 'number': return issueRecord.number;
        case 'title': return issueRecord.title;
        case 'body': return issueRecord.body;
        case 'state': return issueRecord.state.toUpperCase();
        case 'author': return userNode(forge);
        case 'repository': return repoNode(forge, repoRecord);
        case 'createdAt': return forge.isoAt(issueRecord.seq);
        case 'updatedAt': return forge.isoAt(issueRecord.seq);
        case 'closed': return issueRecord.state === 'closed';
        case 'labels': return { __typename: 'LabelConnection', nodes: issueRecord.labels.map((labelName) => ({ __typename: 'Label', name: labelName, color: repoRecord.labels.get(labelName)?.color ?? 'ededed' })) };
        case 'comments': return { __typename: 'CommentConnection', nodes: issueRecord.comments.map((entry) => commentNode(forge, repoRecord, issueRecord.number, entry)) };
        default: return null;
      }
    }
    case 'PullRequest': {
      const pullRecord = (source as Source).pull as PullRec;
      const repoRecord = (source as Source).repo as Repo;
      switch (field.name) {
        case 'id': return encodeGlobalId('P', repoRecord.id, pullRecord.number);
        case 'number': return pullRecord.number;
        case 'title': return pullRecord.title;
        case 'body': return pullRecord.body;
        case 'state': return pullRecord.merged ? 'MERGED' : pullRecord.state.toUpperCase();
        case 'merged': return pullRecord.merged;
        case 'headRefName': return pullRecord.headRef;
        case 'baseRefName': return pullRecord.baseRef;
        case 'mergeable': return pullMergeable(forge, repoRecord, pullRecord);
        case 'author': return userNode(forge);
        case 'createdAt': return forge.isoAt(pullRecord.seq);
        case 'updatedAt': return forge.isoAt(pullRecord.seq);
        case 'closed': return pullRecord.state === 'closed';
        case 'mergedAt': return pullRecord.merged ? forge.isoAt(pullRecord.mergedSeq) : null;
        case 'mergeCommit': return pullRecord.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pullRecord.mergeCommitSha };
        case 'files': {
          const changedFiles = forge.pullFiles(repoRecord, pullRecord);
          const limit = typeof fieldArgs.first === 'number' ? fieldArgs.first : changedFiles.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: changedFiles.slice(0, limit).map((fileRow) => ({ __typename: 'PullRequestChangedFile', path: fileRow.path, additions: fileRow.additions, deletions: fileRow.deletions })),
            totalCount: changedFiles.length,
          };
        }
        case 'additions': return forge.pullFiles(repoRecord, pullRecord).reduce((total, fileRow) => total + fileRow.additions, 0);
        case 'deletions': return forge.pullFiles(repoRecord, pullRecord).reduce((total, fileRow) => total + fileRow.deletions, 0);
        case 'changedFiles': return forge.pullFiles(repoRecord, pullRecord).length;
        case 'comments': return { __typename: 'CommentConnection', nodes: pullRecord.comments.map((entry) => commentNode(forge, repoRecord, pullRecord.number, entry)) };
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
      const typeInfo = (source as Source).typeDef as { name: string; kind: string };
      switch (field.name) {
        case 'name': return typeInfo.name;
        case 'kind': return typeInfo.kind;
        case 'fields': return (TYPE_FIELDS[typeInfo.name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
        case 'enumValues': return (ENUM_VALUES[typeInfo.name] ?? []).map((valueName) => ({ __typename: '__EnumValue', name: valueName }));
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

function commentNode(forge: Forge, repo: Repo, subjectNumber: number, entry: { id: number; body: string; seq: number }): Source {
  return {
    __typename: 'IssueComment',
    id: encodeGlobalId('C', repo.id, subjectNumber, entry.id),
    body: entry.body,
    createdAt: forge.isoAt(entry.seq),
    updatedAt: forge.isoAt(entry.seq),
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
      return userNode(forge);
    case 'repository': {
      const ownerLogin = typeof args.owner === 'string' ? args.owner : '';
      const nameArg = typeof args.name === 'string' ? args.name : '';
      const foundRepo = forge.repos.get(nameArg);
      if (foundRepo === undefined || !forge.ownerMatches(ownerLogin)) return null;
      forge.adoptLogin(ownerLogin);
      return repoNode(forge, foundRepo);
    }
    case 'node': {
      const idArg = typeof args.id === 'string' ? args.id : '';
      return nodeById(ctx, idArg);
    }
    case '__type': {
      const wantedType = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[wantedType] !== undefined) return { __typename: '__Type', typeDef: { name: wantedType, kind: 'OBJECT' } };
      if (ENUM_VALUES[wantedType] !== undefined) return { __typename: '__Type', typeDef: { name: wantedType, kind: 'ENUM' } };
      return null;
    }
    default:
      return null;
  }
}

function nodeById(ctx: Ctx, id: string): Source | null {
  const { forge } = ctx;
  const idParts = decodeGlobalId(id);
  if (idParts === null) return null;
  const [kindTag, firstPart, secondPart] = idParts;
  if (kindTag === 'R') {
    const foundRepo = [...forge.repos.values()].find((entry) => entry.id === Number(firstPart));
    return foundRepo === undefined ? null : repoNode(forge, foundRepo);
  }
  if (kindTag === 'I' || kindTag === 'P') {
    const foundRepo = [...forge.repos.values()].find((entry) => entry.id === Number(firstPart));
    if (foundRepo === undefined) return null;
    if (kindTag === 'I') {
      const foundIssue = foundRepo.issues.get(Number(secondPart));
      return foundIssue === undefined ? null : issueNode(foundRepo, foundIssue);
    }
    const foundPull = foundRepo.pulls.get(Number(secondPart));
    return foundPull === undefined ? null : pullNode(foundRepo, foundPull);
  }
  if (kindTag === 'U') return userNode(forge);
  return null;
}

function resolveRepository(ctx: Ctx, source: Source, name: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  const repoRecord = source.repo as Repo;
  switch (name) {
    case 'id': return encodeGlobalId('R', repoRecord.id);
    case 'databaseId': return repoRecord.id;
    case 'name': return repoRecord.name;
    case 'nameWithOwner': return `${forge.login ?? ''}/${repoRecord.name}`;
    case 'owner': return userNode(forge);
    case 'description': return repoRecord.description;
    case 'isPrivate': return repoRecord.isPrivate;
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'createdAt': return forge.isoAt(repoRecord.seq);
    case 'updatedAt': return forge.isoAt(repoRecord.seq);
    case 'defaultBranchRef': {
      const tipOid = forge.branchTip(repoRecord, repoRecord.defaultBranch);
      return tipOid === null ? null : { __typename: 'Ref', name: repoRecord.defaultBranch, oid: tipOid };
    }
    case 'issue': {
      const foundIssue = typeof args.number === 'number' ? repoRecord.issues.get(args.number) : undefined;
      return foundIssue === undefined ? null : issueNode(repoRecord, foundIssue);
    }
    case 'issues': return issuesConnection(ctx, repoRecord, args);
    case 'pullRequest': {
      const foundPull = typeof args.number === 'number' ? repoRecord.pulls.get(args.number) : undefined;
      return foundPull === undefined ? null : pullNode(repoRecord, foundPull);
    }
    case 'pullRequests': {
      const everyPull = [...repoRecord.pulls.values()].sort((a, b) => b.number - a.number);
      const limit = typeof args.first === 'number' ? args.first : everyPull.length;
      const slicePage = everyPull.slice(0, limit);
      return {
        __typename: 'PullRequestConnection',
        nodes: slicePage.map((entry) => pullNode(repoRecord, entry)),
        totalCount: everyPull.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: limit < everyPull.length, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    default:
      return null;
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Source {
  let allIssues = [...repo.issues.values()];
  const stateFilter = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state).toLowerCase()) : null;
  if (stateFilter !== null) allIssues = allIssues.filter((entry) => stateFilter.includes(entry.state));
  const orderSpec = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const dir = orderSpec?.direction === 'ASC' ? 'ASC' : orderSpec === null ? 'ASC' : 'DESC';
  const orderField = orderSpec?.field ?? 'CREATED_AT';
  const sortKey = (entry: IssueRec): number => (orderField === 'COMMENTS' ? entry.comments.length * 100000 + entry.seq : entry.seq);
  allIssues.sort((a, b) => {
    const delta = sortKey(a) - sortKey(b);
    if (delta !== 0) return dir === 'DESC' ? -delta : delta;
    return dir === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  let startAt = 0;
  if (typeof args.after === 'string') {
    const afterNo = numberInCursor(args.after);
    const foundAt = afterNo === null ? -1 : allIssues.findIndex((entry) => entry.number === afterNo);
    if (foundAt !== -1) startAt = foundAt + 1;
  }
  const limit = typeof args.first === 'number' ? args.first : allIssues.length;
  const slicePage = allIssues.slice(startAt, startAt + limit);
  const morePages = startAt + limit < allIssues.length;
  const lastCursor = slicePage.length > 0 ? cursorOf(slicePage[slicePage.length - 1]!.number) : typeof args.after === 'string' ? args.after : null;
  return {
    __typename: 'IssueConnection',
    nodes: slicePage.map((entry) => issueNode(repo, entry)),
    totalCount: allIssues.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: morePages,
      hasPreviousPage: startAt > 0,
      startCursor: slicePage.length > 0 ? cursorOf(slicePage[0]!.number) : null,
      endCursor: lastCursor,
    },
  } as unknown as Source;
}

function resolveMutation(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  const inputObj = (args.input ?? {}) as Record<string, unknown>;
  const repoFromGlobalId = (globalId: unknown): Repo | null => {
    const idParts = typeof globalId === 'string' ? decodeGlobalId(globalId) : null;
    if (idParts === null || idParts[0] !== 'R') return null;
    return [...forge.repos.values()].find((entry) => entry.id === Number(idParts[1])) ?? null;
  };
  switch (name) {
    case 'createIssue': {
      const foundRepo = repoFromGlobalId(inputObj.repositoryId);
      if (foundRepo === null) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const createdIssue = forge.addIssue(foundRepo, {
        title: typeof inputObj.title === 'string' ? inputObj.title : '',
        body: typeof inputObj.body === 'string' ? inputObj.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: issueNode(foundRepo, createdIssue) };
    }
    case 'closeIssue': {
      const idParts = typeof inputObj.issueId === 'string' ? decodeGlobalId(inputObj.issueId) : null;
      const foundRepo = idParts !== null && idParts[0] === 'I' ? [...forge.repos.values()].find((entry) => entry.id === Number(idParts[1])) : undefined;
      const foundIssue = foundRepo?.issues.get(Number(idParts?.[2]));
      if (foundRepo === undefined || foundIssue === undefined) {
        ctx.errors.push({ message: 'issue not found for closeIssue' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      foundIssue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(foundRepo, foundIssue) };
    }
    case 'createPullRequest': {
      const foundRepo = repoFromGlobalId(inputObj.repositoryId);
      if (foundRepo === null) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const outcome = forge.createPull(foundRepo, {
        title: typeof inputObj.title === 'string' ? inputObj.title : '',
        body: typeof inputObj.body === 'string' ? inputObj.body : '',
        head: typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '',
        base: typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : foundRepo.defaultBranch,
      });
      if (!outcome.ok) {
        ctx.errors.push({ message: outcome.problem });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(foundRepo, outcome.pull) };
    }
    case 'mergePullRequest': {
      const idParts = typeof inputObj.pullRequestId === 'string' ? decodeGlobalId(inputObj.pullRequestId) : null;
      const foundRepo = idParts !== null && idParts[0] === 'P' ? [...forge.repos.values()].find((entry) => entry.id === Number(idParts[1])) : undefined;
      const foundPull = foundRepo?.pulls.get(Number(idParts?.[2]));
      if (foundRepo === undefined || foundPull === undefined) {
        ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const mergeMethods: Record<string, 'merge' | 'squash' | 'rebase'> = { MERGE: 'merge', SQUASH: 'squash', REBASE: 'rebase' };
      const chosenMethod = mergeMethods[typeof inputObj.mergeMethod === 'string' ? inputObj.mergeMethod : 'SQUASH'] ?? 'squash';
      const mergeOutcome = forge.mergePull(foundRepo, foundPull, chosenMethod);
      if (!mergeOutcome.ok) {
        ctx.errors.push({ message: mergeOutcome.problem });
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(foundRepo, foundPull) };
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(foundRepo, foundPull) };
    }
    case 'addComment': {
      const idParts = typeof inputObj.subjectId === 'string' ? decodeGlobalId(inputObj.subjectId) : null;
      const commentBody = typeof inputObj.body === 'string' ? inputObj.body : '';
      if (idParts !== null && (idParts[0] === 'I' || idParts[0] === 'P')) {
        const foundRepo = [...forge.repos.values()].find((entry) => entry.id === Number(idParts[1]));
        const target = idParts[0] === 'I' ? foundRepo?.issues.get(Number(idParts[2])) : foundRepo?.pulls.get(Number(idParts[2]));
        if (foundRepo !== undefined && target !== undefined) {
          const addedComment = forge.addComment(target, commentBody);
          const nodeSource: Source = {
            __typename: 'IssueComment',
            id: encodeGlobalId('C', foundRepo.id, target.number, addedComment.id),
            body: addedComment.body,
            createdAt: forge.isoAt(addedComment.seq),
          } as unknown as Source;
          return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: nodeSource, cursor: cursorOf(target.number) } };
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
  const queryText = typeof body.query === 'string' ? body.query : '';
  const vars = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  let doc: Document;
  try {
    doc = new Parser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const opName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const chosenOp = doc.operations.find((entry) => entry.name === opName) ?? doc.operations[0]!;
  const context: Ctx = { forge, variables: vars, fragments: doc.fragments, errors: [] };
  const rootKind = chosenOp.type === 'mutation' ? 'Mutation' : 'Query';
  const dataOut = executeSelection(context, rootKind, { __typename: rootKind }, chosenOp.selectionSet);
  const outcome: OperationResult = { data: dataOut };
  if (context.errors.length > 0) outcome.errors = context.errors;
  return outcome;
}

/** Serve POST /api/graphql (single operations and JSON-array batches). */
export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');
  const rawBytes = await readBody(req);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBytes.toString('utf8')) as unknown;
  } catch {
    return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  if (Array.isArray(parsedBody)) {
    const batchResults = parsedBody.map((batchEntry) => executeOne(forge, (batchEntry ?? {}) as Record<string, unknown>));
    return sendJson(res, 200, batchResults);
  }
  if (parsedBody !== null && typeof parsedBody === 'object') {
    return sendJson(res, 200, executeOne(forge, parsedBody as Record<string, unknown>));
  }
  return sendJson(res, 400, { errors: [{ message: 'Expected a GraphQL operation object' }] });
}
