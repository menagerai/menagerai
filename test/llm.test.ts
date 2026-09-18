import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable config so individual tests can flip llmProxyUserKey / vendor. llm.ts
// reads these at call time, so mutation between cases takes effect immediately.
const cfg = vi.hoisted(() => ({
  config: {
    timezone: 'UTC',
    llmProxyVendor: 'litellm',
    llmProxyBaseUrl: 'http://litellm:4000',
    llmProxyMgmtApiKey: 'sk-test',
    llmProxyUserKey: 'end_user',
    llmCacheTtlMs: 60_000,
    llmMaxPages: 50,
  },
}));
vi.mock('../src/config', () => cfg);
vi.mock('../src/db', () => ({ col: {} })); // usage.ts (imported transitively) pulls in db

import {
  fetchAppLlmDaily, fetchUserLlmDaily, fetchAllAppLlmTotals, fetchAllUserLlmTotals,
  sumWindow, clearLlmCache, LlmProxyError,
} from '../src/llm';

const SINCE = '2026-09-01';

// Two virtual keys, aliased to portal app keys. Rows are split across two pages
// to exercise the pagination loop.
const KEYS = [
  { token: 'HASH_A', key_alias: 'vividimage' },
  { token: 'HASH_B', key_alias: 'pipeline' },
];
const ROWS = [
  { startTime: '2026-09-10T10:00:00Z', api_key: 'HASH_A', end_user: 'alice@x.com', user: 'u1', spend: 1.0, total_tokens: 100 },
  { startTime: '2026-09-10T12:00:00Z', api_key: 'HASH_A', end_user: 'bob@x.com', user: 'u2', spend: 0.5, total_tokens: 50 },
  { startTime: '2026-09-11T09:00:00Z', api_key: 'HASH_A', end_user: 'alice@x.com', user: 'u1', spend: 2.0, total_tokens: 200 },
  { startTime: '2026-09-11T09:30:00Z', api_key: 'HASH_B', end_user: 'alice@x.com', user: 'u1', spend: 9.0, total_tokens: 900 },
];

function installFetch() {
  const fn = vi.fn(async (url: string, opts: { headers: Record<string, string> }) => {
    // Every call carries the management bearer token.
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
    const u = String(url);
    if (u.includes('/key/list')) {
      return { ok: true, json: async () => ({ keys: KEYS, total_pages: 1 }) } as Response;
    }
    if (u.includes('/spend/logs/v2')) {
      const page = Number(new URL(u).searchParams.get('page'));
      const data = page === 1 ? ROWS.slice(0, 2) : ROWS.slice(2, 4);
      return { ok: true, json: async () => ({ data, page, total_pages: 2 }) } as Response;
    }
    throw new Error(`unexpected url ${u}`);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  clearLlmCache();
  cfg.config.llmProxyVendor = 'litellm';
  cfg.config.llmProxyUserKey = 'end_user';
  cfg.config.timezone = 'UTC';
});

describe('fetchAppLlmDaily', () => {
  it('paginates, joins hashed keys to aliases, and buckets by day', async () => {
    const fetchFn = installFetch();
    const rows = await fetchAppLlmDaily('vividimage', SINCE);
    // HASH_A rows only, folded per UTC day, sorted ascending.
    expect(rows).toEqual([
      { day: '2026-09-10', spend: 1.5, totalTokens: 150 },
      { day: '2026-09-11', spend: 2.0, totalTokens: 200 },
    ]);
    // Two spend-log pages + one key/list = 3 calls; the URL and window are built right.
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    // start_date is widened one UTC day below sinceDay (2026-09-01 -> 2026-08-31).
    expect(urls.some((u) => u.includes('/spend/logs/v2?start_date=2026-08-31') && u.includes('page=1'))).toBe(true);
    expect(urls.filter((u) => u.includes('/spend/logs/v2')).length).toBe(2);
    expect(urls.some((u) => u.includes('/key/list'))).toBe(true);
  });

  it('deduplicates concurrent cold-cache loads into a single shared pull', async () => {
    const fetchFn = installFetch();
    // Cold cache, all fired at once — the dashboard's real access pattern.
    await Promise.all([
      fetchAppLlmDaily('vividimage', SINCE),
      fetchAppLlmDaily('pipeline', SINCE),
      fetchUserLlmDaily('alice@x.com', SINCE),
    ]);
    // One shared row pull (2 pages) + one key/list = 3, not 3x that.
    expect(fetchFn.mock.calls.length).toBe(3);
  });

  it('widens the queried UTC range so timezone-boundary rows are not dropped', async () => {
    const fetchFn = installFetch();
    await fetchAppLlmDaily('vividimage', SINCE);
    const spendUrl = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/spend/logs/v2'))!;
    const params = new URL(spendUrl).searchParams;
    expect(params.get('start_date')).toBe('2026-08-31'); // sinceDay - 1 UTC day
    expect(params.get('end_date')! > '2026-08-31').toBe(true); // today + 1 UTC day
  });

  it('buckets a UTC-evening row into the next local day for a positive-offset timezone', async () => {
    cfg.config.timezone = 'Asia/Shanghai'; // UTC+8
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/key/list')) return { ok: true, json: async () => ({ keys: [{ token: 'H', key_alias: 'app1' }], total_pages: 1 }) } as Response;
      // 2026-09-10T16:30Z == 2026-09-11 00:30 in Asia/Shanghai -> local day 2026-09-11.
      return { ok: true, json: async () => ({ data: [{ startTime: '2026-09-10T16:30:00Z', api_key: 'H', end_user: null, user: null, spend: 1, total_tokens: 10 }], page: 1, total_pages: 1 }) } as Response;
    }) as unknown as typeof fetch;
    expect(await fetchAppLlmDaily('app1', '2026-09-01')).toEqual([{ day: '2026-09-11', spend: 1, totalTokens: 10 }]);
  });

  it('loads from a wider loadSinceDay but still buckets to sinceDay', async () => {
    const fetchFn = installFetch();
    // Load a wide window, bucket only from 2026-09-11 onward (drops the 09-10 rows).
    const rows = await fetchAppLlmDaily('vividimage', '2026-09-11', '2026-08-01');
    expect(rows).toEqual([{ day: '2026-09-11', spend: 2.0, totalTokens: 200 }]);
    const spendUrl = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/spend/logs/v2'))!;
    expect(new URL(spendUrl).searchParams.get('start_date')).toBe('2026-07-31'); // loadSinceDay - 1
  });

  it('shares the ranking totals pull when the overlay loads from the same wide window', async () => {
    const fetchFn = installFetch();
    // The dashboard pattern when USAGE_HEATMAP_DAYS < rank window: totals load wide,
    // then the overlay loads from that same wide date — one pull, not two.
    await fetchAllAppLlmTotals('2026-08-01', SINCE);
    await fetchAppLlmDaily('vividimage', '2026-09-05', '2026-08-01');
    expect(fetchFn.mock.calls.length).toBe(3); // 2 spend pages + 1 key/list, shared
  });

  it('returns null when no virtual key is aliased to the app', async () => {
    installFetch();
    expect(await fetchAppLlmDaily('does-not-exist', SINCE)).toBeNull();
  });

  it('returns null when the feature is off', async () => {
    installFetch();
    cfg.config.llmProxyVendor = '';
    expect(await fetchAppLlmDaily('vividimage', SINCE)).toBeNull();
  });

  it('shares one fetch across calls within the cache window', async () => {
    const fetchFn = installFetch();
    await fetchAppLlmDaily('vividimage', SINCE);
    await fetchAppLlmDaily('pipeline', SINCE);
    // Second app reuses the cached rows + alias map: still just 3 calls total.
    expect(fetchFn.mock.calls.length).toBe(3);
  });

  it('wraps a transport failure in LlmProxyError', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchAppLlmDaily('vividimage', SINCE)).rejects.toBeInstanceOf(LlmProxyError);
  });
});

