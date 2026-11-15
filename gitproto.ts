// Git smart HTTP: the info/refs advertisements (protocol v2 and v0), v2
// ls-refs and fetch, v0 fetch, and v0 receive-pack with report-status. The
// suite's client speaks the wire protocol in-process, so this module
// implements the protocol itself: pkt-line framing, pack v2 reading (with
// delta resolution) and writing (plain objects — always valid),
// shallow/deepen bookkeeping, and per-ref fast-forward enforcement on push.
//
// Everything is served from the shared Forge store: objects pushed here are
// the objects the REST contents API and clones see.
//
// v2 adds two caches on top of v1, both sound because the object store is
// content-addressed and append-only (objects are never mutated or deleted,
// so the reachable closure of a fixed oid set can never change):
//   - fetch answers (v0 and v2) are cached by the exact inputs the plan
//     depends on — wants, haves, the client's shallow set and depth — plus
//     a store fingerprint (object count and this repo's ref tips). The
//     clone workload asks fifty times for the same depth-1 pack; it is
//     built once.
//   - ls-refs answers are cached by their flags/prefixes plus the same ref
//     fingerprint.
// The v2 capability advertisement carries no per-repo data at all, so it is
// built once, up front.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Forge, ZERO_OID, parseCommit, parseTag, type GitObj, type ObjType, type Repo } from './store.ts';
import { isAuthenticated, readBody, sendBytes, sendError } from './web.ts';
import type { HttpRequest, HttpResponse } from './server.ts';

