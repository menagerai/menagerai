import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    llmTimeoutMs: 60_000,
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

  it('uses the supported key-list size limit and preserves spend-log page_size', async () => {
    const fetchFn = installFetch();
    await fetchAppLlmDaily('vividimage', SINCE);
    const urls = fetchFn.mock.calls.map((c) => new URL(String(c[0])));
    const keyUrls = urls.filter((u) => u.pathname === '/key/list');
    expect(keyUrls).toHaveLength(1);
    // LiteLLM validates size in [1, 100]; size=200 returns HTTP 422.
    expect(keyUrls[0].searchParams.get('size')).toBe('100');
    expect(keyUrls[0].searchParams.has('page_size')).toBe(false);
    for (const url of urls.filter((u) => u.pathname === '/spend/logs/v2')) {
      expect(url.searchParams.get('page_size')).toBe('1000');
      expect(url.searchParams.has('size')).toBe(false);
    }
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

  it('returns null when matched rows all predate sinceDay after bucketing', async () => {
    installFetch();
    // vividimage (HASH_A) has rows on 09-10/09-11 only; a later cutoff buckets to
    // empty. Must be null (activity-only), not [] (which would enable the overlay).
    expect(await fetchAppLlmDaily('vividimage', '2026-09-20', '2026-08-01')).toBeNull();
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

  it('does not cache a failed pull: the next request retries', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchAppLlmDaily('vividimage', SINCE)).rejects.toBeInstanceOf(LlmProxyError);
    installFetch();
    expect(await fetchAppLlmDaily('vividimage', SINCE)).not.toBeNull();
  });

  it('wraps a transport failure in LlmProxyError', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchAppLlmDaily('vividimage', SINCE)).rejects.toBeInstanceOf(LlmProxyError);
  });
});

describe('bounded spend-log pagination', () => {
  function deferredPages(totalPages: number) {
    const pending = new Map<number, { resolve: (response: Response) => void; reject: (err: Error) => void }>();
    const started: number[] = [];
    const fn = vi.fn((url: string) => new Promise<Response>((resolve, reject) => {
      const page = Number(new URL(url).searchParams.get('page'));
      started.push(page);
      pending.set(page, { resolve, reject });
    }));
    global.fetch = fn as unknown as typeof fetch;
    const finish = (page: number) => pending.get(page)!.resolve({
      ok: true,
      json: async () => ({ data: [{ ...ROWS[0], end_user: `page-${page}` }], total_pages: totalPages }),
    } as Response);
    return { started, pending, finish };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cfg.config.llmMaxPages = 50;
    vi.useRealTimers();
  });

  it.each([
    { total: 8, cap: 1, expected: [1] },
    { total: 8, cap: 3, expected: [1, 2, 3] },
    { total: 8, cap: 5, expected: [1, 2, 3, 4, 5] },
    { total: 1, cap: 50, expected: [1] },
  ])('honours maxPages=$cap with total_pages=$total', async ({ total, cap, expected }) => {
    cfg.config.llmMaxPages = cap;
    const pages = deferredPages(total);
    const pull = fetchAllUserLlmTotals(SINCE, SINCE);
    for (const page of expected) {
      expect(pages.started).toContain(page);
      pages.finish(page);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect([...(await pull).keys()]).toEqual(expected.map((page) => `page-${page}`));
    expect(pages.started).toEqual(expected);
  });

  it('stops scheduling on failure and drains started work before allowing a retry', async () => {
    const pages = deferredPages(8);
    const pull = fetchAllUserLlmTotals(SINCE, SINCE);
    let settled = false;
    const failure = expect(pull).rejects.toThrow('page two failed');
    void pull.then(() => { settled = true; }, () => { settled = true; });
    pages.finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.started).toEqual([1, 2, 3, 4]);
    pages.pending.get(2)!.reject(new Error('page two failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const joined = fetchAllUserLlmTotals(SINCE, SINCE);
    const joinedFailure = expect(joined).rejects.toThrow('page two failed');
    expect(pages.started).toEqual([1, 2, 3, 4]);
    pages.finish(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.started).toEqual([1, 2, 3, 4]); // no page 5 after a failed worker
    expect(settled).toBe(false);
    // A second failure must settle too, without hiding the original error.
    pages.pending.get(4)!.reject(new Error('page four failed'));
    await Promise.all([failure, joinedFailure]);
    expect(settled).toBe(true);
    const retry = deferredPages(1);
    const retried = fetchAllUserLlmTotals(SINCE, SINCE);
    expect(retry.started).toEqual([1]); // no partial result was cached
    retry.finish(1);
    expect([...(await retried).keys()]).toEqual(['page-1']);
  });

  it('discovers page count first, overlaps at most three pages, and preserves page order', async () => {
    const pages = deferredPages(7);
    const pull = fetchAllUserLlmTotals(SINCE, SINCE);
    expect(pages.started).toEqual([1]);
    pages.finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.started).toEqual([1, 2, 3, 4]); // three unresolved requests, not all six
    pages.finish(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.started).toEqual([1, 2, 3, 4, 5]);
    pages.finish(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.started).toEqual([1, 2, 3, 4, 5, 6]);
    pages.finish(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.started).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const page of [7, 5, 2]) pages.finish(page);
    expect([...(await pull).keys()]).toEqual([1, 2, 3, 4, 5, 6, 7].map((page) => `page-${page}`));
  });
});