describe('fetchUserLlmDaily', () => {
  it('matches the portal email against end_user', async () => {
    installFetch();
    const rows = await fetchUserLlmDaily('alice@x.com', SINCE);
    expect(rows).toEqual([
      { day: '2026-09-10', spend: 1.0, totalTokens: 100 },
      { day: '2026-09-11', spend: 11.0, totalTokens: 1100 }, // HASH_A + HASH_B, same user
    ]);
  });

  it('is gated off when LLM_PROXY_USER_KEY is unset', async () => {
    installFetch();
    cfg.config.llmProxyUserKey = '';
    expect(await fetchUserLlmDaily('alice@x.com', SINCE)).toBeNull();
  });

  it('can match against the internal user field instead', async () => {
    installFetch();
    cfg.config.llmProxyUserKey = 'user_id';
    const rows = await fetchUserLlmDaily('u2', SINCE);
    expect(rows).toEqual([{ day: '2026-09-10', spend: 0.5, totalTokens: 50 }]);
  });
});

describe('fetchAllAppLlmTotals / fetchAllUserLlmTotals — composite-ranking material', () => {
  it('totals every app by alias from one cached pull', async () => {
    const fetchFn = installFetch();
    const totals = await fetchAllAppLlmTotals(SINCE, SINCE);
    expect(totals.get('vividimage')).toEqual({ spend: 3.5, tokens: 350 }); // HASH_A r1+r2+r3
    expect(totals.get('pipeline')).toEqual({ spend: 9.0, tokens: 900 }); // HASH_B r4
    // Same 3 calls as a single per-app fetch (2 spend pages + 1 key/list), not per-entity.
    expect(fetchFn.mock.calls.length).toBe(3);
  });

  it('totals every user by end_user', async () => {
    installFetch();
    const totals = await fetchAllUserLlmTotals(SINCE, SINCE);
    expect(totals.get('alice@x.com')).toEqual({ spend: 12.0, tokens: 1200 }); // r1+r3+r4
    expect(totals.get('bob@x.com')).toEqual({ spend: 0.5, tokens: 50 }); // r2
  });

  it('counts only rows within the (narrower) ranking window while loading the wider one', async () => {
    installFetch();
    // Load from SINCE (wide) but only count from 2026-09-11 onward.
    const totals = await fetchAllAppLlmTotals(SINCE, '2026-09-11');
    expect(totals.get('vividimage')).toEqual({ spend: 2.0, tokens: 200 }); // r3 only
    expect(totals.get('pipeline')).toEqual({ spend: 9.0, tokens: 900 }); // r4
  });

  it('is empty when the feature is off / per-user is unset', async () => {
    installFetch();
    cfg.config.llmProxyVendor = '';
    expect((await fetchAllAppLlmTotals(SINCE, SINCE)).size).toBe(0);
    cfg.config.llmProxyVendor = 'litellm';
    cfg.config.llmProxyUserKey = '';
    expect((await fetchAllUserLlmTotals(SINCE, SINCE)).size).toBe(0);
  });
});

describe('sumWindow', () => {
  const rows = [
    { day: '2026-09-05', spend: 1.0, totalTokens: 100 },
    { day: '2026-09-10', spend: 2.0, totalTokens: 200 },
    { day: '2026-09-14', spend: 4.0, totalTokens: 400 },
  ];
  it('totals only days within the trailing window', () => {
    expect(sumWindow(rows, '2026-09-10')).toEqual({ spend: 6.0, tokens: 600 });
    expect(sumWindow(rows, '2026-09-01')).toEqual({ spend: 7.0, tokens: 700 });
  });
});