const AGENT = 'plenger-forge/1.0.0';
const TYPE_TO_ID: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

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
  const frames: Packet[] = [];
  let pos = offset;
  while (pos + 4 <= data.length) {
    const hexText = data.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hexText)) break;
    const frameLen = Number.parseInt(hexText, 16);
    if (frameLen === 0) {
      frames.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (frameLen === 1) {
      frames.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (frameLen === 2) {
      pos += 4;
      continue;
    }
    if (frameLen < 4 || pos + frameLen > data.length) break;
    frames.push({ kind: 'data', payload: data.subarray(pos + 4, pos + frameLen) });
    pos += frameLen;
  }
  return { packets: frames, rest: data.subarray(pos) };
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

/** Serialize objects into a pack v2 (plain entries, zlib-deflated) with its SHA-1 trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const chunks: Buffer[] = [];
  const packHeader = Buffer.alloc(12);
  packHeader.write('PACK', 0, 'ascii');
  packHeader.writeUInt32BE(2, 4);
  packHeader.writeUInt32BE(objects.length, 8);
  chunks.push(packHeader);
  for (const obj of objects) {
    const dataLen = obj.data.length;
    const tid = TYPE_TO_ID[obj.type];
    const headBytes: number[] = [];
    let lead = (tid << 4) | (dataLen & 0x0f);
    let remaining = dataLen >> 4;
    if (remaining > 0) lead |= 0x80;
    headBytes.push(lead);
    while (remaining > 0) {
      let chunkByte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) chunkByte |= 0x80;
      headBytes.push(chunkByte);
    }
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflateSync(obj.data));
  }
  const packBody = Buffer.concat(chunks);
  const checksum = createHash('sha1').update(packBody).digest();
  return Buffer.concat([packBody, checksum]);
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let acc = 0;
    let shiftBits = 0;
    for (;;) {
      const rawByte = delta[pos]!;
      pos += 1;
      acc |= (rawByte & 0x7f) << shiftBits;
      shiftBits += 7;
      if ((rawByte & 0x80) === 0) break;
    }
    return acc;
  };
  readSize(); // base size
  const expectedSize = readSize();
  const pieces: Buffer[] = [];
  let emitted = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if (opcode & 0x80) {
      let srcOffset = 0;
      let srcSize = 0;
      for (let bitIndex = 0; bitIndex < 4; bitIndex += 1) {
        if (opcode & (1 << bitIndex)) {
          srcOffset |= delta[pos]! << (8 * bitIndex);
          pos += 1;
        }
      }
      for (let bitIndex = 0; bitIndex < 3; bitIndex += 1) {
        if (opcode & (0x10 << bitIndex)) {
          srcSize |= delta[pos]! << (8 * bitIndex);
          pos += 1;
        }
      }
      if (srcSize === 0) srcSize = 0x10000;
      pieces.push(base.subarray(srcOffset, srcOffset + srcSize));
      emitted += srcSize;
    } else if (opcode > 0) {
      pieces.push(delta.subarray(pos, pos + opcode));
      emitted += opcode;
      pos += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const assembled = Buffer.concat(pieces);
  if (assembled.length !== expectedSize || emitted !== expectedSize) throw new Error('delta size mismatch');
  return assembled;
}

/**
 * Parse a received pack into the store. Entries may be plain or
 * delta-compressed (OFS/REF); thin-pack bases are looked up in the store.
 * Throws on structural corruption.
 */
export function readPackInto(forge: Forge, packBytes: Buffer): void {
  if (packBytes.length < 12 + 20) throw new Error('pack too short');
  if (packBytes.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const entryCount = packBytes.readUInt32BE(8);
  let pos = 12;
  interface PackEntry {
    type: ObjType;
    data?: Buffer;
    baseOid?: string;
    baseOffset?: number;
    start: number;
  }
  const rawEntries: PackEntry[] = [];
  const indexByStart = new Map<number, number>();
  for (let i = 0; i < entryCount; i += 1) {
    const entryStart = pos;
    let leadByte = packBytes[pos]!;
    pos += 1;
    const tid = (leadByte >> 4) & 0x7;
    let dataSize = leadByte & 0x0f;
    let shiftBits = 4;
    while (leadByte & 0x80) {
      leadByte = packBytes[pos]!;
      pos += 1;
      dataSize |= (leadByte & 0x7f) << shiftBits;
      shiftBits += 7;
    }
    const raw: PackEntry = { type: ID_TO_TYPE[tid] ?? 'blob', start: entryStart };
    if (tid === 6) {
      // OFS_DELTA
      let backByte = packBytes[pos]!;
      pos += 1;
      let backDist = backByte & 0x7f;
      while (backByte & 0x80) {
        backByte = packBytes[pos]!;
        pos += 1;
        backDist = ((backDist + 1) << 7) | (backByte & 0x7f);
      }
      raw.baseOffset = entryStart - backDist;
      raw.type = 'blob'; // resolved below
    } else if (tid === 7) {
      // REF_DELTA
      raw.baseOid = packBytes.toString('hex', pos, pos + 20);
      pos += 20;
      raw.type = 'blob'; // resolved below
    } else {
      const plainBytes = inflateSync(packBytes.subarray(pos));
      if (plainBytes.length !== dataSize) throw new Error('pack entry size mismatch');
      raw.data = plainBytes;
      pos += compressedLength(packBytes, pos, plainBytes.length);
    }
    if (raw.baseOid !== undefined || raw.baseOffset !== undefined) {
      const deltaBytes = inflateSync(packBytes.subarray(pos));
      raw.data = deltaBytes; // the delta bytes, for now
      pos += compressedLength(packBytes, pos, deltaBytes.length);
      // stash delta bytes in `data` and mark via base fields; resolved in pass two
      rawEntries.push(raw);
      indexByStart.set(entryStart, rawEntries.length - 1);
      continue;
    }
    rawEntries.push(raw);
    indexByStart.set(entryStart, rawEntries.length - 1);
  }
  // Pass two: resolve deltas (bases may themselves be deltas).
  const resolvedEntries = new Map<number, { type: ObjType; data: Buffer }>();
  const resolveEntry = (index: number): { type: ObjType; data: Buffer } => {
    const memo = resolvedEntries.get(index);
    if (memo !== undefined) return memo;
    const raw = rawEntries[index]!;
    let outcome: { type: ObjType; data: Buffer };
    if (raw.baseOid === undefined && raw.baseOffset === undefined) {
      outcome = { type: raw.type, data: raw.data! };
    } else {
      let baseObj: { type: ObjType; data: Buffer };
      if (raw.baseOid !== undefined) {
        const storedBase = forge.getObject(raw.baseOid);
        if (storedBase === undefined) throw new Error('thin pack base is missing');
        baseObj = storedBase;
      } else {
        const baseIdx = indexByStart.get(raw.baseOffset!);
        if (baseIdx === undefined) throw new Error('ofs delta base is missing');
        baseObj = resolveEntry(baseIdx);
      }
      outcome = { type: baseObj.type, data: applyDelta(baseObj.data, raw.data!) };
    }
    resolvedEntries.set(index, outcome);
    return outcome;
  };
  for (let i = 0; i < rawEntries.length; i += 1) {
    const finalObj = resolveEntry(i);
    forge.putObject(finalObj.type, finalObj.data);
  }
}

/**
 * The number of compressed bytes an entry occupies in the pack. zlib streams
 * are self-terminating and Node's inflateSync tolerates trailing bytes, so
 * "a prefix inflates to the full payload" is monotone in the prefix length:
 * bracket the length exponentially, then binary-search inside the bracket,
 * keeping the total re-inflation work within a small multiple of the
 * entry's own size.
 */
function compressedLength(packBytes: Buffer, startAt: number, plainLen: number): number {
  const bytesLeft = packBytes.length - startAt;
  const tryInflate = (length: number): boolean => {
    try {
      return inflateSync(packBytes.subarray(startAt, startAt + length)).length === plainLen;
    } catch {
      return false;
    }
  };
  let lo = 0; // known to fail (or the empty prefix)
  let hi = Math.min(bytesLeft, 1024);
  while (!tryInflate(hi)) {
    lo = hi;
    if (hi >= bytesLeft) return bytesLeft;
    hi = Math.min(bytesLeft, hi * 4);
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (tryInflate(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------------------------

function refsInOrder(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function uploadCapsV0(forge: Forge, repo: Repo): string {
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

function receiveCaps(forge: Forge, repo: Repo): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`, `symref=HEAD:${forge.headRef(repo)}`].join(' ');
}

/** Ref lines for a v0 advertisement: HEAD first (carrying the capabilities), then refs with peels. */
function v0RefLines(forge: Forge, repo: Repo, capText: string): Buffer[] {
  const headName = forge.headRef(repo);
  const headOid = repo.refs.get(headName);
  const outLines: Buffer[] = [];
  if (headOid === undefined && repo.refs.size === 0) {
    outLines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capText}\n`));
    return outLines;
  }
  if (headOid !== undefined) {
    outLines.push(pktLine(`${headOid} HEAD\0${capText}\n`));
  } else {
    const firstRef = refsInOrder(repo)[0];
    if (firstRef !== undefined) outLines.push(pktLine(`${firstRef[1]} ${firstRef[0]}\0${capText}\n`));
  }
  for (const [refName, oidHex] of refsInOrder(repo)) {
    if (headOid === undefined && outLines.length === 1 && refName === refsInOrder(repo)[0]![0]) continue;
    outLines.push(pktLine(`${oidHex} ${refName}\n`));
    if (refName.startsWith('refs/tags/')) {
      const peeledOid = forge.peelToCommit(oidHex);
      if (peeledOid !== null && peeledOid !== oidHex) outLines.push(pktLine(`${peeledOid} ${refName}^{}\n`));
    }
  }
  return outLines;
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

function infoRefs(forge: Forge, res: HttpResponse, repo: Repo, serviceName: string, protocolValue: string | undefined): void {
  const forUpload = serviceName === 'git-upload-pack';
  const useV2 = forUpload && protocolValue !== undefined && protocolValue.includes('version=2');
  if (useV2) {
    return sendBytes(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
  }
  const banner = pktLine(`# service=${serviceName}\n`);
  const capText = forUpload ? uploadCapsV0(forge, repo) : receiveCaps(forge, repo);
  const payload = Buffer.concat([banner, PKT_FLUSH, ...v0RefLines(forge, repo, capText), PKT_FLUSH]);
  return sendBytes(res, 200, payload, forUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
}

// ---------------------------------------------------------------------------------------------
// answer caches (fetch and ls-refs)
// ---------------------------------------------------------------------------------------------

const ANSWER_CACHE_MAX = 512;
const cachesByForge = new WeakMap<Forge, Map<string, Buffer>>();

function cacheFor(forge: Forge): Map<string, Buffer> {
  let store = cachesByForge.get(forge);
  if (store === undefined) {
    store = new Map();
    cachesByForge.set(forge, store);
  }
  return store;
}

function storeAnswer(forge: Forge, key: string, body: Buffer): void {
  const store = cacheFor(forge);
  if (store.size >= ANSWER_CACHE_MAX) store.clear();
  store.set(key, body);
}

/** A fingerprint of everything outside a request's own fields that an answer may depend on. */
function stateFingerprint(forge: Forge, repo: Repo): string {
  const refList = refsInOrder(repo)
    .map(([refName, oidHex]) => `${refName}=${oidHex}`)
    .join(',');
  return `${forge.objects.size}|${forge.headRef(repo)}|${refList}`;
}

function makeAnswerKey(forge: Forge, repo: Repo, keyParts: readonly string[]): string {
  return createHash('sha1').update(keyParts.join('\n')).update('\n').update(stateFingerprint(forge, repo)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

function lsRefs(forge: Forge, res: HttpResponse, repo: Repo, packets: Packet[]): void {
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  const refPrefixes: string[] = [];
  for (const frame of packets) {
    if (frame.kind !== 'data') continue;
    const lineText = frame.payload.toString('utf8').replace(/\n$/, '');
    if (lineText === 'peel') wantPeel = true;
    else if (lineText === 'symrefs') wantSymrefs = true;
    else if (lineText === 'unborn') wantUnborn = true;
    else if (lineText.startsWith('ref-prefix ')) refPrefixes.push(lineText.slice('ref-prefix '.length));
  }
  const cacheId = makeAnswerKey(forge, repo, ['ls-refs', String(wantPeel), String(wantSymrefs), String(wantUnborn), ...refPrefixes]);
  const hit = cacheFor(forge).get(cacheId);
  if (hit !== undefined) {
    return sendBytes(res, 200, hit, 'application/x-git-upload-pack-result');
  }
  const nameMatches = (name: string): boolean => refPrefixes.length === 0 || refPrefixes.some((prefix) => name.startsWith(prefix));
  const outLines: Buffer[] = [];
  const headName = forge.headRef(repo);
  const headOid = repo.refs.get(headName);
  if (nameMatches('HEAD')) {
    if (headOid !== undefined) {
      outLines.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headName}` : ''}\n`));
    } else if (wantUnborn) {
      outLines.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${headName}` : ''}\n`));
    }
  }
  for (const [refName, oidHex] of refsInOrder(repo)) {
    if (!nameMatches(refName)) continue;
    let peelSuffix = '';
    if (wantPeel && refName.startsWith('refs/tags/')) {
      const peeledOid = forge.peelToCommit(oidHex);
      if (peeledOid !== null && peeledOid !== oidHex) peelSuffix = ` peeled:${peeledOid}`;
    }
    outLines.push(pktLine(`${oidHex} ${refName}${peelSuffix}\n`));
  }
  const payload = Buffer.concat([...outLines, PKT_FLUSH]);
  storeAnswer(forge, cacheId, payload);
  return sendBytes(res, 200, payload, 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to put in the pack. */
  objects: GitObj[];
  /** Commits to report as the (new) shallow boundary. */
  shallowTips: string[];
  /** Commits to report as no longer shallow. */
  lifted: string[];
}

/**
 * Work out what a fetch transfers. Commit distance is measured from the
 * wants (through tags); `depthLimit` bounds it. Exclusion is depth-aware
 * for shallow clients: a have the client holds as a shallow boundary
 * excludes only itself and its trees, never its parents.
 */
function planFetch(forge: Forge, wantOids: string[], haveOids: string[], shallowSet: ReadonlySet<string>, depthLimit: number | null): FetchPlan {
  const chosen = new Set<string>();
  const levelOf = new Map<string, number>();
  // Breadth-first by commit level; tags and trees ride along with their commit.
  const includeTreeOf = (treeOid: string): void => {
    const pending = [treeOid];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (chosen.has(current)) continue;
      const obj = forge.getObject(current);
      if (obj === undefined) continue;
      chosen.add(current);
      if (obj.type === 'tree') {
        for (const row of treeEntryOids(forge, current)) pending.push(row.oid);
      }
    }
  };
  const frontier: Array<{ oid: string; level: number }> = [];
  for (const wantOid of wantOids) frontier.push({ oid: wantOid, level: 0 });
  while (frontier.length > 0) {
    const { oid: current, level } = frontier.shift()!;
    const obj = forge.getObject(current);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      chosen.add(current);
      frontier.push({ oid: parseTag(obj.data).object, level });
      continue;
    }
    if (obj.type !== 'commit') continue;
    const priorLevel = levelOf.get(current);
    if (priorLevel !== undefined && priorLevel <= level) continue;
    levelOf.set(current, level);
    if (depthLimit !== null && level >= depthLimit) continue;
    chosen.add(current);
    const info = parseCommit(obj.data);
    includeTreeOf(info.tree);
    for (const parentOid of info.parents) frontier.push({ oid: parentOid, level: level + 1 });
  }
  // Shallow boundary: included commits with a parent that is not included.
  const boundary: string[] = [];
  if (depthLimit !== null) {
    for (const oidHex of chosen) {
      const obj = forge.getObject(oidHex)!;
      if (obj.type !== 'commit') continue;
      const parentOids = parseCommit(obj.data).parents;
      if (parentOids.some((parentOid) => !chosen.has(parentOid))) boundary.push(oidHex);
    }
  }
  // Exclusions.
  const withheld = new Set<string>();
  for (const haveOid of haveOids) {
    if (depthLimit !== null && shallowSet.has(haveOid)) {
      withheld.add(haveOid);
      const obj = forge.getObject(haveOid);
      if (obj !== undefined && obj.type === 'commit') {
        const pending = [parseCommit(obj.data).tree];
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (withheld.has(current)) continue;
          const nodeObj = forge.getObject(current);
          if (nodeObj === undefined) continue;
          withheld.add(current);
          if (nodeObj.type === 'tree') for (const childRow of treeEntryOids(forge, current)) pending.push(childRow.oid);
        }
      }
    } else {
      for (const oidHex of forge.reachable([haveOid])) withheld.add(oidHex);
    }
  }
  const lifted: string[] = [];
  if (depthLimit !== null) {
    for (const oidHex of shallowSet) {
      if (chosen.has(oidHex) && !boundary.includes(oidHex)) lifted.push(oidHex);
    }
  }
  const objects: GitObj[] = [];
  for (const oidHex of chosen) {
    if (withheld.has(oidHex)) continue;
    const obj = forge.getObject(oidHex);
    if (obj !== undefined) objects.push(obj);
  }
  return { objects, shallowTips: boundary, lifted };
}

function treeEntryOids(forge: Forge, treeOid: string): Array<{ oid: string }> {
  const obj = forge.getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  // Local import indirection avoided: parse entries inline via store's parser.
  return scanTreeOids(obj.data);
}

function scanTreeOids(data: Buffer): Array<{ oid: string }> {
  const rows: Array<{ oid: string }> = [];
  let pos = 0;
  while (pos < data.length) {
    const spaceAt = data.indexOf(0x20, pos);
    const nulAt = data.indexOf(0x00, spaceAt);
    rows.push({ oid: data.toString('hex', nulAt + 1, nulAt + 21) });
    pos = nulAt + 21;
  }
  return rows;
}

/** Frame pack bytes as sideband-64k packets (band 1), with one band-2 progress note first. */
function sidebandPackets(packBytes: Buffer): Buffer[] {
  const frames: Buffer[] = [pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: sending objects\n', 'utf8')]))];
  const CHUNK_SIZE = 32_000;
  for (let pos = 0; pos < packBytes.length; pos += CHUNK_SIZE) {
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), packBytes.subarray(pos, pos + CHUNK_SIZE)])));
  }
  if (packBytes.length === 0) frames.push(pktLine(Buffer.from([1])));
  return frames;
}

