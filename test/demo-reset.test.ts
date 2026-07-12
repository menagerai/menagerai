import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  toArray: vi.fn(async () => [{ _id: 'u1' }, { _id: 'u2' }]),
  seedDemo: vi.fn(async () => {}),
  evictAll: vi.fn(),
  evictUser: vi.fn(),
  clearUsageDedup: vi.fn(),
}));

vi.mock('../src/config', () => ({ config: { demoLimitMins: 10 } }));
vi.mock('../src/db', () => {
  const coll = () => ({ deleteMany: h.deleteMany });
  return {
    col: {
      users: { deleteMany: h.deleteMany, find: () => ({ project: () => ({ toArray: h.toArray }) }) },
      roles: coll(),
      apps: coll(),
      emailRules: coll(),
      sessions: coll(),
      audit: coll(),
      usageDaily: coll(),
      apiKeys: coll(),
    },
  };
});
vi.mock('../src/decide', () => ({ evictAll: h.evictAll, evictUser: h.evictUser }));
vi.mock('../src/usage', () => ({ clearUsageDedup: h.clearUsageDedup }));
vi.mock('../src/demo/seed', () => ({ seedDemo: h.seedDemo }));

import { armReset, getResetAt, performReset, stopResetTimer } from '../src/demo/reset';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  stopResetTimer();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('performReset', () => {
  it('wipes all 8 collections, reseeds, invalidates caches, and returns to idle', async () => {
    await performReset();
    expect(h.deleteMany).toHaveBeenCalledTimes(8);
    expect(h.seedDemo).toHaveBeenCalledTimes(1);
    expect(h.evictAll).toHaveBeenCalledTimes(1);
    expect(h.evictUser).toHaveBeenCalledWith('u1');
    expect(h.evictUser).toHaveBeenCalledWith('u2');
    expect(h.clearUsageDedup).toHaveBeenCalledTimes(1);
    expect(getResetAt()).toBeNull();
  });
});

describe('armReset', () => {
  it('arms once and does not extend the window on a second call', () => {
    armReset();
    const first = getResetAt();
    expect(first).toBe(Date.now() + 10 * 60_000);
    vi.advanceTimersByTime(60_000);
    armReset(); // still armed → ignored
    expect(getResetAt()).toBe(first);
  });

  it('fires the reset after DEMO_LIMIT_MINS, then re-arms on the next login', async () => {
    armReset();
    expect(getResetAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.deleteMany).toHaveBeenCalledTimes(8);
    expect(getResetAt()).toBeNull();
    armReset(); // a fresh window after the reset
    expect(getResetAt()).not.toBeNull();
  });
});
