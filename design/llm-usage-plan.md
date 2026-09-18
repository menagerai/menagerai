# Plan: LiteLLM-backed LLM Usage Metrics on the Admin Dashboard

## Background

The Menagerai portal (`portal-auth`) is an access-management gateway that sits in
front of internal apps. Its admin dashboard already shows per-app and per-user
activity as GitHub-style contribution heatmaps: one cell per day, shaded green by
how many distinct users (per-app) or distinct apps (per-user) were active that
day. A score line above each card reads e.g. `Activity: 71 [30d] / 175 [365d]` —
the recent window (`DASHBOARD_RANK_DAYS`, a fixed 30) vs. the full heatmap window
(`USAGE_HEATMAP_DAYS`, configurable, default 365). Both numbers are config-driven,
so the `[Nd]` badges always reflect the deployment's own settings.

This activity data answers *"who touched what, when"* but says nothing about *how
heavily* an app or user is consuming LLM resources — a critical cost/capacity
signal when multiple internal apps route model calls through a shared LiteLLM
proxy, which admins currently cannot see from the portal.

The goal is to extend the dashboard cards **and the per-app / per-user detail
pages** with LLM usage pulled from a LiteLLM proxy, feeling organic to the current
design. The visual metaphor is a tri-metric cell: the green activity square
shrinks slightly and sits top-right of a slightly larger cell, freeing an L-shaped
gutter. A thin red bar rises up the left edge (LLM spend); a thin blue bar runs
along the bottom edge (token usage). **Bar length and colour both use the exact
same log ramp as the green square, anchored to the busiest day in the section.**

When no LLM data is available — credentials not configured, proxy unreachable, or
a given app/user has none — the UI falls back to today's activity-only view with
zero visual change.

---

## Verified LiteLLM contract

**Probed live (read-only) against the target proxy and cross-checked with current
LiteLLM source.** This supersedes the first draft's endpoint guesses, several of
which were wrong. The management key is scoped to `management_routes`.

### Primary source: `GET /spend/logs/v2` — row-level, paginated

```
GET {BASE}/spend/logs/v2?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&page=1&page_size=1000
Authorization: Bearer {LLM_PROXY_MGMT_API_KEY}
```

Response: `{ "data": [ <SpendLogs row> ], "total": 572, "page": 1, "page_size":
1000, "total_pages": 6, "total_is_capped": false }`. Loop `page` 1..`total_pages`.

Each row carries everything we need, per request:

| field | use |
|---|---|
| `startTime` | full UTC ISO timestamp, e.g. `2026-09-14T23:42:00.587000Z` — **bucketed into the portal timezone** (below) |
| `api_key` | **hashed** virtual-key token → resolved to alias via `/key/list` (per-app grouping) |
| `end_user` | the OpenAI `user` request param; **holds portal user emails** on this proxy (per-user grouping) |
| `user` | LiteLLM internal user id (opaque here); alternative per-user key |
| `spend` | USD |
| `total_tokens` | token count |

Why row-level rather than the pre-aggregated daily endpoint: only the raw rows
carry a real timestamp (exact timezone bucketing, matching activity) **and** the
`end_user` email dimension (per-user attribution). Verified live: `end_user` is
populated with real emails (`iluvvivi@dovepaint.com.cn`, `production@dovechem.com`,
…); `startTime` is a full UTC timestamp; `/spend/logs/v2` is reachable and
uncapped.

### Support: `GET /key/list` — hashed token → `key_alias`

```
GET {BASE}/key/list?page_size=200&return_full_object=true
```
Returns `{ "keys": [ { "token": "<hash>", "key_alias": "vividimage", ... } ],
"total_count", "total_pages" }` (paginated — loop pages). Builds
`Map<token_hash, key_alias>`. Real aliases seen: `vividimage`, `vividbrief`,
`pipeline`, `dpkg-om`, `rm-formulation`, `colormatching`, `Xiaopan AI`, …

### Alternatives considered / rejected
- `GET /user/daily/activity` — pre-aggregated (spend **and** tokens, `key_alias`
  in `breakdown.api_keys[hash].metadata`), scalable, **but** UTC-day buckets only
  and no `end_user` dimension (`metadata.user_email`/`user_id` came back `null` on
  this proxy). Good fast-path for per-app if row volume ever gets large (documented
  fallback), but it can't do timezone-exact or per-user-by-email, so it is not the
  primary source.
