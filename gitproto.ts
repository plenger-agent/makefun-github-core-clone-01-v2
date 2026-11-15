// Git smart HTTP: the info/refs advertisements (protocol v2 and v0), v2 ls-refs and fetch, v0 fetch,
// and v0 receive-pack with report-status. The suite's client speaks the wire protocol in-process, so
// this module implements the protocol itself: pkt-line framing, pack v2 reading (with delta
// resolution) and writing (plain objects — always valid), shallow/deepen bookkeeping, and per-ref
// fast-forward enforcement on push.
//
// Everything is served from the shared Forge store: objects pushed here are the objects the REST
// contents API and clones see.
//
// v2 adds two caches on top of v1, both sound because the object store is content-addressed and
// append-only (objects are never mutated or deleted, so the reachable closure of a fixed oid set
// can never change):
//   - fetch answers (v0 and v2) are cached by the exact inputs the plan depends on — wants, haves,
//     the client's shallow set and depth — plus a store fingerprint (object count and this repo's
//     ref tips). The clone workload asks fifty times for the same depth-1 pack; it is built once.
//   - ls-refs answers are cached by their flags/prefixes plus the same ref fingerprint.
// The v2 capability advertisement carries no per-repo data at all, so it is built once, up front.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Forge, ZERO_OID, parseCommit, parseTag, type GitObj, type ObjType, type Repo } from './store.ts';
import { isAuthenticated, readBody, sendBytes, sendError } from './web.ts';
import type { HttpRequest, HttpResponse } from './server.ts';

const AGENT = 'plenger-forge/1.0.0';
const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a pkt-line stream; trailing bytes that are not framed are returned as `rest`. */
function decodePackets(data: Buffer, offset = 0): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let cursor = offset;
  while (cursor + 4 <= data.length) {
    const hex = data.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      cursor += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > data.length) break;
    packets.push({ kind: 'data', payload: data.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { packets, rest: data.subarray(cursor) };
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

/** Serialize objects into a pack v2 (plain entries, zlib-deflated) with its SHA-1 trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return result;
}

/**
 * Parse a received pack into the store. Entries may be plain or delta-compressed (OFS/REF); thin-pack
 * bases are looked up in the store. Throws on structural corruption.
 */
export function readPackInto(forge: Forge, pack: Buffer): void {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface RawEntry {
    type: ObjType;
    data?: Buffer;
    baseOid?: string;
    baseOffset?: number;
    start: number;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { type: TYPE_NAMES[typeId] ?? 'blob', start };
    if (typeId === 6) {
      // OFS_DELTA
      let back = pack[offset]!;
      offset += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      entry.baseOffset = start - baseOffset;
      entry.type = 'blob'; // resolved below
    } else if (typeId === 7) {
      // REF_DELTA
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      entry.type = 'blob'; // resolved below
    } else {
      const inflated = inflateSync(pack.subarray(offset));
      if (inflated.length !== size) throw new Error('pack entry size mismatch');
      entry.data = inflated;
      offset += compressedLength(pack, offset, inflated.length);
    }
    if (entry.baseOid !== undefined || entry.baseOffset !== undefined) {
      const inflated = inflateSync(pack.subarray(offset));
      entry.data = inflated; // the delta bytes, for now
      offset += compressedLength(pack, offset, inflated.length);
      // stash delta bytes in `data` and mark via base fields; resolved in pass two
      entries.push(entry);
      byOffset.set(start, entries.length - 1);
      continue;
    }
    entries.push(entry);
    byOffset.set(start, entries.length - 1);
  }
  // Pass two: resolve deltas (bases may themselves be deltas).
  const resolved = new Map<number, { type: ObjType; data: Buffer }>();
  const resolve = (index: number): { type: ObjType; data: Buffer } => {
    const cached = resolved.get(index);
    if (cached !== undefined) return cached;
    const entry = entries[index]!;
    let result: { type: ObjType; data: Buffer };
    if (entry.baseOid === undefined && entry.baseOffset === undefined) {
      result = { type: entry.type, data: entry.data! };
    } else {
      let base: { type: ObjType; data: Buffer };
      if (entry.baseOid !== undefined) {
        const baseObject = forge.getObject(entry.baseOid);
        if (baseObject === undefined) throw new Error('thin pack base is missing');
        base = baseObject;
      } else {
        const baseIndex = byOffset.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error('ofs delta base is missing');
        base = resolve(baseIndex);
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data!) };
    }
    resolved.set(index, result);
    return result;
  };
  for (let index = 0; index < entries.length; index += 1) {
    const object = resolve(index);
    forge.putObject(object.type, object.data);
  }
}

/**
 * The number of compressed bytes an entry occupies in the pack. zlib streams are self-terminating
 * and Node's inflateSync tolerates trailing bytes, so "a prefix inflates to the full payload" is
 * monotone in the prefix length: bracket the length exponentially, then binary-search inside the
 * bracket, keeping the total re-inflation work within a small multiple of the entry's own size.
 */
function compressedLength(pack: Buffer, offset: number, inflatedLength: number): number {
  const remaining = pack.length - offset;
  const inflates = (length: number): boolean => {
    try {
      return inflateSync(pack.subarray(offset, offset + length)).length === inflatedLength;
    } catch {
      return false;
    }
  };
  let low = 0; // known to fail (or the empty prefix)
  let high = Math.min(remaining, 1024);
  while (!inflates(high)) {
    low = high;
    if (high >= remaining) return remaining;
    high = Math.min(remaining, high * 4);
  }
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (inflates(mid)) high = mid;
    else low = mid;
  }
  return high;
}

