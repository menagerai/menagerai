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

import { fetchAppLlmDaily, fetchUserLlmDaily, sumWindow, clearLlmCache, LlmProxyError } from '../src/llm';

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
    expect(urls.some((u) => u.includes('/spend/logs/v2?start_date=2026-09-01') && u.includes('page=1'))).toBe(true);
    expect(urls.filter((u) => u.includes('/spend/logs/v2')).length).toBe(2);
    expect(urls.some((u) => u.includes('/key/list'))).toBe(true);
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