- `GET /spend/logs` (v1) — **deprecated**, capped at 10k rows, `summarize=true`
  returns spend-only/no-tokens. Not used.
- `GET /key/daily/activity` — **404** (not present this version).
- `GET /tag/daily/activity`, `/customer/daily/activity`, `/customer/list`,
  `/global/spend/report` — **403**: not in `management_routes`, unreachable with a
  management key. (This is why per-customer data is read from `/spend/logs/v2`
  rows, not the customer endpoints.)

---

## Timezone — exact, matching activity

Because `/spend/logs/v2` rows carry a full `startTime` timestamp, each row is
bucketed with the portal's existing `usageDay(Date.parse(row.startTime),
config.timezone)` — the **same function, same IANA zone (DST included)** that
buckets activity. LLM cells therefore follow the identical 24-hour rhythm as the
green squares, in any configured timezone. No UTC-only caveat.

---

## Identity mapping (soft contract)

Portal identifiers are aligned to LiteLLM identifiers by an out-of-band process;
the portal best-effort-matches and falls back to activity-only on any miss.

### Per-app: `app_key` ⇒ `key_alias`
Build `Map<token_hash, key_alias>` from `/key/list`. For each row, `alias =
map[row.api_key]`; group rows where `alias === app_key`. Soft contract: whoever
provisions LiteLLM names each virtual key's alias to match the portal app key
(aliases seen — `vividimage`, `vividbrief`, `pipeline`, … — look like real app
names, so confirm the portal's `app_key`s line up). No alias match ⇒ activity-only
for that app.

### Per-user: portal email ⇒ `end_user` (works) — selectable via env
Group rows where `row[userField] === userEmail`, where `userField` is chosen by
`LLM_PROXY_USER_KEY`:
- `end_user` (**default**) — the "Customer" field in the LiteLLM UI; confirmed to
  hold portal emails on this proxy. This is the working path.
- `user_id` — LiteLLM internal-user id (opaque/`null` here; for deployments that
  provision internal users keyed by email instead).

Unset ⇒ the per-user LLM section is skipped (per-app still works). This env var is
exactly the user-vs-customer aggregation switch.

---

## New environment variables

Added to `src/config.ts` (via the existing `opt()` helper) and `.env.example`.
All optional; when `LLM_PROXY_VENDOR` is unset the feature is silently off and
every page renders exactly as today. Real values live in `.env` (gitignored);
only names/placeholders go in `.env.example`.

```
LLM_PROXY_VENDOR        # enum: "litellm" (only value). Unset => feature off.
LLM_PROXY_BASE_URL      # proxy base URL, no trailing slash. Docker: internal addr
                        # (http://litellm:4000); local dev: external addr.
LLM_PROXY_MGMT_API_KEY  # management-scoped LiteLLM key (read-only reporting use)
LLM_PROXY_USER_KEY      # per-user match field: "end_user" (default) | "user_id".
                        # Unset => per-user LLM section skipped.
LLM_PROXY_CACHE_TTL_MS  # optional, default 60000
LLM_PROXY_MAX_PAGES     # optional safety bound on the row pull, default 50
LLM_BOOST_MAX           # optional, default 0.5 — max composite-ranking boost from
                        # LLM use, as a fraction of the activity scale. Clamped [0,1].
LLM_BOOST_COST_SHARE    # optional, default 0.8 — split of that boost between spend
                        # (this share) and tokens (the rest). Clamped [0,1].
```

Config keys: `llmProxyVendor`, `llmProxyBaseUrl`, `llmProxyMgmtApiKey`,
`llmProxyUserKey`, `llmCacheTtlMs`, `llmMaxPages`, `llmBoostMax`,
`llmBoostCostShare`. Boot check: if `llmProxyVendor` is set but base URL or key is
missing, log a warning and treat the feature as off (never throw).

---

## New module: `src/llm.ts`

Encapsulates all LiteLLM interaction; no vendor logic leaks into routes/views.

```typescript
export interface LlmDailyRow {
  day: string;            // 'YYYY-MM-DD' in config.timezone (usageDay of startTime)
  spend: number;          // USD
  totalTokens: number;
}