// ---------------------------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function uploadPackCapsV0(forge: Forge, repo: Repo): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    `agent=${AGENT}`,
    `symref=HEAD:${forge.headRef(repo)}`,
    'object-format=sha1',
  ].join(' ');
}

function receivePackCaps(forge: Forge, repo: Repo): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`, `symref=HEAD:${forge.headRef(repo)}`].join(' ');
}

/** Ref lines for a v0 advertisement: HEAD first (carrying the capabilities), then refs with peels. */
function v0RefLines(forge: Forge, repo: Repo, caps: string): Buffer[] {
  const headRef = forge.headRef(repo);
  const headOid = repo.refs.get(headRef);
  const lines: Buffer[] = [];
  if (headOid === undefined && repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  if (headOid !== undefined) {
    lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  } else {
    const first = sortedRefs(repo)[0];
    if (first !== undefined) lines.push(pktLine(`${first[1]} ${first[0]}\0${caps}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (headOid === undefined && lines.length === 1 && ref === sortedRefs(repo)[0]![0]) continue;
    lines.push(pktLine(`${oid} ${ref}\n`));
    if (ref.startsWith('refs/tags/')) {
      const peeled = forge.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return lines;
}

/** The v2 capability advertisement: fixed lines, no per-repo data — built once for the process. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function infoRefs(forge: Forge, res: HttpResponse, repo: Repo, service: string, protocolHeader: string | undefined): void {
  const isUpload = service === 'git-upload-pack';
  const wantsV2 = isUpload && protocolHeader !== undefined && protocolHeader.includes('version=2');
  if (wantsV2) {
    return sendBytes(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
  }
  const preamble = pktLine(`# service=${service}\n`);
  const caps = isUpload ? uploadPackCapsV0(forge, repo) : receivePackCaps(forge, repo);
  const body = Buffer.concat([preamble, PKT_FLUSH, ...v0RefLines(forge, repo, caps), PKT_FLUSH]);
  return sendBytes(res, 200, body, isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
}

// ---------------------------------------------------------------------------------------------
// answer caches (fetch and ls-refs)
// ---------------------------------------------------------------------------------------------

const ANSWER_CACHE_LIMIT = 512;
const answerCaches = new WeakMap<Forge, Map<string, Buffer>>();

function answerCache(forge: Forge): Map<string, Buffer> {
  let cache = answerCaches.get(forge);
  if (cache === undefined) {
    cache = new Map();
    answerCaches.set(forge, cache);
  }
  return cache;
}

function cacheAnswer(forge: Forge, key: string, body: Buffer): void {
  const cache = answerCache(forge);
  if (cache.size >= ANSWER_CACHE_LIMIT) cache.clear();
  cache.set(key, body);
}

/** A fingerprint of everything outside a request's own fields that an answer may depend on. */
function storeFingerprint(forge: Forge, repo: Repo): string {
  const refs = sortedRefs(repo)
    .map(([ref, oid]) => `${ref}=${oid}`)
    .join(',');
  return `${forge.objects.size}|${forge.headRef(repo)}|${refs}`;
}

