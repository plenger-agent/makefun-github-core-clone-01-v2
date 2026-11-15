// Entry point: the boot handshake between the forge and the harness beside it.
//
// The harness runs an env service and hands us its origin through
// MAKEFUN_ENV_URL. Everything here is in service of that handshake: grab a
// kernel-chosen port for the real server (app.ts), report the port back to
// the env, then idle until the env declares the run finished, close down and
// exit 0. With no env origin there is nobody to handshake with, so bail out
// immediately.

import { once } from 'node:events';
import { createApp } from './app.ts';

const harnessBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (harnessBase.length === 0) {
  console.error('MAKEFUN_ENV_URL missing: no env to register with, exiting.');
  process.exit(1);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call the env, retrying through transient refusals with a growing gap: at
// boot the env can lag a breath behind us, so early attempts may not land.
async function retrying<T>(operation: () => Promise<T>, maxAttempts: number): Promise<T> {
  let delayMs = 120;
  let lastFailure: unknown = new Error('no attempt was made');
  for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo += 1) {
    try {
      return await operation();
    } catch (err) {
      lastFailure = err;
      if (attemptNo + 1 < maxAttempts) await waitMs(delayMs);
      delayMs = Math.min(delayMs * 2, 1500);
    }
  }
  throw lastFailure;
}

async function reportPortToEnv(boundPort: number): Promise<void> {
  const reply = await fetch(harnessBase + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: boundPort }),
  });
  await reply.text().catch(() => '');
  // A 409 means an earlier attempt got there first and the env kept that
  // registration — exactly the outcome we want, not an error.
  if (!reply.ok && reply.status !== 409) {
    throw new Error('register replied with status ' + reply.status);
  }
}

async function envSaysDone(): Promise<boolean> {
  const reply = await fetch(harnessBase + '/done');
  if (!reply.ok) {
    throw new Error('done replied with status ' + reply.status);
  }
  const body = (await reply.json()) as { done?: unknown };
  return body.done === true;
}

const app = createApp();
app.listen(0);
await once(app, 'listening');

const addressInfo = app.address();
if (addressInfo === null || typeof addressInfo !== 'object') {
  console.error('the server did not end up on a TCP port; exiting.');
  process.exit(1);
}

await retrying(() => reportPortToEnv(addressInfo.port), 12);

// Poll for the env's completion signal, stretching the gap a little after
// each round so a long run does not hammer the env. A failed poll counts as
// "not finished": walking away early would forfeit the whole run.
let done = false;
let pollGap = 200;
while (!done) {
  try {
    done = await envSaysDone();
  } catch {
    done = false;
  }
  if (!done) {
    await waitMs(pollGap);
    pollGap = Math.min(pollGap + 100, 1000);
  }
}

// Close, but never let a client parked on an idle keep-alive socket stall
// the exit: the run is over either way, so cap the wait and leave regardless.
await Promise.race([
  new Promise<void>((resolve) => {
    app.close(() => resolve());
  }),
  waitMs(3000),
]);
process.exit(0);
