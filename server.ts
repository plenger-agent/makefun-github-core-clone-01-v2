// Raw-socket HTTP/1.1 transport: the forge's hot paths are thousands of small sequential requests
// on pooled keep-alive connections, and the stock node:http stack spends most of each request's
// life on machinery this server does not need (header object churn, date/connection bookkeeping,
// stream plumbing in both directions). This module speaks just enough HTTP/1.1, directly on
// node:net sockets, to serve the suite's clients:
//
//   - request line + headers, Content-Length and chunked request bodies, Expect: 100-continue;
//   - keep-alive with strictly ordered per-socket dispatch (the clients never pipeline, but a
//     pipelined request already sitting in the buffer is still answered in order);
//   - one socket write per response (status line, headers and body in a single buffer);
//   - TCP_NODELAY on every socket, so a small response never waits on Nagle.
//
// The request/response pair it hands to the application is duck-typed to the slice of the
// node:http surface the forge's handlers use: req is a Readable carrying method/url/headers,
// res collects status + headers + body and flushes once at end(). Determinism is untouched:
// nothing here feeds the state export, and the Date header is the same wall-clock header
// node:http would have sent.

import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { STATUS_CODES } from 'node:http';

/** The request object the handlers see: a Readable body plus the parsed head. */
export class HttpRequest extends Readable {
  method = 'GET';
  url = '/';
  httpVersion = '1.1';
  headers: Record<string, string> = {};
  /** Set by the transport: tearing the request down tears the socket down with it. */
  destroySocket: (() => void) | null = null;

  constructor() {
    // autoDestroy must stay off: the stream runtime would otherwise call destroy() the moment
    // the body is fully consumed — and destroy() here destroys the socket, before the response
    // has been written to it.
    super({ autoDestroy: false });
  }

  override _read(): void {
    // The transport pushes the whole body (then EOF) once the head is parsed; nothing to pull.
  }

  override destroy(error?: Error): this {
    if (this.destroySocket !== null) this.destroySocket();
    return super.destroy(error);
  }
}

type HeaderMap = Map<string, [string, string]>;

/** The response object the handlers see: status and headers are collected, body buffered, one flush. */
export class HttpResponse {
  statusCode = 200;
  headersSent = false;
  private readonly endListeners: Array<() => void> = [];
  private readonly headerMap: HeaderMap = new Map();
  private readonly chunks: Buffer[] = [];
  private ended = false;

  setHeader(name: string, value: string | number): this {
    this.headerMap.set(name.toLowerCase(), [name, String(value)]);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase())?.[1];
  }

  removeHeader(name: string): void {
    this.headerMap.delete(name.toLowerCase());
  }

  writeHead(status: number, headers: Readonly<Record<string, string | number>> = {}): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    if (this.ended) return false;
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    return true;
  }

  /** Register a callback fired once, synchronously, when end() first completes the response. */
  addEndListener(listener: () => void): void {
    this.endListeners.push(listener);
  }

  end(chunk?: string | Buffer): this {
    if (this.ended) return this;
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.ended = true;
    for (const listener of this.endListeners) listener();
    return this;
  }

  /** The collected outcome, once end() ran: status, headers (insertion order), body. */
  outcome(): { status: number; headers: HeaderMap; body: Buffer } {
    return { status: this.statusCode, headers: this.headerMap, body: Buffer.concat(this.chunks) };
  }

  /** Load a previously collected outcome (response-cache replay) and finish with it. */
  replay(status: number, headers: HeaderMap, body: Buffer): void {
    this.statusCode = status;
    for (const [lower, pair] of headers) {
      if (lower === 'x-github-request-id') continue; // the caller already set this request's own id
      this.headerMap.set(lower, pair);
    }
    this.chunks.length = 0;
    this.chunks.push(body);
    this.end();
  }
}

export type HttpHandler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>;

const MAX_HEAD_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 65_000;

/** Build the TCP server; the returned net.Server gives the caller listen/address/close as usual. */
export function createHttpServer(handler: HttpHandler): Server {
  const server = createServer((socket) => serveSocket(socket, handler));
  return server;
}

interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  rest: Buffer;
}

/** Parse one request head from the front of `buffer`; null when more bytes are needed. */
function parseHead(buffer: Buffer): ParsedHead | null {
  const headEnd = buffer.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    if (buffer.length > MAX_HEAD_BYTES) throw new Error('request head too large');
    return null;
  }
  const text = buffer.toString('latin1', 0, headEnd);
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';
  const match = /^([A-Z]+) ([^ ]+) HTTP\/(\d+\.\d+)$/.exec(requestLine);
  if (match === null) throw new Error('malformed request line');
  const headers: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    headers[name] = existing === undefined ? value : `${existing}, ${value}`;
  }
  return { method: match[1]!, target: match[2]!, version: match[3]!, headers, rest: buffer.subarray(headEnd + 4) };
}

