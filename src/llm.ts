import { config } from './config';
import { usageDay } from './usage';
import { ttlCache } from './ttl-cache';

// All LiteLLM interaction lives here — no vendor logic leaks into routes/views.
// The overlay reads row-level spend logs (GET /spend/logs/v2) and buckets each
// request into the portal's configured timezone via usageDay(), so LLM cells
// follow the exact same 24-hour rhythm as the activity heatmap. Per-app rows are
// grouped by their virtual key's alias (resolved from GET /key/list); per-user
// rows by the LiteLLM field named in LLM_PROXY_USER_KEY (end_user | user_id).
// See design/llm-usage-plan.md for the verified contract and identity mapping.

export interface LlmDailyRow {
  day: string; // 'YYYY-MM-DD' in config.timezone
  spend: number; // USD
  totalTokens: number;
}

// Thrown on timeout or non-2xx. Callers catch it, flag an inline warning, and
// render the activity-only view; the next page load retries.
export class LlmProxyError extends Error {}

export function llmConfigured(): boolean {
  return config.llmProxyVendor === 'litellm' && !!config.llmProxyBaseUrl && !!config.llmProxyMgmtApiKey;
}

// Per-user data additionally requires a field to match the portal email against.
export function llmUserConfigured(): boolean {
  return llmConfigured() && (config.llmProxyUserKey === 'end_user' || config.llmProxyUserKey === 'user_id');
}

interface SpendRow {
  startTime: string;
  api_key: string;
  end_user: string | null;
  user: string | null;
  spend: number;
  total_tokens: number;
}

// The caches hold the in-flight PROMISE, not just the resolved value, so the many
// card fetches a cold dashboard fires concurrently all await one shared pull
// instead of each paginating the proxy independently. A rejected promise is
// evicted so a later request retries rather than caching the failure.
const rowCache = ttlCache<string, Promise<SpendRow[]>>(config.llmCacheTtlMs, 64);
const aliasCache = ttlCache<string, Promise<Map<string, string>>>(config.llmCacheTtlMs, 4);

const TIMEOUT_MS = 5_000;

