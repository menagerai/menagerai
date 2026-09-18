import { ObjectId } from 'mongodb';
import { col } from './db';
import { config } from './config';

// ---- Day bucketing (pure) ----

// The business day ('YYYY-MM-DD') for an instant, in the given IANA timezone.
// en-CA formats as YYYY-MM-DD; the timeZone option applies the zone offset (any
// IANA zone, DST included). Pure and deterministic — unit-testable.
export function usageDay(ms: number, timeZone: string = config.timezone): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function toOid(id: ObjectId | string): ObjectId {
  return typeof id === 'string' ? new ObjectId(id) : id;
}

// ---- Write path ----

// In-process write-suppression: once we've recorded (user, app) for the current
// day in this process, skip the DB entirely (the asset/XHR-storm common case).
// Correctness does NOT depend on this — the unique (user_id, app_key, day) index
// makes the upsert idempotent across restarts and replicas. The set is bounded
// by today's active pairs and cleared on day rollover.
const seen = new Set<string>();
let seenDay = '';

// Drop the in-process write-suppression set. Used by the demo-mode reset, which
// wipes usage_daily: without this, `seen` would keep suppressing the DB write for
// any (user, app) already recorded today, so post-reset activity would silently
// not re-appear until the day rolls over. A no-op for normal operation.
export function clearUsageDedup(): void {
  seen.clear();
  seenDay = '';
}

// Record one successful access. Best-effort, like audit(): never throws, so the
// gateway can fire-and-forget it without awaiting and without risking the request.
export async function recordUsage(
  userId: ObjectId | string,
  appKey: string,
): Promise<void> {
  const day = usageDay(Date.now());
  if (day !== seenDay) {
    seen.clear();
    seenDay = day;
  }
  const key = `${String(userId)}:${appKey}:${day}`;
  if (seen.has(key)) return;
  seen.add(key);

  try {
    const now = new Date();
    const oid = toOid(userId);
    await col.usageDaily.updateOne(
      { user_id: oid, app_key: appKey, day },
      { $setOnInsert: { user_id: oid, app_key: appKey, day, first_at: now }, $set: { last_at: now } },
      { upsert: true },
    );
  } catch (err) {
    // Don't poison the dedup entry: drop it so a later request retries the write.
    seen.delete(key);
    console.error('usage write failed', err);
  }
}

// ---- Read path: totals ----

export interface AppUsageRow {
  app_key: string;
  days: number;
  last: Date | null;
}
export interface UserUsageRow {
  user_id: string;
  email: string;
  days: number;
  last: Date | null;
}

// Apps this user has used most (by active-day count).
export async function topAppsForUser(userId: ObjectId | string, limit: number): Promise<AppUsageRow[]> {
  const rows = await col.usageDaily
    .aggregate<{ _id: string; days: number; last: Date }>([
      { $match: { user_id: toOid(userId) } },
      { $group: { _id: '$app_key', days: { $sum: 1 }, last: { $max: '$last_at' } } },
      { $sort: { days: -1, last: -1 } },
      { $limit: limit },
    ])
    .toArray();
  return rows.map((r) => ({ app_key: r._id, days: r.days, last: r.last ?? null }));
}

// Power users of this app (by active-day count), with emails resolved by join.
export async function topUsersForApp(appKey: string, limit: number): Promise<UserUsageRow[]> {
  const rows = await col.usageDaily
    .aggregate<{ _id: ObjectId; days: number; last: Date }>([
      { $match: { app_key: appKey } },
      { $group: { _id: '$user_id', days: { $sum: 1 }, last: { $max: '$last_at' } } },
      { $sort: { days: -1, last: -1 } },
      { $limit: limit },
    ])
    .toArray();
  const ids = rows.map((r) => r._id);
  const users = await col.users.find({ _id: { $in: ids } }).project({ email: 1 }).toArray();
  const emailById = new Map(users.map((u) => [String(u._id), (u as { email: string }).email]));
  return rows
    .filter((r) => emailById.has(String(r._id))) // drop deleted users
    .map((r) => ({ user_id: String(r._id), email: emailById.get(String(r._id)) as string, days: r.days, last: r.last ?? null }));
}