export async function fetchAppLlmDaily(appKey: string, sinceDay: string): Promise<LlmDailyRow[] | null>;
export async function fetchUserLlmDaily(userEmail: string, sinceDay: string): Promise<LlmDailyRow[] | null>;
export function sumWindow(rows: LlmDailyRow[], sinceDay: string): { spend: number; tokens: number };
```

Internals:
- **`loadRows(sinceDay)`** — one paginated pull of `/spend/logs/v2` for
  `[sinceDay, today]` (loop to `total_pages`, bounded by `LLM_PROXY_MAX_PAGES`),
  cached by window. Returns the raw rows.
- **`loadAliasMap()`** — `/key/list` → `Map<hash, alias>`, cached.
- **`fetchAppLlmDaily`** — from cached rows + alias map, accumulate
  `{spend, totalTokens}` per `usageDay(startTime, tz)` for rows whose alias equals
  `appKey`; return `null` if the feature is off or no row ever matches that alias.
- **`fetchUserLlmDaily`** — same, matching `row[llmProxyUserKey] === userEmail`;
  `null` if `LLM_PROXY_USER_KEY` is unset or no row matches.
- Both read the **same cached row pull**, so a whole dashboard section costs **one**
  `/spend/logs/v2` pull + one `/key/list`, regardless of card count.
- **Caching:** reuse the existing `ttlCache` helper (`src/ttl-cache.ts`) — do not
  hand-roll a `Map`.
- **Timeout:** 5 s `AbortController`; on timeout/non-2xx throw a typed
  `LlmProxyError`. Callers catch it, set an inline warning flag, render
  activity-only. Next load retries.
- **Scaling note:** the row pull is bounded by `LLM_PROXY_MAX_PAGES`; if a busy
  proxy exceeds it, per-app can switch to the `/user/daily/activity` fast-path
  (UTC-day buckets) — documented, not built now (current volume is trivial).

---

## Heatmap math — reuse the green-square ramp exactly

The green square uses `intensityFor(count, scaleMax)` = `log(count)/log(scaleMax)`
→ 0–100, anchored to the section peak (`scaleMax`, floored at `MIN_SCALE_MAX=6`),
`count<=0 ⇒ 0`. The bars reuse **the same function** (the first draft's separate
`log10(1+9·v/scale)` is dropped):

- Convert spend to integer **cents** (`Math.round(spend*100)`); tokens are already
  integers. Both are then the non-negative integers `intensityFor` expects.
- `spendIntensity = intensityFor(cents, spendScaleCents)`,
  `tokenIntensity = intensityFor(tokens, tokenScale)`, where the scales are the
  **section peaks** computed with the same `maxCount`-style reducer used for the
  green `appScale`/`userScale`.
- **Bar length = intensity / 100** (length and colour share one ramp). Zero ⇒ 0 ⇒
  no bar.
- The `MIN_SCALE_MAX=6` floor is harmless (token/cent peaks are normally ≫ 6; a
  tiny section compresses gently, mirroring green's quiet-window behaviour).

`intensityFor` and the green path stay byte-identical; LLM fields are additive.

`intensityFor`'s log core is factored into an exported `logNorm(value, peak) → 0..1`
(float, peak → 1, `value<=0 ⇒ 0`, sub-1 values floored at 0); `intensityFor` becomes
`round(100 · logNorm(count, scaleMax))`. The composite ranking below reuses `logNorm`,
so shading and ranking normalise usage, spend and tokens the same way.

---

## Dashboard ranking — composite of activity + a bounded LLM boost

The Top apps / Top users lists rank on a composite score, computed across **all**
entities in the rank window before cutting to the top N (so an LLM-heavy entity can
climb *into* the list, not merely reorder within it):

```
score = logNorm(activity, activityPeak)                 # baseline, unchanged order
      + LLM_BOOST_MAX · ( COST_SHARE · logNorm(spendCents, spendPeakCents)
                        + (1−COST_SHARE) · logNorm(tokens,     tokenPeak) )
