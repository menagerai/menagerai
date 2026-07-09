import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB so appCached/userCached exercise the cache over a controllable
// findOne, and mock config to give short, test-friendly TTLs.
const { appsFindOne, usersFindOne } = vi.hoisted(() => ({ appsFindOne: vi.fn(), usersFindOne: vi.fn() }));
vi.mock('../src/db', () => ({ col: { apps: { findOne: appsFindOne }, users: { findOne: usersFindOne }, roles: { find: vi.fn() } } }));
vi.mock('../src/config', () => ({ config: { appCacheTtlMs: 10_000, userCacheTtlMs: 10_000, decisionCacheTtlMs: 10_000 } }));

import { appCached, evictAll, evictUser, userCached } from '../src/decide';
import { globToRegExp, matchesPublic } from '../src/gateway-logic';

beforeEach(() => {
  appsFindOne.mockReset();
  usersFindOne.mockReset();
  evictAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('appCached', () => {
  it('hits Mongo once, then serves from cache within the TTL', async () => {
    appsFindOne.mockResolvedValue({ key: 'demo', status: 'active' });
    const a = await appCached('demo');
    const b = await appCached('demo');
    expect(a).toEqual(b);
    expect(appsFindOne).toHaveBeenCalledTimes(1);
  });

  it('caches per key independently', async () => {
    appsFindOne.mockImplementation(async (q: { key: string }) => ({ key: q.key, status: 'active' }));
    await appCached('a');
    await appCached('b');
    await appCached('a');
    expect(appsFindOne).toHaveBeenCalledTimes(2);
  });

  it('evictAll() forces a refetch (app edits take effect immediately)', async () => {
    appsFindOne.mockResolvedValue({ key: 'demo', status: 'active' });
    await appCached('demo');
    evictAll();
    await appCached('demo');
    expect(appsFindOne).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after the TTL expires', async () => {
    vi.useFakeTimers();
    appsFindOne.mockResolvedValue({ key: 'demo', status: 'active' });
    await appCached('demo');
    vi.advanceTimersByTime(10_001);
    await appCached('demo');
    expect(appsFindOne).toHaveBeenCalledTimes(2);
  });
});

describe('userCached', () => {
  it('serves from cache within the TTL and refetches after evictUser', async () => {
    const id = new ObjectId();
    usersFindOne.mockResolvedValue({ _id: id, status: 'active' });
    await userCached(id);
    await userCached(id);
    expect(usersFindOne).toHaveBeenCalledTimes(1);
    evictUser(String(id)); // e.g. offboarding / role change
    await userCached(id);
    expect(usersFindOne).toHaveBeenCalledTimes(2);
  });
});

describe('globToRegExp memoization', () => {
  it('returns the identical compiled RegExp for the same pattern', () => {
    expect(globToRegExp('/api/public/**')).toBe(globToRegExp('/api/public/**'));
  });
  it('still matches correctly after memoization', () => {
    const paths = [{ method: 'GET', pattern: '/api/public/**' }];
    expect(matchesPublic(paths, 'GET', '/api/public/x/y')).toBe(true);
    expect(matchesPublic(paths, 'GET', '/api/private')).toBe(false);
  });
});
