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

// Apps with the most active users over [sinceDay, today]. Each usageDaily row is
// one (user, app, day), so summing rows per app = total active user-days = the
// window's cumulative DAU. Names are joined in for display.
export async function topAppsByActivity(sinceDay: string, limit: number): Promise<AppActivity[]> {
  const rows = await col.usageDaily
    .aggregate<{ _id: string; active: number }>([
      { $match: { day: { $gte: sinceDay } } },
      { $group: { _id: '$app_key', active: { $sum: 1 } } },
      { $sort: { active: -1, _id: 1 } },
      { $limit: limit },
    ])
    .toArray();
  const apps = await col.apps.find({ key: { $in: rows.map((r) => r._id) } }).project({ key: 1, name: 1 }).toArray();
  const nameByKey = new Map(apps.map((a) => [a.key, (a as { name?: string }).name || a.key]));
  return rows.map((r) => ({ app_key: r._id, name: nameByKey.get(r._id) || r._id, active: r.active }));
}

// Most active users over the window (Σ active app-days), with emails joined in.
export async function topUsersByActivity(sinceDay: string, limit: number): Promise<UserActivity[]> {
  const rows = await col.usageDaily
    .aggregate<{ _id: ObjectId; active: number }>([
      { $match: { day: { $gte: sinceDay } } },
      { $group: { _id: '$user_id', active: { $sum: 1 } } },
      { $sort: { active: -1, _id: 1 } },
      { $limit: limit },
    ])
    .toArray();
  const ids = rows.map((r) => r._id);
  const users = await col.users.find({ _id: { $in: ids } }).project({ email: 1, name: 1 }).toArray();
  const byId = new Map(users.map((u) => [String(u._id), u as { email: string; name?: string }]));
  return rows
    .filter((r) => byId.has(String(r._id))) // drop deleted users
    .map((r) => {
      const u = byId.get(String(r._id)) as { email: string; name?: string };
      return { user_id: String(r._id), email: u.email, name: u.name || undefined, active: r.active };
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
  level: 0 | 1 | 2 | 3 | 4;
}
export interface Heatmap {
  weeks: HeatCell[][]; // each inner array is one week column, Mon..Sun
  max: number;
}

function levelFor(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}

// The weekday of a 'YYYY-MM-DD' label as a Monday-based index (0=Mon..6=Sun) —
// the grid runs Mon..Sun top-to-bottom. tz-independent, so parse as UTC midnight.
function weekdayOf(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// Build a GitHub-style contribution grid for the trailing `days` calendar days.
export function buildHeatmap(
  countsByDay: Map<string, number>,
  nowMs: number,
  days: number,
  timeZone: string = config.timezone,
): Heatmap {
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

  const cells: HeatCell[] = [];
  for (let i = 0; i < weekdayOf(labels[0]); i++) cells.push({ day: null, count: 0, level: 0 });
  let max = 0;
  for (const d of labels) {
    const count = countsByDay.get(d) || 0;
    if (count > max) max = count;
    cells.push({ day: d, count, level: levelFor(count) });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, count: 0, level: 0 });

  const weeks: HeatCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { weeks, max };
}
