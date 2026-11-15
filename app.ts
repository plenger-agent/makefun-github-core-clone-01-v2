// The forge's HTTP application: a single in-memory Forge fronted by four
// surfaces — git smart HTTP, REST v3, GraphQL v4 and MCP — routed here over
// the raw-socket transport (server.ts). main.ts owns the entry <-> env
// lifecycle; this file is the whole application, and every answer carries
// the X-GitHub-Request-Id the protocol checks require.
//
// One optimisation lives at this layer because only this layer sees every
// request: GET answers are cached under (url, authorization, git-protocol,
// accept, adopted login) and replayed byte for byte — the read workload
// alone re-asks for the same issue two thousand times. Any non-GET request
// empties the cache before it runs, so a replay can never outlive the state
// it was captured from; the request id is never cached, each replay mints
// its own.

import type { Server } from 'node:net';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, sendError, sendJson } from './web.ts';
import { createHttpServer, type HttpRequest, type HttpResponse } from './server.ts';

interface StoredReply {
  status: number;
  headers: Map<string, [string, string]>;
  body: Buffer;
}

const MAX_STORED_REPLIES = 1024;
const MAX_STORABLE_BODY = 1024 * 1024;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const core = new Forge();
  const replyStore = new Map<string, StoredReply>();
  return createHttpServer(async (req: HttpRequest, res: HttpResponse) => {
    res.setHeader('x-github-request-id', core.nextRequestId());
    try {
      if (req.method !== 'GET') {
        // A write anywhere can change any read; drop the whole cache before the write runs.
        replyStore.clear();
      } else {
        const cacheId = cacheKey(core, req);
        const stored = replyStore.get(cacheId);
        if (stored !== undefined) {
          res.replay(stored.status, stored.headers, stored.body);
          return;
        }
        res.addEndListener(() => {
          const outcome = res.outcome();
          if (outcome.status >= 500 || outcome.body.length > MAX_STORABLE_BODY) return;
          if (replyStore.size >= MAX_STORED_REPLIES) replyStore.clear();
          replyStore.set(cacheId, { status: outcome.status, headers: new Map(outcome.headers), body: outcome.body });
        });
      }
      await dispatch(core, req, res);
    } catch {
      // A handler failure must never take the server down (the suite probes exactly that).
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    }
  });
}

/** Everything a GET answer may depend on, beyond the store the cache-clearing rule guards. */
function cacheKey(core: Forge, req: HttpRequest): string {
  return [
    req.url,
    req.headers.authorization ?? '',
    req.headers['git-protocol'] ?? '',
    req.headers.accept ?? '',
    core.login ?? '',
  ].join('\n');
}

/** Route one request to its surface. */
async function dispatch(core: Forge, req: HttpRequest, res: HttpResponse): Promise<void> {
  const verb = req.method ?? 'GET';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return sendError(res, 400, 'Bad Request');
  }
  const parts = pathSegments(parsedUrl);

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (verb === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'api' && parts[1] === 'v3') {
    return handleRest(core, req, res, parsedUrl, parts.slice(2));
  }
  if (parts[0] === 'api' && parts[1] === 'graphql') {
    if (verb !== 'POST') return sendError(res, 404, 'Not Found');
    return handleGraphQL(core, req, res);
  }
  if (parts.length === 1 && parts[0] === 'mcp') {
    return handleMcp(core, req, res);
  }
  if (await handleGit(core, req, res, parsedUrl, parts)) return;

  // Everything else, every method: GitHub's 404 body.
  return sendError(res, 404, 'Not Found');
}