interface FetchAsk {
  wantOids: string[];
  haveOids: string[];
  shallowSet: Set<string>;
  depthLimit: number | null;
}

/** Parse the ask lines shared by the v0 and v2 fetch commands. */
function parseFetchAsk(packets: Packet[], v2: boolean): FetchAsk {
  const wantOids: string[] = [];
  const haveOids: string[] = [];
  const shallowSet = new Set<string>();
  let depthLimit: number | null = null;
  for (const frame of packets) {
    if (frame.kind !== 'data') continue;
    const lineText = frame.payload.toString('utf8').replace(/\n$/, '');
    if (lineText.startsWith('want ')) wantOids.push(v2 ? lineText.slice(5).trim() : lineText.slice(5).trim().split(' ')[0]!);
    else if (lineText.startsWith('have ')) haveOids.push(lineText.slice(5).trim());
    else if (lineText.startsWith('shallow ')) shallowSet.add(lineText.slice(8).trim());
    else if (lineText.startsWith('deepen ')) depthLimit = Number.parseInt(lineText.slice(7).trim(), 10);
  }
  return { wantOids, haveOids, shallowSet, depthLimit };
}

function fetchKey(forge: Forge, repo: Repo, variant: string, ask: FetchAsk): string {
  return makeAnswerKey(forge, repo, [
    variant,
    `w:${[...ask.wantOids].sort().join(',')}`,
    `h:${[...ask.haveOids].sort().join(',')}`,
    `s:${[...ask.shallowSet].sort().join(',')}`,
    `d:${ask.depthLimit === null ? '' : ask.depthLimit}`,
  ]);
}