```

- **Activity stays the baseline.** `logNorm` is monotonic, so with equal (or no) LLM
  data the order — and its `(active desc, key asc)` tie-break — is identical to the
  previous activity-only ranking. When the feature is off the boost term is absent.
- **Never a penalty.** Entities with no LLM usage get boost 0; only others are lifted.
- **Cost over tokens.** `COST_SHARE = LLM_BOOST_COST_SHARE` (default 0.8) weights spend
  ~4× tokens; the shared `logNorm` keeps billion-token counts from running away.
- **Spend in cents.** Spend is normalised in integer cents (like the heatmap), so
  sub-dollar totals keep their ordering instead of collapsing at the ramp's low end.
- **Peak-relative, candidate-only.** All three signals normalise against the section
  peak (the busiest entity), so the boost is self-scaling — no absolute-dollar
  constants. Peaks are computed **only over ranking candidates**, so unrelated proxy
  identities (aliases/customers that aren't portal entities) can't inflate them.
- **No extra proxy traffic.** Per-entity spend/token totals come from the same cached
  `/spend/logs/v2` pull the winner heatmaps already need (`fetchAllAppLlmTotals` /
  `fetchAllUserLlmTotals` fold the cached rows by alias / `end_user`). Everything loads
  from the wider of the rank/heatmap windows (`loadSince`) — the overlay loaders take a
  `loadSinceDay` separate from their bucketing cutoff — so even when
  `USAGE_HEATMAP_DAYS` is narrower than the rank window it stays one shared pull. If
  that pull fails, the section's overlay fetch is skipped too (its cached rejection was
  already evicted) so a down proxy costs one timeout, not two.

`topAppsByActivity` / `topUsersByActivity` take an optional `RankBoost` (the section
totals + weights); they compute the peaks over their own candidates and apply the
pure, config-free `compositeBoost(...)` (in `src/usage.ts`, unit-tested directly).
User totals are keyed by portal **email** (the `end_user`/`user` field), so each user
candidate carries its email as its LLM key. The route wires `config.llmBoostMax` /
`config.llmBoostCostShare`; the dashboard intro switches to `dashboard.introComposite`
when the ranking actually used LLM data — i.e. a displayed top entity carries LLM
totals — rather than when the (heatmap-window) overlay has data, since the two windows
can differ when `USAGE_HEATMAP_DAYS` is narrower than the rank window.

---

## `buildHeatmap` / `HeatCell` (`src/usage.ts`)

`HeatCell` gains optional fields (absent when off or no data that day):

```typescript
export interface HeatCell {
  day: string | null;
  count: number;
  intensity: number;
  spend?: number;          // raw USD (tooltip)
  tokens?: number;         // raw total tokens (tooltip)
  spendIntensity?: number; // 0-100
  tokenIntensity?: number; // 0-100
}
```

`buildHeatmap` keeps its current `opts` (`scaleMax`, `timeZone` — the first draft
dropped `timeZone`; it must stay) and adds `llmByDay?: Map<string, {spend:number;
totalTokens:number}>`, `llmSpendScaleCents?: number`, `llmTokenScale?: number`.
Absent `llmByDay` ⇒ byte-identical output. The `llmByDay` keys are `usageDay`
strings, so they join the grid labels directly.

---

## CSS (`views/partials/head.ejs`)

New `:root` custom properties:
```css
--red-lo:#fca5a5; --red-hi:#b91c1c;   /* spend */
--blu-lo:#93c5fd; --blu-hi:#1d4ed8;   /* tokens */
```
Only the `.hm-cell.llm` variant restructures (14×14 relative box: 11×11 `.sq`
top-right + two 2px bars); the plain `.hm-cell` rules are untouched so the
activity-only path stays byte-identical.
```css
.hm-cell.llm { position:relative; width:14px; height:14px; background:transparent; border-radius:0; }
.hm-cell.llm .sq   { position:absolute; top:0; right:0; width:11px; height:11px; border-radius:2px; background:var(--hm-zero); display:block; }
.hm-cell.llm.on .sq { background:color-mix(in oklab, var(--hm-hi) calc(var(--i,0)*1%), var(--hm-lo)); }
.hm-cell.llm .bar-v { position:absolute; left:0; bottom:0; width:2px; height:11px; transform:scaleY(var(--lv,0)); transform-origin:bottom; border-radius:1px; }
.hm-cell.llm .bar-h { position:absolute; left:0; bottom:0; height:2px; width:11px; transform:scaleX(var(--lb,0)); transform-origin:left; border-radius:1px; }
.hm-cell.llm .bar-v.on { background:color-mix(in oklab, var(--red-hi) calc(var(--ir,0)*1%), var(--red-lo)); }
.hm-cell.llm .bar-h.on { background:color-mix(in oklab, var(--blu-hi) calc(var(--ib,0)*1%), var(--blu-lo)); }
```

---

## Heatmap partial (`views/partials/heatmap.ejs`)

Optional `llm` flag (default false). `false` ⇒ renders exactly as today (the
no-regression guarantee). `true` ⇒ active-or-LLM cells render the container form
with `.sq` + conditional `.bar-v`/`.bar-h` (length `--lv`/`--lb` = intensity/100,
colour `--ir`/`--ib` = intensity). Legend branches to a three-item legend when
`llm` is true.

---

## Score-line partial (`views/partials/score-row.ejs`)

New partial used by dashboard cards **and both detail pages** (which currently have
no score line — this adds one). Activity row always renders; spend (red) / tokens
(blue) rows render only when LLM data is present (omitted, never zeros). Reuses the
existing `.badge-window` styling.

---

## Error handling — inline, never a redirect

`src/flash.ts` is PRG (it issues a redirect), so it cannot warn + render in one GET
and would cause a redirect loop on a timing-out dashboard GET. Instead each section
wraps LLM work in `Promise.allSettled` + try/catch and sets a template
`llmWarning` flag (+ localized message) → a small muted inline banner. Per-card
failures are isolated.

---

## Routes (`src/routes/admin.ts`)

- **`GET /dashboard`** — when `config.llmProxyVendor` set: `Promise.allSettled`
  over `topApps.map(fetchAppLlmDaily)` and (when `llmProxyUserKey` set)
  `topUsers.map(u => fetchUserLlmDaily(u.email))`. Build per-card `llmByDay`;
  section peaks (`llmSpendScaleCents`/`llmTokenScale`) via the same `maxCount`
  pattern as `appScale`; per-card `scoreLlm` via `sumWindow` over the 30-day and
  full windows. `llm: true` for a section only if ≥1 card has data.
- **`GET /apps/:key`** — `fetchAppLlmDaily(key)`; build tri-metric heatmap + LLM
  score rows, or `llm:false` fallback; `llmWarning` on timeout.
- **`GET /users/:id`** — `fetchUserLlmDaily(target.email)`, gated on
  `llmProxyUserKey`; same pattern. **Per-user LLM data now appears on the user
  detail page too**, identically gated.

---

## Template changes
- `views/admin/dashboard.ejs` — replace each `dash-score` div with `score-row`
  includes; pass `llm` into the heatmap include; render `llmWarning` banner.
- `views/admin/app.ejs`, `views/admin/user.ejs` — add `score-row` includes (new to
  these pages), pass `llm`, render the banner.

---

## Locale strings

Add to `locales/en.json`, `locales/hi.json`, `locales/zh.json`:
```json
"llm": { "spend": "LLM", "tokens": "tokens",
         "timeout": "LLM usage data from {provider} is temporarily unavailable.",
         "legendSquare": "square = activity", "legendSpend": "bar = LLM spend",
         "legendTokens": "bar = tokens" }