// ---- Read path: global activity rankings (dashboard) ----

// The dashboard ranks by RECENT activity, not all-time totals — a shorter window
// so the lists track what's busy now. The per-card heatmaps still cover the full
// USAGE_HEATMAP_DAYS window (the same view as each entity's own page).
export const DASHBOARD_RANK_DAYS = 30;

export interface AppActivity {
  app_key: string;
  name: string;
  active: number; // active user-days in the window (Σ DAU)
}
export interface UserActivity {
  user_id: string;
  email: string;
  name?: string; // optional — users may have no name set
  active: number; // active app-days in the window
}

// Rank entities by a composite score = log-normalised activity (anchored to the
// section's busiest entity) + an optional additive LLM boost, then take the top
// `limit`. The boost lifts heavier LLM users without ever demoting entities that
// have none (their boost is 0). With no boost function the score is monotonic in
// activity, so the order — and its (active desc, key asc) tie-break — is identical
// to a plain activity ranking. Ranking happens across ALL entities in the window
// (names are joined only for the survivors), so an LLM-heavy entity can climb into
// the list, not merely reorder within it.
type Ranked = { key: string; active: number };
function rankByActivity(entities: Ranked[], limit: number, boost?: (key: string) => number): Ranked[] {
  let peak = 0;
  for (const e of entities) if (e.active > peak) peak = e.active;
  return entities
    .map((e) => ({ e, score: logNorm(e.active, peak) + (boost ? boost(e.key) : 0) }))
    .sort((a, b) => b.score - a.score || b.e.active - a.e.active || (a.e.key < b.e.key ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.e);
}

// Apps with the most active users over [sinceDay, today]. Each usageDaily row is
// one (user, app, day), so summing rows per app = total active user-days = the
// window's cumulative DAU. `boost` (optional) folds LLM usage into the ranking.
// Names are joined in for display.
export async function topAppsByActivity(
  sinceDay: string,
  limit: number,
  boost?: (key: string) => number,
): Promise<AppActivity[]> {
  const rows = await col.usageDaily
    .aggregate<{ _id: string; active: number }>([
      { $match: { day: { $gte: sinceDay } } },
      { $group: { _id: '$app_key', active: { $sum: 1 } } },
    ])
    .toArray();
  const top = rankByActivity(rows.map((r) => ({ key: r._id, active: r.active })), limit, boost);
  const apps = await col.apps.find({ key: { $in: top.map((t) => t.key) } }).project({ key: 1, name: 1 }).toArray();
  const nameByKey = new Map(apps.map((a) => [a.key, (a as { name?: string }).name || a.key]));
  return top.map((t) => ({ app_key: t.key, name: nameByKey.get(t.key) || t.key, active: t.active }));
}

// Most active users over the window (Σ active app-days), with emails joined in.
// `boost` (optional) folds LLM usage into the ranking, keyed by portal EMAIL — the
// LiteLLM end_user/user field the totals are keyed by, not the user id — so emails
// are joined BEFORE ranking (which also drops deleted users up front rather than
// after the cut).
export async function topUsersByActivity(
  sinceDay: string,
  limit: number,
  boost?: (email: string) => number,
): Promise<UserActivity[]> {
  const rows = await col.usageDaily
    .aggregate<{ _id: ObjectId; active: number }>([
      { $match: { day: { $gte: sinceDay } } },
      { $group: { _id: '$user_id', active: { $sum: 1 } } },
    ])
    .toArray();
  const users = await col.users.find({ _id: { $in: rows.map((r) => r._id) } }).project({ email: 1, name: 1 }).toArray();
  const byId = new Map(users.map((u) => [String(u._id), u as { email: string; name?: string }]));
  const candidates = rows.flatMap((r) => {
    const u = byId.get(String(r._id));
    return u ? [{ key: String(r._id), active: r.active, email: u.email, name: u.name || undefined }] : []; // drop deleted
  });
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const boostById = boost ? (id: string): number => boost(byKey.get(id)?.email ?? '') : undefined;
  const top = rankByActivity(candidates.map((c) => ({ key: c.key, active: c.active })), limit, boostById);
  return top.map((t) => {
    const c = byKey.get(t.key) as { email: string; name?: string; active: number };
    return { user_id: t.key, email: c.email, name: c.name, active: c.active };
  });
}

// ---- Read path: heatmap (per-day intensity) ----

async function dailyCounts(match: Record<string, unknown>, sinceDay: string): Promise<Map<string, number>> {
  const rows = await col.usageDaily
    .aggregate<{ _id: string; count: number }>([
      { $match: { ...match, day: { $gte: sinceDay } } },
      { $group: { _id: '$day', count: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.count]));
}

// Per-day count of distinct apps this user touched (heatmap intensity).
export function dailyCountsForUser(userId: ObjectId | string, sinceDay: string): Promise<Map<string, number>> {
  return dailyCounts({ user_id: toOid(userId) }, sinceDay);
}

// Per-day count of distinct users active on this app (heatmap intensity).
export function dailyCountsForApp(appKey: string, sinceDay: string): Promise<Map<string, number>> {
  return dailyCounts({ app_key: appKey }, sinceDay);
}

// Cutoff day for a trailing window of exactly `days` days INCLUDING today. The
// window is [cutoff, today] with an inclusive `day >= cutoff` match, so the
// cutoff is (days-1) back: today plus the previous days-1 = `days` days total —
// the same span buildHeatmap draws. (Using `days` here would reach one day
// older than the grid's leftmost cell, i.e. 31 days for a "30d" label.)
export function heatmapSinceDay(nowMs: number, days: number): string {
  return usageDay(nowMs - (days - 1) * 86_400_000);
}

// ---- Heatmap builder (pure) ----

export interface HeatCell {
  day: string | null; // null = padding cell to align the grid
  count: number;
  intensity: number; // 0-100 along the shading ramp; 0 = no activity
  // LLM overlay — populated only when buildHeatmap is given llmByDay and this day
  // has LLM data. Absent otherwise, so the activity-only render is unchanged.
  spend?: number; // raw USD (tooltip)
  tokens?: number; // raw total tokens (tooltip)
  spendIntensity?: number; // 0-100, same ramp as the green square (spend in cents)
  tokenIntensity?: number; // 0-100, same ramp as the green square (tokens)
}
export interface Heatmap {
  weeks: HeatCell[][]; // each inner array is one week column, Mon..Sun
  max: number; // busiest day in this heatmap (not necessarily the shading anchor)
}

// Floor under the shading scale. Without it a dead window (peak 1-2) would paint
// trivial activity at full intensity; with it, quiet windows stay visibly quiet
// and the scale only stretches once the data outgrows this.
const MIN_SCALE_MAX = 6;

// Position of a day on the shading ramp, 0-100 (0 = no activity, 100 = the
// busiest day the scale is anchored to). The view mixes this percentage between
// two greens, so shading is continuous rather than a handful of buckets — enough
// resolution that neighbouring counts stay tellable apart.
//
// Anchoring to `scaleMax` instead of fixed thresholds lets a heatmap peaking at
// 40 and one peaking at 6 both use the whole ramp. The log keeps the low end
// legible: normalising linearly against a heavy tail would crush 1-5 — where
// most days live — into near-identical shades. count 1 sits at the ramp's light
// end, count === scaleMax at its dark end:
//   scaleMax 40 -> 1:0  2:19  3:30  5:44  10:62  20:81  40:100
//   scaleMax  6 -> 1:0  2:39  3:61  4:77   5:90         6:100
// Log-scaled position of `value` on a 0..1 ramp anchored at `peak` (the section's
// busiest entity/day). The section peak maps to 1, and the log keeps the low end
// legible instead of crushing it against a heavy tail. Values at or below 1, or a
// degenerate peak <= 1, collapse to the ends. Shared by heatmap shading (via
// intensityFor) and the dashboard's composite ranking, so both normalise usage,
// spend and tokens the same way.
export function logNorm(value: number, peak: number): number {
  if (value <= 0) return 0;
  if (peak <= 1 || value >= peak) return 1;
  const t = Math.log(value) / Math.log(peak);
  return t < 0 ? 0 : t; // fractional values (e.g. sub-$1 spend) fall below the ramp
}

function intensityFor(count: number, scaleMax: number): number {
  return Math.round(100 * logNorm(count, scaleMax)); // scaleMax >= MIN_SCALE_MAX
}

// The dashboard LLM ranking boost for one entity: log-normalised spend and tokens
// (each anchored to the section peak), weighted `costShare` toward cost and scaled
// by `boostMax`. Pure and config-free so the route and tests share one definition.
// Zero spend and tokens => 0 (entity never demoted); cost outweighs tokens at equal
// normalised magnitude whenever costShare > 0.5. See design/llm-usage-plan.md.
export function compositeBoost(
  spend: number,
  tokens: number,
  spendPeak: number,
  tokenPeak: number,
  boostMax: number,
  costShare: number,
): number {
  return boostMax * (costShare * logNorm(spend, spendPeak) + (1 - costShare) * logNorm(tokens, tokenPeak));
}

// The weekday of a 'YYYY-MM-DD' label as a Monday-based index (0=Mon..6=Sun) —
// the grid runs Mon..Sun top-to-bottom. tz-independent, so parse as UTC midnight.
function weekdayOf(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// Build a GitHub-style contribution grid for the trailing `days` calendar days.
//
// `scaleMax` anchors the deepest shade. Pass it to shade a group of heatmaps
// against a shared peak so they stay comparable side by side; omit it and each
// heatmap anchors to its own busiest day. Either way it is floored at
// MIN_SCALE_MAX.
export function buildHeatmap(
  countsByDay: Map<string, number>,
  nowMs: number,
  days: number,
  opts: {
    scaleMax?: number;
    timeZone?: string;
    // LLM overlay. When llmByDay is present, each day it covers also gets the
    // spend/tokens cell fields. Both metrics use the SAME intensityFor ramp as
    // the green square, anchored to the section peak passed here (spend in cents,
    // tokens as-is). Absent => output is byte-identical to the activity-only view.
    llmByDay?: Map<string, { spend: number; totalTokens: number }>;
    llmSpendScaleCents?: number; // peak daily spend across the section, in cents
    llmTokenScale?: number; // peak daily tokens across the section
  } = {},
): Heatmap {
  const timeZone = opts.timeZone ?? config.timezone;
  // Ordered, de-duplicated day labels (dedupe guards DST-transition wobble from
  // the fixed 24h step).
  const labels: string[] = [];
  let prev = '';
  for (let i = days - 1; i >= 0; i--) {
    const d = usageDay(nowMs - i * 86_400_000, timeZone);
    if (d !== prev) {
      labels.push(d);
      prev = d;
    }
  }

  // Two passes: the shading anchor has to be known before any cell can be shaded.
  const counts = labels.map((d) => countsByDay.get(d) || 0);
  const max = counts.reduce((a, b) => Math.max(a, b), 0);
  const scale = Math.max(opts.scaleMax ?? max, MIN_SCALE_MAX);

  // LLM scales share the green ramp's MIN_SCALE_MAX floor, so log(scale) stays
  // positive and a quiet section doesn't paint trivial usage at full intensity.
  const spendScale = Math.max(opts.llmSpendScaleCents ?? 0, MIN_SCALE_MAX);
  const tokenScale = Math.max(opts.llmTokenScale ?? 0, MIN_SCALE_MAX);

  const cells: HeatCell[] = [];
  for (let i = 0; i < weekdayOf(labels[0]); i++) cells.push({ day: null, count: 0, intensity: 0 });
  labels.forEach((d, i) => {
    const cell: HeatCell = { day: d, count: counts[i], intensity: intensityFor(counts[i], scale) };
    const llm = opts.llmByDay?.get(d);
    if (llm) {
      const cents = Math.round(llm.spend * 100);
      cell.spend = llm.spend;
      cell.tokens = llm.totalTokens;
      cell.spendIntensity = intensityFor(cents, spendScale);
      cell.tokenIntensity = intensityFor(llm.totalTokens, tokenScale);
    }
    cells.push(cell);
  });
  while (cells.length % 7 !== 0) cells.push({ day: null, count: 0, intensity: 0 });

  const weeks: HeatCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { weeks, max };
}