/** The body length a head declares, or -1 for chunked framing. Throws on a bad Content-Length. */
function declaredBody(head: ParsedHead): number {
  const encoding = head.headers['transfer-encoding'];
  if (encoding !== undefined && /(?:^|,)\s*chunked\s*$/i.test(encoding)) return -1;
  const length = head.headers['content-length'];
  if (length === undefined) return 0;
  const value = Number.parseInt(length, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error('bad content-length');
  return value;
}

/** Dechunk a chunked body starting at `start`; null when more bytes are needed. */
function dechunk(buffer: Buffer, start: number): { body: Buffer; next: number } | null {
  const parts: Buffer[] = [];
  let cursor = start;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', cursor);
    if (lineEnd === -1) return null;
    const sizeText = buffer.toString('latin1', cursor, lineEnd).split(';')[0]!.trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    if (size === 0) {
      // Trailers run to an empty line; the common case is the immediate CRLF.
      if (buffer.length < lineEnd + 4) return null;
      if (buffer.toString('latin1', lineEnd + 2, lineEnd + 4) === '\r\n') {
        return { body: Buffer.concat(parts), next: lineEnd + 4 };
      }
      const trailerEnd = buffer.indexOf('\r\n\r\n', lineEnd + 2);
      if (trailerEnd === -1) return null;
      return { body: Buffer.concat(parts), next: trailerEnd + 4 };
    }
    const dataStart = lineEnd + 2;
    if (buffer.length < dataStart + size + 2) return null;
    parts.push(buffer.subarray(dataStart, dataStart + size));
    cursor = dataStart + size + 2;
  }
}

/** Serialize one response onto the socket in a single write. */
function writeResponse(socket: Socket, req: HttpRequest, res: HttpResponse, keepAlive: boolean): void {
  const { status, headers, body } = res.outcome();
  const reason = STATUS_CODES[status] ?? '';
  const lines: string[] = [`HTTP/1.1 ${status} ${reason}`];
  let hasContentLength = false;
  let hasDate = false;
  for (const [lower, [name, value]] of headers) {
    if (lower === 'content-length') hasContentLength = true;
    if (lower === 'date') hasDate = true;
    if (lower === 'connection') continue; // the transport speaks for the connection itself
    lines.push(`${name}: ${value}`);
  }
  const isHead = req.method === 'HEAD';
  if (!hasContentLength) lines.push(`Content-Length: ${body.length}`);
  if (!hasDate) lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Connection: ${keepAlive ? 'keep-alive' : 'close'}`);
  const headBytes = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  const payload = isHead || body.length === 0 ? headBytes : Buffer.concat([headBytes, body]);
  socket.write(payload);
}

/** Serve one connection: parse, dispatch in order, answer, repeat while keep-alive lasts. */
function serveSocket(socket: Socket, handler: HttpHandler): void {
  socket.setNoDelay(true);
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  let buffer: Buffer = Buffer.alloc(0);
  let busy = false;
  let closed = false;
  let peerEnded = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    socket.destroy();
  };

  const pump = async (): Promise<void> => {
    if (busy || closed) return;
    busy = true;
    try {
      for (;;) {
        let head: ParsedHead | null;
        try {
          head = parseHead(buffer);
        } catch {
          close();
          return;
        }
        if (head === null) break;
        const bodyLength = declaredBody(head);
        let body: Buffer;
        let consumed: number;
        if (bodyLength === -1) {
          const decoded = dechunk(buffer, buffer.length - head.rest.length);
          if (decoded === null) break;
          body = decoded.body;
          consumed = decoded.next;
        } else {
          if (head.rest.length < bodyLength) {
            // With Expect: 100-continue the client waits for the interim reply before sending.
            if ((head.headers['expect'] ?? '').toLowerCase() === '100-continue') {
              socket.write('HTTP/1.1 100 Continue\r\n\r\n');
              head.headers['expect'] = ''; // do not repeat the interim reply on the next pass
            }
            break;
          }
          body = head.rest.subarray(0, bodyLength);
          consumed = buffer.length - head.rest.length + bodyLength;
        }
        buffer = buffer.subarray(consumed);

        const req = new HttpRequest();
        req.method = head.method;
        req.url = head.target;
        req.httpVersion = head.version;
        req.headers = head.headers;
        req.destroySocket = close;
        const res = new HttpResponse();
        const connection = (head.headers['connection'] ?? '').toLowerCase();
        const keepAlive = head.version === '1.0' ? connection === 'keep-alive' : connection !== 'close';
        const finished = new Promise<void>((resolve) => {
          res.addEndListener(() => resolve());
        });
        const handlerDone = Promise.resolve()
          .then(() => handler(req, res))
          .catch(() => {
            // A handler failure must never take the server down (the suite probes exactly that).
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              res.end('{"message":"Internal Server Error"}\n');
            } else {
              res.end();
            }
          });
        req.push(body);
        req.push(null);
        await Promise.race([finished, handlerDone]);
        writeResponse(socket, req, res, keepAlive);
        if (!keepAlive) {
          closed = true;
          socket.end();
          return;
        }
        if (closed) return;
      }
    } finally {
      busy = false;
    }
    if (peerEnded && buffer.length === 0) close();
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    void pump();
  });
  socket.on('end', () => {
    peerEnded = true;
    void pump();
  });
  socket.on('error', close);
  socket.on('close', () => {
    closed = true;
  });
}
