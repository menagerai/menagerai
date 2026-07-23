import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ updateOne: vi.fn(), aggregate: vi.fn(), usersFind: vi.fn() }));

vi.mock('../src/config', () => ({ config: { timezone: 'Asia/Shanghai', usageTopLimit: 10, usageHeatmapDays: 365 } }));
vi.mock('../src/db', () => ({
  col: {
    usageDaily: { updateOne: h.updateOne, aggregate: h.aggregate },
    users: { find: h.usersFind },
  },
}));

import {
  buildHeatmap, dailyCountsForUser, heatmapSinceDay, recordUsage, topAppsForUser, topUsersForApp, usageDay,
} from '../src/usage';

const cursor = (rows: unknown[]) => ({ toArray: async () => rows });

beforeEach(() => {
  h.updateOne.mockReset();
  h.aggregate.mockReset();
  h.usersFind.mockReset();
  h.updateOne.mockResolvedValue({});
});

describe('usageDay — business-day bucketing', () => {
  it('rolls the Asia/Shanghai (UTC+8) day over at 16:00 UTC', () => {
    expect(usageDay(Date.UTC(2026, 5, 22, 15, 59, 59), 'Asia/Shanghai')).toBe('2026-06-22');
    expect(usageDay(Date.UTC(2026, 5, 22, 16, 0, 0), 'Asia/Shanghai')).toBe('2026-06-23');
  });
  it('honors other zones, including DST', () => {
    // New York is UTC-4 (EDT) in June.
    expect(usageDay(Date.UTC(2026, 5, 22, 2, 0, 0), 'America/New_York')).toBe('2026-06-21');
    expect(usageDay(Date.UTC(2026, 5, 22, 12, 0, 0), 'America/New_York')).toBe('2026-06-22');
  });
  it('zero-pads month and day', () => {
    expect(usageDay(Date.UTC(2026, 0, 5, 12, 0, 0), 'UTC')).toBe('2026-01-05');
  });
});

describe('heatmapSinceDay — trailing window cutoff', () => {
  const now = Date.UTC(2026, 5, 23, 12, 0, 0); // 2026-06-23 in Asia/Shanghai

  it('spans exactly `days` days INCLUDING today (n days, not n+1)', () => {
    // 30d ending 2026-06-23 → earliest day is 2026-05-25 (today + 29 prior = 30).
    expect(heatmapSinceDay(now, 30)).toBe('2026-05-25');
    // 1d → today only.
    expect(heatmapSinceDay(now, 1)).toBe('2026-06-23');
  });

  it('matches the leftmost cell buildHeatmap draws for the same window', () => {
    const days = 7;
    const hm = buildHeatmap(new Map(), now, days, 'Asia/Shanghai');
    const firstDay = hm.weeks.flat().find((c) => c.day)?.day;
    expect(heatmapSinceDay(now, days)).toBe(firstDay); // score cutoff == grid start
  });
});

describe('buildHeatmap — GitHub-style grid', () => {
  const now = Date.UTC(2026, 5, 23, 12, 0, 0); // 2026-06-23 in Asia/Shanghai

  it('lays out aligned week columns over the trailing window', () => {
    const counts = new Map([['2026-06-20', 3], ['2026-06-23', 7]]);
    const hm = buildHeatmap(counts, now, 7, 'Asia/Shanghai');
    const flat = hm.weeks.flat();
    const dayCells = flat.filter((c) => c.day);

    expect(dayCells.length).toBe(7); // no DST in Shanghai → exactly 7 days
    expect(hm.weeks.every((w) => w.length === 7)).toBe(true);
    expect(dayCells.find((c) => c.day === '2026-06-20')).toMatchObject({ count: 3, level: 2 });
    expect(dayCells.find((c) => c.day === '2026-06-23')).toMatchObject({ count: 7, level: 4 });
    expect(hm.max).toBe(7);

    // Leading padding aligns the first day to its weekday column (Mon-first grid).
    const wd = (new Date('2026-06-17T00:00:00Z').getUTCDay() + 6) % 7;
    expect(flat.slice(0, wd).every((c) => c.day === null)).toBe(true);
    expect(flat[wd].day).toBe('2026-06-17');
  });
});

describe('recordUsage — dedup + idempotent upsert', () => {
  it('writes once per (user,app,day), and again after the day changes', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 23, 12, 0, 0));
    const u = new ObjectId();
    await recordUsage(u, 'demo');
    await recordUsage(u, 'demo');
    expect(h.updateOne).toHaveBeenCalledTimes(1);

    const [filter, update, opts] = h.updateOne.mock.calls[0];
    expect(filter).toMatchObject({ app_key: 'demo', day: '2026-06-23' });
    expect(update.$setOnInsert).toMatchObject({ app_key: 'demo', day: '2026-06-23' });
    expect(update.$set).toHaveProperty('last_at'); // refreshed each hit; no app role (binary access)
    expect(update.$set).not.toHaveProperty('app_role');
    expect(opts).toMatchObject({ upsert: true });

    spy.mockReturnValue(Date.UTC(2026, 5, 25, 12, 0, 0)); // a later day
    await recordUsage(u, 'demo');
    expect(h.updateOne).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('never throws and retries after a failed write', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 1, 12, 0, 0));
    const u = new ObjectId();
    h.updateOne.mockRejectedValueOnce(new Error('boom'));
    await expect(recordUsage(u, 'sales')).resolves.toBeUndefined();
    await recordUsage(u, 'sales'); // dedup key was dropped on failure → retries
    expect(h.updateOne).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('usage reads', () => {
  it('topAppsForUser maps grouped rows and matches on the user', async () => {
    h.aggregate.mockReturnValue(cursor([{ _id: 'demo', days: 3, last: new Date('2026-06-23') }]));
    const r = await topAppsForUser(new ObjectId(), 10);
    expect(r).toEqual([{ app_key: 'demo', days: 3, last: new Date('2026-06-23') }]);
    const pipeline = h.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toHaveProperty('user_id');
    expect(pipeline.some((s: Record<string, unknown>) => s.$group)).toBe(true);
  });

  it('topUsersForApp joins emails and drops deleted users', async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    h.aggregate.mockReturnValue(cursor([
      { _id: id1, days: 5, last: new Date() },
      { _id: id2, days: 2, last: new Date() },
    ]));
    h.usersFind.mockReturnValue({ project: () => cursor([{ _id: id1, email: 'a@x.com' }]) }); // id2 gone
    const r = await topUsersForApp('demo', 10);
    expect(r.map((x) => x.email)).toEqual(['a@x.com']);
  });

  it('dailyCountsForUser returns a day→count map within the window', async () => {
    h.aggregate.mockReturnValue(cursor([{ _id: '2026-06-22', count: 2 }, { _id: '2026-06-23', count: 1 }]));
    const m = await dailyCountsForUser(new ObjectId(), '2026-01-01');
    expect(m.get('2026-06-22')).toBe(2);
    expect(h.aggregate.mock.calls[0][0][0].$match.day).toEqual({ $gte: '2026-01-01' });
  });
});
