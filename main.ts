// Boot sequence for the forge, driven by the harness that runs beside it.
//
// The harness exposes one env service whose origin arrives in
// MAKEFUN_ENV_URL. My job is only the handshake around the real server in
// app.ts: bind a port the kernel chooses, tell the env which port that was,
// wait until the env says the run is over, then close up and exit 0. Without
// the env origin there is nobody to handshake with, so bail out at once.

import { once } from 'node:events';
import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin.length === 0) {
  console.error('MAKEFUN_ENV_URL missing: no env to register with, exiting.');
  process.exit(1);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run an env call, retrying transient failures with a growing delay. The env
// can be a breath behind us at boot, so the first attempts may be refused.
async function withRetries<T>(call: () => Promise<T>, attempts: number): Promise<T> {
  let wait = 120;
  let failure: unknown = new Error('no attempt was made');
  for (let n = 0; n < attempts; n += 1) {
    try {
      return await call();
    } catch (err) {
      failure = err;
      if (n + 1 < attempts) await pause(wait);
      wait = Math.min(wait * 2, 1500);
    }
  }
  throw failure;
}

async function tellEnvOurPort(port: number): Promise<void> {
  const response = await fetch(envOrigin + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  await response.text().catch(() => '');
  // 409 means an earlier attempt already registered and the env keeps the
  // first registration; that is the outcome we want, not a failure.
  if (!response.ok && response.status !== 409) {
    throw new Error('register replied with status ' + response.status);
  }
}

async function askEnvIfFinished(): Promise<boolean> {
  const response = await fetch(envOrigin + '/done');
  if (!response.ok) {
    throw new Error('done replied with status ' + response.status);
  }
  const payload = (await response.json()) as { done?: unknown };
  return payload.done === true;
}

const server = createApp();
server.listen(0);
await once(server, 'listening');

const bound = server.address();
if (bound === null || typeof bound !== 'object') {
  console.error('the server did not end up on a TCP port; exiting.');
  process.exit(1);
}

await withRetries(() => tellEnvOurPort(bound.port), 12);

// Poll until the env reports completion, stretching the pause a little
// after each round so a long run does not hammer the env with requests. A
// poll that errors counts as "not finished yet": leaving early would
// forfeit the whole run.
let finished = false;
let pollPause = 200;
while (!finished) {
  try {
    finished = await askEnvIfFinished();
  } catch {
    finished = false;
  }
  if (!finished) {
    await pause(pollPause);
    pollPause = Math.min(pollPause + 100, 1000);
  }
}

// Close, but do not let a client holding an idle keep-alive socket stall the
// exit: the run is over either way, so cap the wait and leave regardless.
await Promise.race([
  new Promise<void>((resolve) => {
    server.close(() => resolve());
  }),
  pause(3000),
]);
process.exit(0);