```

---

## Testing

| Area | Verify |
|---|---|
| `intensityFor` reuse | green path byte-identical; cents/tokens same ramp; zero ⇒ no bar |
| `buildHeatmap` + `llmByDay` | LLM fields set; `timeZone` honoured; absent ⇒ identical to today |
| `sumWindow` | spend/token totals over 30-day and full windows |
| `fetchAppLlmDaily` (mocked fetch) | v2 pagination loop; hash→alias join; tz bucketing of `startTime`; no-alias ⇒ null; cache TTL; timeout ⇒ typed error |
| `fetchUserLlmDaily` (mocked) | matches on `end_user` (default) and `user_id`; unset `LLM_PROXY_USER_KEY` ⇒ null |
| Dashboard route | activity-only when off; tri-metric on mock data; inline warning (no redirect) on timeout; per-card isolation |
| Detail routes | same three scenarios; LLM present on app **and** user detail |
| Timezone | non-UTC zone buckets `startTime` to the correct local day (parity with activity) |

---

## Visual reference

14×14px LLM cell: 11×11 green square flush top-right; 2px red bar up the left edge
(spend); 2px blue bar along the bottom (tokens). Bar length and colour both follow
`intensityFor` against the section peak — identical ramp to the green square. Zero
draws nothing. No LLM data ⇒ the current single 11×11 cell, unchanged.

---

## Status

Both halves are implementable now against the verified contract:
- **Per-app** — via `/spend/logs/v2` rows grouped by `key_alias` (from `/key/list`).
- **Per-user** — via the `end_user` email dimension on the same rows
  (`LLM_PROXY_USER_KEY=end_user`).

Remaining soft-contract items for the operator: portal `app_key`s must match the
LiteLLM `key_alias`es, and apps must keep passing the portal email as the request
`user` param (so it lands in `end_user`) for per-user coverage.
