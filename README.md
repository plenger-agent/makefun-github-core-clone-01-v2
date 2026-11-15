# Plenger Forge — github-core-clone-01, v2

A from-scratch GitHub core in one dependency-free TypeScript program: git smart HTTP (protocol v0
and v2: advertisements, ls-refs, fetch, receive-pack with fast-forward enforcement), the REST v3
resources (repos, issues, pulls, contents, git data, reviews), GraphQL v4, and an MCP endpoint —
all over one shared, deterministic, content-addressed in-memory store. State is a pure function of
the request sequence: sequence-based timestamps and counters, no wall clock, no randomness in any
response body.

## What v2 changes

The conformance surface is v1's, unchanged. The work is all in how answers are served:

- **Raw-socket HTTP transport** (`server.ts`) instead of `node:http`: request parsing, keep-alive
  dispatch and response framing directly on `node:net` sockets, one write per response,
  TCP_NODELAY. The request/response objects are duck-typed to the slice of the `node:http`
  surface the handlers use.
- **GET response cache** (`app.ts`): GET answers are keyed by URL + authorization + git-protocol
  + accept + adopted login and replayed byte for byte (with a fresh request id). Any non-GET
  request clears the cache before it runs, so a replay can never outlive the state it came from.
- **Git answer caches** (`gitproto.ts`): fetch packs (v0 and v2) and ls-refs answers are cached
  by their exact inputs plus a store fingerprint. The store is append-only and content-addressed,
  so a fixed want/have/shallow/depth set can only ever produce one pack — the clone workload's
  fifty identical depth-1 fetches are built once. The v2 capability advertisement is a constant,
  built once at startup.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` owns the entry ↔ env lifecycle: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`,
poll `$MAKEFUN_ENV_URL/done`, close and exit 0. No dependencies, no build step; Node ≥ 22.18
strips the types natively.

## Layout

- `main.ts` — the env handshake lifecycle.
- `app.ts` — routing across the four surfaces, plus the GET response cache.
- `server.ts` — the raw-socket HTTP/1.1 transport.
- `store.ts` — the Forge: object store, repos, issues, pulls, deterministic ids and timestamps.
- `gitproto.ts` — pkt-lines, pack read/write with delta resolution, advertisements, fetch, push.
- `rest.ts` / `graphql.ts` / `mcp.ts` — the REST v3, GraphQL v4 and MCP surfaces.
- `web.ts` — the small request/response helpers every surface shares.