function fetchV2(forge: Forge, res: HttpResponse, repo: Repo, packets: Packet[]): void {
  const request = parseFetchAsk(packets, true);
  const cacheId = fetchKey(forge, repo, 'fetch-v2', request);
  const hit = cacheFor(forge).get(cacheId);
  if (hit !== undefined) {
    return sendBytes(res, 200, hit, 'application/x-git-upload-pack-result');
  }
  const planResult = planFetch(forge, request.wantOids, request.haveOids, request.shallowSet, request.depthLimit);
  const packBytes = writePack(planResult.objects);
  const sections: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
  if (request.depthLimit !== null) {
    sections.push(pktLine('shallow-info\n'));
    for (const oidHex of planResult.shallowTips) sections.push(pktLine(`shallow ${oidHex}\n`));
    for (const oidHex of planResult.lifted) sections.push(pktLine(`unshallow ${oidHex}\n`));
    sections.push(PKT_FLUSH);
  }
  sections.push(pktLine('packfile\n'), ...sidebandPackets(packBytes), PKT_FLUSH);
  const payload = Buffer.concat(sections);
  storeAnswer(forge, cacheId, payload);
  return sendBytes(res, 200, payload, 'application/x-git-upload-pack-result');
}

function fetchV0(forge: Forge, res: HttpResponse, repo: Repo, packets: Packet[]): void {
  const request = parseFetchAsk(packets, false);
  const cacheId = fetchKey(forge, repo, 'fetch-v0', request);
  const hit = cacheFor(forge).get(cacheId);
  if (hit !== undefined) {
    return sendBytes(res, 200, hit, 'application/x-git-upload-pack-result');
  }
  const planResult = planFetch(forge, request.wantOids, request.haveOids, request.shallowSet, request.depthLimit);
  const packBytes = writePack(planResult.objects);
  const sections: Buffer[] = [];
  if (request.depthLimit !== null) {
    for (const oidHex of planResult.shallowTips) sections.push(pktLine(`shallow ${oidHex}\n`));
    for (const oidHex of planResult.lifted) sections.push(pktLine(`unshallow ${oidHex}\n`));
  }
  sections.push(pktLine('NAK\n'), ...sidebandPackets(packBytes), PKT_FLUSH);
  const payload = Buffer.concat(sections);
  storeAnswer(forge, cacheId, payload);
  return sendBytes(res, 200, payload, 'application/x-git-upload-pack-result');
}

