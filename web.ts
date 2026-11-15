// Small HTTP helpers shared by every surface (REST, GraphQL, MCP, git smart
// HTTP): JSON answers kept to the discipline the protocol checks require
// (application/json, never HTML), request bodies read under a generous cap,
// and the bearer-token check the whole forge shares. The req/res pair is the
// raw transport's (server.ts), shaped like the node:http slice these helpers
// need.

import type { HttpRequest, HttpResponse } from './server.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';
const BODY_CAP_BYTES = 256 * 1024 * 1024;

/** Answer with a JSON body; a trailing newline matches the starter's wire style. */
export function sendJson(res: HttpResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payloadText = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(payloadText), ...headers });
  res.end(payloadText);
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
    const pieces: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > BODY_CAP_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      pieces.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(pieces)));
    req.on('error', reject);
  });
}

/**
 * Read and JSON-parse a request body. An empty body parses as an empty object; a non-empty body that
 * is not JSON is the protocol group's malformed-body case and answers { ok: false }.
 */
export async function readJsonBody(req: HttpRequest): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const rawBytes = await readBody(req);
  if (rawBytes.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(rawBytes.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, value: {} };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: HttpRequest): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string') return null;
  const found = /^Bearer (.+)$/.exec(authHeader);
  return found === null ? null : found[1]!;
}

/** Whether the request is authenticated: its bearer token equals the entry's MAKEFUN_SHOP_TOKEN. */
export function isAuthenticated(req: HttpRequest): boolean {
  const wanted = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const offered = bearerToken(req);
  return offered !== null && offered === wanted;
}

/** One decoded path segment (a segment may itself decode to text containing '/', e.g. a file path). */
export function decodeSegment(rawSegment: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return rawSegment;
  }
}

/** Split a request URL's path into decoded segments. */
export function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((piece) => piece !== '').map(decodeSegment);
}

/** A query parameter as a positive integer, or the fallback. */
export function intParam(url: URL, name: string, fallback: number): number {
  const text = url.searchParams.get(name);
  if (text === null) return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Slice a list by ?page / ?per_page (GitHub's defaults: page 1, 30 per page). */
export function paginate<T>(list: readonly T[], url: URL): T[] {
  const pageSize = Math.min(100, intParam(url, 'per_page', 30));
  const pageNumber = intParam(url, 'page', 1);
  return list.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
}