async function proxyGet(path: string): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.llmProxyBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.llmProxyMgmtApiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new LlmProxyError(`LiteLLM ${path} -> ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof LlmProxyError) throw err;
    throw new LlmProxyError(`LiteLLM ${path} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// LiteLLM interprets start_date/end_date as UTC calendar days, but we bucket rows
// into the portal timezone. Widen the queried UTC range by a day on each side so
// no row that maps to a local day within [sinceDay, today] is dropped at the UTC
// boundary (e.g. a western timezone's current-local-day rows that land on the next
// UTC date). bucket() then trims to the exact local window.
function shiftUtcDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

// One paginated pull of the raw spend logs for [sinceDay, today], cached (as a
// promise) by window. Bounded by llmMaxPages so a busy proxy can't blow it up.
function loadRows(sinceDay: string): Promise<SpendRow[]> {
  const cached = rowCache.get(sinceDay);
  if (cached) return cached;
  const p = (async () => {
    const startDate = shiftUtcDay(sinceDay, -1);
    const endDate = shiftUtcDay(usageDay(Date.now()), 1);
    const rows: SpendRow[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const j = await proxyGet(`/spend/logs/v2?start_date=${startDate}&end_date=${endDate}&page=${page}&page_size=1000`);
      for (const r of (j.data as SpendRow[]) ?? []) rows.push(r);
      totalPages = Number(j.total_pages ?? 1);
      page++;
    } while (page <= totalPages && page <= config.llmMaxPages);
    return rows;
  })();
  rowCache.set(sinceDay, p);
  p.catch(() => rowCache.delete(sinceDay));
  return p;
}

// hashed virtual-key token -> key_alias, so rows (which carry only the hash) can
// be attributed to a portal app_key by alias. Cached as a promise (see above).
function loadAliasMap(): Promise<Map<string, string>> {
  const cached = aliasCache.get('keys');
  if (cached) return cached;
  const p = (async () => {
    const map = new Map<string, string>();
    let page = 1;
    let totalPages = 1;
    do {
      const j = await proxyGet(`/key/list?page=${page}&page_size=200&return_full_object=true`);
      for (const k of (j.keys as { token?: string; key_alias?: string }[]) ?? []) {
        if (k.token && k.key_alias) map.set(k.token, k.key_alias);
      }
      totalPages = Number(j.total_pages ?? 1);
      page++;
    } while (page <= totalPages && page <= config.llmMaxPages);
    return map;
  })();
  aliasCache.set('keys', p);
  p.catch(() => aliasCache.delete('keys'));
  return p;
}

// Fold matched rows into per-day spend/token totals, bucketed by the portal tz.
function bucket(rows: SpendRow[], sinceDay: string): LlmDailyRow[] {
  const byDay = new Map<string, { spend: number; totalTokens: number }>();
  for (const r of rows) {
    const ms = Date.parse(r.startTime);
    if (!Number.isFinite(ms)) continue;
    const day = usageDay(ms);
    if (day < sinceDay) continue; // guard the window edge after tz shift
    const acc = byDay.get(day) ?? { spend: 0, totalTokens: 0 };
    acc.spend += Number(r.spend) || 0;
    acc.totalTokens += Number(r.total_tokens) || 0;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, v]) => ({ day, spend: v.spend, totalTokens: v.totalTokens }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Per-app daily usage over [sinceDay, today]. null = feature off, or no virtual key
// aliased to appKey has any activity in the window (render activity-only).
// `loadSinceDay` (>= sinceDay's coverage; defaults to sinceDay) is the window to
// pull/cache rows from — pass a wider one to share a cached pull made elsewhere;
// bucket() still trims to sinceDay.
export async function fetchAppLlmDaily(
  appKey: string,
  sinceDay: string,
  loadSinceDay: string = sinceDay,
): Promise<LlmDailyRow[] | null> {
  if (!llmConfigured()) return null;
  const [rows, aliases] = await Promise.all([loadRows(loadSinceDay), loadAliasMap()]);
  const mine = rows.filter((r) => aliases.get(r.api_key) === appKey);
  return mine.length ? bucket(mine, sinceDay) : null;
}

// Per-user daily usage. null = per-user not configured, or no rows match this
// email in the chosen field (render activity-only). `loadSinceDay` as above.
export async function fetchUserLlmDaily(
  userEmail: string,
  sinceDay: string,
  loadSinceDay: string = sinceDay,
): Promise<LlmDailyRow[] | null> {
  if (!llmUserConfigured()) return null;
  const useEndUser = config.llmProxyUserKey === 'end_user';
  const rows = await loadRows(loadSinceDay);
  const mine = rows.filter((r) => (useEndUser ? r.end_user : r.user) === userEmail);
  return mine.length ? bucket(mine, sinceDay) : null;
}

// Fold one row into a running per-key total, applying the same tz-day window
// guard as bucket() so totals honour the portal timezone and the shifted UTC pull.
function addTotal(
  map: Map<string, { spend: number; tokens: number }>,
  key: string,
  r: SpendRow,
  windowSinceDay: string,
): void {
  const ms = Date.parse(r.startTime);
  if (!Number.isFinite(ms)) return;
  if (usageDay(ms) < windowSinceDay) return;
  const acc = map.get(key) ?? { spend: 0, tokens: 0 };
  acc.spend += Number(r.spend) || 0;
  acc.tokens += Number(r.total_tokens) || 0;
  map.set(key, acc);
}

// Windowed spend/token totals for EVERY app (keyed by virtual-key alias) — the
// material the dashboard composite ranking scores across all apps before cutting
// to the top N. `windowSinceDay` is the ranking window; `loadSinceDay` is the day
// to pull/cache rows from — pass the (wider) heatmap window so this reuses the
// exact cached pull the winner heatmaps already need, adding no proxy traffic.
// Empty when the feature is off.
export async function fetchAllAppLlmTotals(
  loadSinceDay: string,
  windowSinceDay: string,
): Promise<Map<string, { spend: number; tokens: number }>> {
  const out = new Map<string, { spend: number; tokens: number }>();
  if (!llmConfigured()) return out;
  const [rows, aliases] = await Promise.all([loadRows(loadSinceDay), loadAliasMap()]);
  for (const r of rows) {
    const appKey = aliases.get(r.api_key);
    if (appKey) addTotal(out, appKey, r, windowSinceDay);
  }
  return out;
}

// Windowed spend/token totals for EVERY user, keyed by the portal email in the
// LLM_PROXY_USER_KEY field. Same cached-pull reuse as fetchAllAppLlmTotals. Empty
// when per-user is not configured.
export async function fetchAllUserLlmTotals(
  loadSinceDay: string,
  windowSinceDay: string,
): Promise<Map<string, { spend: number; tokens: number }>> {
  const out = new Map<string, { spend: number; tokens: number }>();
  if (!llmUserConfigured()) return out;
  const useEndUser = config.llmProxyUserKey === 'end_user';
  const rows = await loadRows(loadSinceDay);
  for (const r of rows) {
    const key = useEndUser ? r.end_user : r.user;
    if (key) addTotal(out, key, r, windowSinceDay);
  }
  return out;
}

// Totals over a trailing window [sinceDay, today]. Mirrors the activity score's
// two-window shape (recent vs. full).
export function sumWindow(rows: LlmDailyRow[], sinceDay: string): { spend: number; tokens: number } {
  let spend = 0;
  let tokens = 0;
  for (const r of rows) {
    if (r.day >= sinceDay) {
      spend += r.spend;
      tokens += r.totalTokens;
    }
  }
  return { spend, tokens };
}

// Test seam: the module-level caches survive across requests by design, but unit
// tests need a clean slate between cases.
export function clearLlmCache(): void {
  rowCache.clear();
  aliasCache.clear();
}
