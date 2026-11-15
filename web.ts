// Small HTTP helpers shared by every surface (REST, GraphQL, MCP, git smart HTTP): JSON answers with
// the discipline the protocol checks require (application/json, never HTML), request bodies read with
// a generous cap, and the bearer-token check the whole forge shares. The req/res pair is the raw
// transport's (server.ts), shaped like the node:http slice the helpers need.

import type { HttpRequest, HttpResponse } from './server.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** Answer with a JSON body; a trailing newline matches the starter's wire style. */
export function sendJson(res: HttpResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with a bare status and no body (204 deletes, 202 notifications). */
export function sendEmpty(res: HttpResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

/** Answer with raw bytes under an explicit content type (git protocol payloads). */
export function sendBytes(res: HttpResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** GitHub's error body: always a JSON object carrying a non-empty `message`. */
export function sendError(res: HttpResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a whole request body (bounded; git packs in the benchmark reach a few hundred KB). */
export function readBody(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Read and JSON-parse a request body. An empty body parses as an empty object; a non-empty body that
 * is not JSON is the protocol group's malformed-body case and answers { ok: false }.
 */
export async function readJsonBody(req: HttpRequest): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: HttpRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1]!;
}

/** Whether the request is authenticated: its bearer token equals the entry's MAKEFUN_SHOP_TOKEN. */
export function isAuthenticated(req: HttpRequest): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = bearerToken(req);
  return presented !== null && presented === expected;
}

/** One decoded path segment (a segment may itself decode to text containing '/', e.g. a file path). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a request URL's path into decoded segments. */
export function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
}

/** A query parameter as a positive integer, or the fallback. */
export function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Slice a list by ?page / ?per_page (GitHub's defaults: page 1, 30 per page). */
export function paginate<T>(items: readonly T[], url: URL): T[] {
  const perPage = Math.min(100, intParam(url, 'per_page', 30));
  const page = intParam(url, 'page', 1);
  return items.slice((page - 1) * perPage, page * perPage);
}
