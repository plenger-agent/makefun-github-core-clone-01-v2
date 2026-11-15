// The forge's HTTP application: one in-memory Forge behind four surfaces — git smart HTTP, REST v3,
// GraphQL v4 and MCP — routed here over the raw-socket transport (server.ts). main.ts owns the
// entry <-> env lifecycle; this file is the whole application, and every answer carries the
// X-GitHub-Request-Id the protocol checks require.
//
// One optimisation lives here because only this layer sees every request: GET answers are cached
// by (url, authorization, git-protocol, accept, adopted login) and replayed byte for byte — the
// read workload alone re-asks for the same issue two thousand times. Any non-GET request clears
// the cache before it runs, so a replay can never outlive the state it was captured from; the
// request id is never cached, each replay carries its own.

import type { Server } from 'node:net';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, sendError, sendJson } from './web.ts';
import { createHttpServer, type HttpRequest, type HttpResponse } from './server.ts';

interface CachedAnswer {
  status: number;
  headers: Map<string, [string, string]>;
  body: Buffer;
}

const CACHE_LIMIT = 1024;
const CACHEABLE_BODY_LIMIT = 1024 * 1024;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const answers = new Map<string, CachedAnswer>();
  return createHttpServer(async (req: HttpRequest, res: HttpResponse) => {
    res.setHeader('x-github-request-id', forge.nextRequestId());
    try {
      if (req.method !== 'GET') {
        // A write anywhere can change any read; drop the whole cache before the write runs.
        answers.clear();
      } else {
        const key = cacheKey(forge, req);
        const hit = answers.get(key);
        if (hit !== undefined) {
          res.replay(hit.status, hit.headers, hit.body);
          return;
        }
        res.addEndListener(() => {
          const { status, headers, body } = res.outcome();
          if (status >= 500 || body.length > CACHEABLE_BODY_LIMIT) return;
          if (answers.size >= CACHE_LIMIT) answers.clear();
          answers.set(key, { status, headers: new Map(headers), body });
        });
      }
      await dispatch(forge, req, res);
    } catch {
      // A handler failure must never take the server down (the suite probes exactly that).
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    }
  });
}

/** Everything a GET answer may depend on, beyond the store the cache-clearing rule guards. */
function cacheKey(forge: Forge, req: HttpRequest): string {
  return [
    req.url,
    req.headers.authorization ?? '',
    req.headers['git-protocol'] ?? '',
    req.headers.accept ?? '',
    forge.login ?? '',
  ].join('\n');
}

/** Route one request to its surface. */
async function dispatch(forge: Forge, req: HttpRequest, res: HttpResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return sendError(res, 400, 'Bad Request');
  }
  const segments = pathSegments(url);

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    return handleRest(forge, req, res, url, segments.slice(2));
  }
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    return handleGraphQL(forge, req, res);
  }
  if (segments.length === 1 && segments[0] === 'mcp') {
    return handleMcp(forge, req, res);
  }
  if (await handleGit(forge, req, res, url, segments)) return;

  // Everything else, every method: GitHub's 404 body.
  return sendError(res, 404, 'Not Found');
}