describe('pull deadline and cache lifetime', () => {
  // Every proxy call takes `pageMs` (fake time) and honours the abort signal.
  function installSlowFetch(pageMs: number, totalPages: number) {
    const fn = vi.fn((url: string, opts: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      const u = String(url);
      const body = u.includes('/key/list')
        ? { keys: KEYS, total_pages: 1 }
        : { data: ROWS, page: Number(new URL(u).searchParams.get('page')), total_pages: totalPages };
      const t = setTimeout(() => resolve({ ok: true, json: async () => body } as Response), pageMs);
      opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    }));
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets a slow page finish within the total budget', async () => {
    installSlowFetch(6_000, 1); // well past the old 5s per-call limit
    const p = fetchAppLlmDaily('vividimage', SINCE);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await p).not.toBeNull();
  });

  it('bounds the whole pagination, not each page', async () => {
    installSlowFetch(40_000, 2); // page 1 at 40s fits; page 2 would end at 80s > 60s
    const p = fetchAppLlmDaily('vividimage', SINCE);
    const settled = expect(p).rejects.toBeInstanceOf(LlmProxyError);
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('aborts every concurrent body read at the same total deadline', async () => {
    const startedAt = Date.now();
    const aborted: number[] = [];
    const pages: number[] = [];
    global.fetch = vi.fn(async (url: string, opts: { signal: AbortSignal }) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      // Headers arrive immediately; the deadline must also cover res.json().
      return {
        ok: true,
        json: () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ data: ROWS, total_pages: 8 }), page === 1 ? 20_000 : 45_000);
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(Date.now() - startedAt);
            reject(new Error('body aborted'));
          });
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const pull = fetchAllUserLlmTotals(SINCE, SINCE);
    const failure = expect(pull).rejects.toThrow('body aborted');
    let settled = false;
    void pull.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pages).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(aborted).toEqual([60_000, 60_000, 60_000]);
    expect(pages).toEqual([1, 2, 3, 4]);
  });

  it('deduplicates a concurrent multi-page pull and expires TTL from completion', async () => {
    const fetchFn = installSlowFetch(20_000, 4);
    const first = fetchUserLlmDaily('alice@x.com', SINCE);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    const joined = fetchUserLlmDaily('bob@x.com', SINCE);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([first, joined]); // completes at 40s; TTL runs through 100s
    await vi.advanceTimersByTimeAsync(59_999);
    await fetchUserLlmDaily('alice@x.com', SINCE);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    const refresh = fetchUserLlmDaily('alice@x.com', SINCE);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(40_000);
    await refresh;
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it('starts the cache TTL when the pull completes, not when it starts', async () => {
    const fetchFn = installSlowFetch(20_000, 1);
    const p = fetchAppLlmDaily('vividimage', SINCE);
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    const calls = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50_000); // 70s after start, 50s after completion
    await fetchAppLlmDaily('pipeline', SINCE);
    expect(fetchFn.mock.calls.length).toBe(calls); // still cached
  });

  // A pull may outlive the cache TTL (LLM_PROXY_TIMEOUT_MS is set independently
  // of LLM_PROXY_CACHE_TTL_MS). Here: 70s pull vs the 60s TTL.
  describe('when the pull outlives the cache TTL', () => {
    beforeEach(() => { cfg.config.llmTimeoutMs = 90_000; });
    afterEach(() => { cfg.config.llmTimeoutMs = 60_000; });

    it('joins the in-flight pull instead of starting a duplicate', async () => {
      const fetchFn = installSlowFetch(70_000, 1);
      const first = fetchAppLlmDaily('vividimage', SINCE);
      await vi.advanceTimersByTimeAsync(65_000); // past the TTL, pull still running
      const calls = fetchFn.mock.calls.length;
      const second = fetchAppLlmDaily('pipeline', SINCE);
      expect(fetchFn.mock.calls.length).toBe(calls); // no second pull
      await vi.advanceTimersByTimeAsync(75_000); // drain
      await Promise.all([first, second]);
    });

    it('still caches the result for the full TTL from completion', async () => {
      const fetchFn = installSlowFetch(70_000, 1);
      const p = fetchAppLlmDaily('vividimage', SINCE);
      await vi.advanceTimersByTimeAsync(70_000);
      await p;
      const calls = fetchFn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000); // 100s after start, 30s after completion
      const q = fetchAppLlmDaily('pipeline', SINCE);
      expect(fetchFn.mock.calls.length).toBe(calls); // served from cache
      await vi.advanceTimersByTimeAsync(75_000); // drain
      await q;
    });
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