function answerKey(forge: Forge, repo: Repo, parts: readonly string[]): string {
  return createHash('sha1').update(parts.join('\n')).update('\n').update(storeFingerprint(forge, repo)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

function lsRefs(forge: Forge, res: HttpResponse, repo: Repo, packets: Packet[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const key = answerKey(forge, repo, ['ls-refs', String(peel), String(symrefs), String(unborn), ...prefixes]);
  const cached = answerCache(forge).get(key);
  if (cached !== undefined) {
    return sendBytes(res, 200, cached, 'application/x-git-upload-pack-result');
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = forge.headRef(repo);
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let suffix = '';
    if (peel && ref.startsWith('refs/tags/')) {
      const peeled = forge.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) suffix = ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${oid} ${ref}${suffix}\n`));
  }
  const body = Buffer.concat([...lines, PKT_FLUSH]);
  cacheAnswer(forge, key, body);
  return sendBytes(res, 200, body, 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to put in the pack. */
  send: GitObj[];
  /** Commits to report as the (new) shallow boundary. */
  shallow: string[];
  /** Commits to report as no longer shallow. */
  unshallow: string[];
}

/**
 * Work out what a fetch transfers. Commit distance is measured from the wants (through tags);
 * `depth` bounds it. Exclusion is depth-aware for shallow clients: a have the client holds as a
 * shallow boundary excludes only itself and its trees, never its parents.
 */
function planFetch(forge: Forge, wants: string[], haves: string[], clientShallow: ReadonlySet<string>, depth: number | null): FetchPlan {
  const included = new Set<string>();
  const commitLevel = new Map<string, number>();
  // Breadth-first by commit level; tags and trees ride along with their commit.
  const includeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const object = forge.getObject(oid);
      if (object === undefined) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTreeEntries(forge, oid)) stack.push(entry.oid);
      }
    }
  };
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) queue.push({ oid: want, level: 0 });
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    const object = forge.getObject(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.add(oid);
      queue.push({ oid: parseTag(object.data).object, level });
      continue;
    }
    if (object.type !== 'commit') continue;
    const known = commitLevel.get(oid);
    if (known !== undefined && known <= level) continue;
    commitLevel.set(oid, level);
    if (depth !== null && level >= depth) continue;
    included.add(oid);
    const commit = parseCommit(object.data);
    includeTree(commit.tree);
    for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
  }
  // Shallow boundary: included commits with a parent that is not included.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of included) {
      const object = forge.getObject(oid)!;
      if (object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent))) shallow.push(oid);
    }
  }
  // Exclusions.
  const excluded = new Set<string>();
  for (const have of haves) {
    if (depth !== null && clientShallow.has(have)) {
      excluded.add(have);
      const object = forge.getObject(have);
      if (object !== undefined && object.type === 'commit') {
        const stack = [parseCommit(object.data).tree];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (excluded.has(oid)) continue;
          const entry = forge.getObject(oid);
          if (entry === undefined) continue;
          excluded.add(oid);
          if (entry.type === 'tree') for (const child of parseTreeEntries(forge, oid)) stack.push(child.oid);
        }
      }
    } else {
      for (const oid of forge.reachable([have])) excluded.add(oid);
    }
  }
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of clientShallow) {
      if (included.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
    }
  }
  const send: GitObj[] = [];
  for (const oid of included) {
    if (excluded.has(oid)) continue;
    const object = forge.getObject(oid);
    if (object !== undefined) send.push(object);
  }
  return { send, shallow, unshallow };
}

function parseTreeEntries(forge: Forge, treeOid: string): Array<{ oid: string }> {
  const object = forge.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  // Local import indirection avoided: parse entries inline via store's parser.
  return parseTreeData(object.data);
}

function parseTreeData(data: Buffer): Array<{ oid: string }> {
  const entries: Array<{ oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({ oid: data.toString('hex', nul + 1, nul + 21) });
    offset = nul + 21;
  }
  return entries;
}

/** Frame pack bytes as sideband-64k packets (band 1), with one band-2 progress note first. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: sending objects\n', 'utf8')]))];
  const CHUNK = 32_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

interface FetchAsk {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth: number | null;
}

/** Parse the ask lines shared by the v0 and v2 fetch commands. */
function parseFetchAsk(packets: Packet[], v2: boolean): FetchAsk {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(v2 ? line.slice(5).trim() : line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  return { wants, haves, clientShallow, depth };
}

function fetchKey(forge: Forge, repo: Repo, flavour: string, ask: FetchAsk): string {
  return answerKey(forge, repo, [
    flavour,
    `w:${[...ask.wants].sort().join(',')}`,
    `h:${[...ask.haves].sort().join(',')}`,
    `s:${[...ask.clientShallow].sort().join(',')}`,
    `d:${ask.depth === null ? '' : ask.depth}`,
  ]);
}

function fetchV2(forge: Forge, res: HttpResponse, repo: Repo, packets: Packet[]): void {
  const ask = parseFetchAsk(packets, true);
  const key = fetchKey(forge, repo, 'fetch-v2', ask);
  const cached = answerCache(forge).get(key);
  if (cached !== undefined) {
    return sendBytes(res, 200, cached, 'application/x-git-upload-pack-result');
  }
  const plan = planFetch(forge, ask.wants, ask.haves, ask.clientShallow, ask.depth);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
  if (ask.depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  cacheAnswer(forge, key, body);
  return sendBytes(res, 200, body, 'application/x-git-upload-pack-result');
}

function fetchV0(forge: Forge, res: HttpResponse, repo: Repo, packets: Packet[]): void {
  const ask = parseFetchAsk(packets, false);
  const key = fetchKey(forge, repo, 'fetch-v0', ask);
  const cached = answerCache(forge).get(key);
  if (cached !== undefined) {
    return sendBytes(res, 200, cached, 'application/x-git-upload-pack-result');
  }
  const plan = planFetch(forge, ask.wants, ask.haves, ask.clientShallow, ask.depth);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [];
  if (ask.depth !== null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(pktLine('NAK\n'), ...sidebandPackets(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  cacheAnswer(forge, key, body);
  return sendBytes(res, 200, body, 'application/x-git-upload-pack-result');
}

async function uploadPack(forge: Forge, req: HttpRequest, res: HttpResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets } = decodePackets(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const firstLine = first === undefined ? '' : first.payload.toString('utf8');
  if (firstLine.startsWith('command=ls-refs')) {
    // The ls-refs arguments follow the delim packet.
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    return lsRefs(forge, res, repo, delimIndex === -1 ? packets : packets.slice(delimIndex + 1));
  }
  if (firstLine.startsWith('command=fetch')) {
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    return fetchV2(forge, res, repo, delimIndex === -1 ? packets : packets.slice(delimIndex + 1));
  }
  return fetchV0(forge, res, repo, packets);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(forge: Forge, req: HttpRequest, res: HttpResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  let unpackOk = true;
  let unpackDetail = '';
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasPack && rest.length > 0) {
    try {
      readPackInto(forge, rest);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail || 'error'}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const problem = applyPushCommand(forge, repo, command);
    reportLines.push(problem === null ? `ok ${command.ref}` : `ng ${command.ref} ${problem}`);
  }
  // The report is a pkt-line stream carried inside sideband band 1.
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: unpacking\n', 'utf8')]))];
  for (const line of reportLines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])));
  }
  parts.push(pktLine(Buffer.concat([Buffer.from([1]), PKT_FLUSH])), PKT_FLUSH);
  return sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** Validate and apply one push command; a problem string refuses just this ref. */
function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  const target = forge.getObject(command.newOid);
  if (target === undefined) return 'object not found';
  if (command.ref.startsWith('refs/heads/')) {
    const commit = forge.peelToCommit(command.newOid);
    if (commit === null) return 'object is not a commit';
    if (current !== ZERO_OID && command.oldOid !== ZERO_OID) {
      const currentCommit = forge.peelToCommit(current);
      if (currentCommit !== null && !forge.isAncestor(currentCommit, commit)) return 'non-fast-forward';
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/**
 * Serve one git smart-HTTP request. `segments` are the decoded path segments:
 * [owner, "<name>.git", ...]. Returns false when the path is not a git path.
 */
export async function handleGit(forge: Forge, req: HttpRequest, res: HttpResponse, url: URL, segments: string[]): Promise<boolean> {
  if (segments.length < 3) return false;
  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return false;
  const name = repoSegment.slice(0, -4);
  const tail = segments.slice(2);

  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const repo = forge.repos.get(name);
  if (repo === undefined || !forge.ownerMatches(owner)) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  forge.adoptLogin(owner);

  const method = req.method ?? 'GET';
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Unknown service');
      return true;
    }
    infoRefs(forge, res, repo, service, req.headers['git-protocol']);
    return true;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    await uploadPack(forge, req, res, repo);
    return true;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    await receivePack(forge, req, res, repo);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