async function uploadPack(forge: Forge, req: HttpRequest, res: HttpResponse, repo: Repo): Promise<void> {
  const rawBody = await readBody(req);
  const { packets: frames } = decodePackets(rawBody);
  const leadFrame = frames.find((frame) => frame.kind === 'data');
  const leadLine = leadFrame === undefined ? '' : leadFrame.payload.toString('utf8');
  if (leadLine.startsWith('command=ls-refs')) {
    // The ls-refs arguments follow the delim packet.
    const delimAt = frames.findIndex((frame) => frame.kind === 'delim');
    return lsRefs(forge, res, repo, delimAt === -1 ? frames : frames.slice(delimAt + 1));
  }
  if (leadLine.startsWith('command=fetch')) {
    const delimAt = frames.findIndex((frame) => frame.kind === 'delim');
    return fetchV2(forge, res, repo, delimAt === -1 ? frames : frames.slice(delimAt + 1));
  }
  return fetchV0(forge, res, repo, frames);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  beforeOid: string;
  afterOid: string;
  refName: string;
}

async function receivePack(forge: Forge, req: HttpRequest, res: HttpResponse, repo: Repo): Promise<void> {
  const rawBody = await readBody(req);
  const { packets: frames, rest: restBytes } = decodePackets(rawBody);
  const pushCmds: PushCommand[] = [];
  for (const frame of frames) {
    if (frame.kind === 'flush') break;
    if (frame.kind !== 'data') continue;
    let lineText = frame.payload.toString('utf8').replace(/\n$/, '');
    const nulAt = lineText.indexOf('\0');
    if (nulAt !== -1) lineText = lineText.slice(0, nulAt);
    const fields = lineText.split(' ');
    if (fields.length >= 3) pushCmds.push({ beforeOid: fields[0]!, afterOid: fields[1]!, refName: fields.slice(2).join(' ') });
  }
  let unpacked = true;
  let unpackProblem = '';
  const packPresent = pushCmds.some((cmd) => cmd.afterOid !== ZERO_OID);
  if (packPresent && restBytes.length > 0) {
    try {
      readPackInto(forge, restBytes);
    } catch (err) {
      unpacked = false;
      unpackProblem = err instanceof Error ? err.message : String(err);
    }
  }
  const report: string[] = [unpacked ? 'unpack ok' : `unpack ${unpackProblem || 'error'}`];
  for (const cmd of pushCmds) {
    if (!unpacked) {
      report.push(`ng ${cmd.refName} unpack failed`);
      continue;
    }
    const problem = applyPushCommand(forge, repo, cmd);
    report.push(problem === null ? `ok ${cmd.refName}` : `ng ${cmd.refName} ${problem}`);
  }
  // The report is a pkt-line stream carried inside sideband band 1.
  const bandFrames: Buffer[] = [pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: unpacking\n', 'utf8')]))];
  for (const lineText of report) {
    bandFrames.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${lineText}\n`)])));
  }
  bandFrames.push(pktLine(Buffer.concat([Buffer.from([1]), PKT_FLUSH])), PKT_FLUSH);
  return sendBytes(res, 200, Buffer.concat(bandFrames), 'application/x-git-receive-pack-result');
}

/** Validate and apply one push command; a problem string refuses just this ref. */
function applyPushCommand(forge: Forge, repo: Repo, cmd: PushCommand): string | null {
  const currentOid = repo.refs.get(cmd.refName) ?? ZERO_OID;
  if (cmd.afterOid === ZERO_OID) {
    repo.refs.delete(cmd.refName);
    return null;
  }
  const targetObj = forge.getObject(cmd.afterOid);
  if (targetObj === undefined) return 'object not found';
  if (cmd.refName.startsWith('refs/heads/')) {
    const commitOid = forge.peelToCommit(cmd.afterOid);
    if (commitOid === null) return 'object is not a commit';
    if (currentOid !== ZERO_OID && cmd.beforeOid !== ZERO_OID) {
      const currentTip = forge.peelToCommit(currentOid);
      if (currentTip !== null && !forge.isAncestor(currentTip, commitOid)) return 'non-fast-forward';
    }
  }
  repo.refs.set(cmd.refName, cmd.afterOid);
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
  const ownerName = segments[0]!;
  const repoSeg = segments[1]!;
  if (!repoSeg.endsWith('.git')) return false;
  const repoName = repoSeg.slice(0, -4);
  const tailSegs = segments.slice(2);

  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const foundRepo = forge.repos.get(repoName);
  if (foundRepo === undefined || !forge.ownerMatches(ownerName)) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  forge.adoptLogin(ownerName);

  const verb = req.method ?? 'GET';
  if (verb === 'GET' && tailSegs.length === 2 && tailSegs[0] === 'info' && tailSegs[1] === 'refs') {
    const serviceName = url.searchParams.get('service') ?? '';
    if (serviceName !== 'git-upload-pack' && serviceName !== 'git-receive-pack') {
      sendError(res, 400, 'Unknown service');
      return true;
    }
    infoRefs(forge, res, foundRepo, serviceName, req.headers['git-protocol']);
    return true;
  }
  if (verb === 'POST' && tailSegs.length === 1 && tailSegs[0] === 'git-upload-pack') {
    await uploadPack(forge, req, res, foundRepo);
    return true;
  }
  if (verb === 'POST' && tailSegs.length === 1 && tailSegs[0] === 'git-receive-pack') {
    await receivePack(forge, req, res, foundRepo);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
