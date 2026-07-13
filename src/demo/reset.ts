import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { col } from '../db';
import { evictAll, evictUser } from '../decide';
import { clearUsageDedup } from '../usage';
import { seedDemo } from './seed';

// The demo auto-reset lifecycle. State machine (module-level — safe because the
// demo runs as a single `server-all` process serving both the public and verify
// ports):
//
//   idle (resetAtMs=null)
//     --first sign-in after a reset → armReset()-->  armed (resetAtMs set, timer)
//     (further sign-ins while armed: ignored — the window does NOT extend)
//   armed --timer fires--> performReset() --> idle
//
// Boot calls performReset() directly (state starts idle and returns to idle), so a
// container restart always comes up in the canonical seed — equivalent to a reset.

let resetAtMs: number | null = null;
let timer: NodeJS.Timeout | null = null;
let resetting = false;

// All collections that hold mutable state — wiped on reset, then reseeded.
// Sessions lead so a request arriving mid-wipe loses its identity first and falls
// through to the login picker rather than acting on soon-to-be-gone data (see the
// deletion loop in performReset). The rest don't gate identity, so their order is
// incidental.
function allCollections() {
  return [col.sessions, col.users, col.roles, col.apps, col.emailRules, col.audit, col.usageDaily, col.apiKeys];
}

// Epoch ms when the next reset will fire, or null when idle. Surfaced to the
// countdown banner via demoLocals.
export function getResetAt(): number | null {
  return resetAtMs;
}

// Arm the reset on the first sign-in after a reset. No-op while already armed, so
// the window is anchored to the FIRST login and does not slide on later logins.
export function armReset(): void {
  if (resetAtMs !== null) return;
  const delay = config.demoLimitMins * 60_000;
  resetAtMs = Date.now() + delay;
  timer = setTimeout(() => {
    void performReset();
  }, delay);
  // Don't let the pending reset keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref();
}

// Wipe every collection and reseed to the fixed demo dataset, then invalidate all
// in-process caches so the next request sees clean state. Re-entrant-safe: a call
// while a reset is in flight is a no-op. Leaves the state machine idle.
export async function performReset(): Promise<void> {
  if (resetting) return;
  resetting = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    // Snapshot user ids BEFORE the wipe so we can evict their userCache entries
    // (evictAll clears the decision + app caches but not the per-user cache).
    const priorUserIds = (await col.users.find({}).project({ _id: 1 }).toArray()).map((u) => String(u._id));

    // Sessions first, so any in-flight request loses its identity immediately and
    // falls through to the login picker rather than acting on soon-to-be-gone data.
    for (const c of allCollections()) await c.deleteMany({});

    await seedDemo();

    evictAll(); // decision + app-registry caches
    for (const id of priorUserIds) evictUser(id); // per-user micro-cache
    clearUsageDedup(); // in-process usage write-suppression set
  } finally {
    resetAtMs = null;
    timer = null;
    resetting = false;
  }
}

// Test hygiene: clear the timer and reset module state between cases.
export function stopResetTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  resetAtMs = null;
  resetting = false;
}

// Expose the demo flag + next-reset epoch to every rendered page (the countdown
// banner in partials/head.ejs reads these). Mounted only in demo mode.
export function demoLocals(_req: Request, res: Response, next: NextFunction): void {
  res.locals.demoMode = true;
  res.locals.demoResetAt = resetAtMs;
  next();
}
