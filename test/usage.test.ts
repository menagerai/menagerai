import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ updateOne: vi.fn(), aggregate: vi.fn(), usersFind: vi.fn(), appsFind: vi.fn() }));

vi.mock('../src/config', () => ({ config: { timezone: 'Asia/Shanghai', usageTopLimit: 10, usageHeatmapDays: 365 } }));
vi.mock('../src/db', () => ({
  col: {
    usageDaily: { updateOne: h.updateOne, aggregate: h.aggregate },
    users: { find: h.usersFind },
    apps: { find: h.appsFind },
  },
}));

import {
  buildHeatmap, compositeBoost, dailyCountsForUser, heatmapSinceDay, logNorm, recordUsage,
  topAppsByActivity, topUsersByActivity, topAppsForUser, topUsersForApp, usageDay,
} from '../src/usage';

const cursor = (rows: unknown[]) => ({ toArray: async () => rows });

beforeEach(() => {
  h.updateOne.mockReset();
  h.aggregate.mockReset();
  h.usersFind.mockReset();
  h.appsFind.mockReset();
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
    const hm = buildHeatmap(new Map(), now, days, { timeZone: 'Asia/Shanghai' });
    const firstDay = hm.weeks.flat().find((c) => c.day)?.day;
    expect(heatmapSinceDay(now, days)).toBe(firstDay); // score cutoff == grid start
  });
});

describe('buildHeatmap — GitHub-style grid', () => {
  const now = Date.UTC(2026, 5, 23, 12, 0, 0); // 2026-06-23 in Asia/Shanghai

  it('lays out aligned week columns over the trailing window', () => {
    const counts = new Map([['2026-06-20', 3], ['2026-06-23', 7]]);
    const hm = buildHeatmap(counts, now, 7, { timeZone: 'Asia/Shanghai' });
    const flat = hm.weeks.flat();
    const dayCells = flat.filter((c) => c.day);

    expect(dayCells.length).toBe(7); // no DST in Shanghai → exactly 7 days
    expect(hm.weeks.every((w) => w.length === 7)).toBe(true);
    // Anchored to this map's own peak (7): log(3)/log(7) ≈ .56, and the peak pins to 100.
    expect(dayCells.find((c) => c.day === '2026-06-20')).toMatchObject({ count: 3, intensity: 56 });
    expect(dayCells.find((c) => c.day === '2026-06-23')).toMatchObject({ count: 7, intensity: 100 });
    expect(hm.max).toBe(7);

    // Leading padding aligns the first day to its weekday column (Mon-first grid).
    const wd = (new Date('2026-06-17T00:00:00Z').getUTCDay() + 6) % 7;
    expect(flat.slice(0, wd).every((c) => c.day === null)).toBe(true);
    expect(flat[wd].day).toBe('2026-06-17');
  });

  const intensityOf = (hm: ReturnType<typeof buildHeatmap>, day: string) =>
    hm.weeks.flat().find((c) => c.day === day)?.intensity;

  it('shades against a caller-supplied anchor so grouped heatmaps stay comparable', () => {
    const counts = new Map([['2026-06-23', 7]]);
    const own = buildHeatmap(counts, now, 7, { timeZone: 'Asia/Shanghai' });
    const shared = buildHeatmap(counts, now, 7, { scaleMax: 40, timeZone: 'Asia/Shanghai' });

    // Same day, same count — but against a section peaking at 40 it is mid-ramp,
    // not the darkest cell. Without this every card would max out its own scale.
    expect(intensityOf(own, '2026-06-23')).toBe(100);
    expect(intensityOf(shared, '2026-06-23')).toBe(53);
  });

  it('floors the anchor so a quiet window does not read as a busy one', () => {
    const hm = buildHeatmap(new Map([['2026-06-23', 2]]), now, 7, { timeZone: 'Asia/Shanghai' });
    // Anchored to the MIN_SCALE_MAX floor of 6, not to its own peak of 2, so two
    // apps in a dead window stay pale instead of painting as full intensity.
    expect(hm.max).toBe(2);
    expect(intensityOf(hm, '2026-06-23')).toBe(39);
  });

  it('puts a single event at the light end of the ramp, never at zero-shade', () => {
    const hm = buildHeatmap(new Map([['2026-06-23', 1]]), now, 7, { scaleMax: 40, timeZone: 'Asia/Shanghai' });
    expect(intensityOf(hm, '2026-06-23')).toBe(0); // .on class still distinguishes it from an inactive day
    expect(intensityOf(hm, '2026-06-22')).toBe(0);
    expect(hm.weeks.flat().find((c) => c.day === '2026-06-23')?.count).toBe(1);
    expect(hm.weeks.flat().find((c) => c.day === '2026-06-22')?.count).toBe(0);
  });

  const cellOf = (hm: ReturnType<typeof buildHeatmap>, day: string) =>
    hm.weeks.flat().find((c) => c.day === day);

  it('leaves cells byte-identical when no llmByDay is given', () => {
    const counts = new Map([['2026-06-23', 7]]);
    const plain = buildHeatmap(counts, now, 7, { timeZone: 'Asia/Shanghai' });
    const cell = cellOf(plain, '2026-06-23');
    // No LLM fields leak onto the activity-only render.
    expect(cell).not.toHaveProperty('spend');
    expect(cell?.spendIntensity).toBeUndefined();
    expect(cell?.tokenIntensity).toBeUndefined();
  });

  it('overlays spend/tokens on the same ramp as the green square, anchored to the section peak', () => {
    const counts = new Map([['2026-06-23', 3]]);
    const llmByDay = new Map([
      ['2026-06-23', { spend: 2.0, totalTokens: 1000 }], // section peak
      ['2026-06-22', { spend: 0.5, totalTokens: 250 }],
    ]);
    // Peaks: spend 2.00 => 200 cents; tokens 1000.
    const hm = buildHeatmap(counts, now, 7, {
      timeZone: 'Asia/Shanghai', llmByDay, llmSpendScaleCents: 200, llmTokenScale: 1000,
    });
    const peak = cellOf(hm, '2026-06-23');
    expect(peak).toMatchObject({ spend: 2.0, tokens: 1000, spendIntensity: 100, tokenIntensity: 100 });
    const lo = cellOf(hm, '2026-06-22');
    // log(50)/log(200) ≈ 0.738 -> 74 ; log(250)/log(1000) ≈ 0.799 -> 80
    expect(lo).toMatchObject({ spend: 0.5, tokens: 250, spendIntensity: 74, tokenIntensity: 80 });
  });

  it('emits no bar for a day with zero spend/tokens even when other days have LLM data', () => {
    const llmByDay = new Map([
      ['2026-06-23', { spend: 1.0, totalTokens: 500 }],
      ['2026-06-22', { spend: 0, totalTokens: 0 }],
    ]);
    const hm = buildHeatmap(new Map(), now, 7, { timeZone: 'Asia/Shanghai', llmByDay, llmSpendScaleCents: 100, llmTokenScale: 500 });
    const zero = cellOf(hm, '2026-06-22');
    // spend/tokens are recorded as 0, so the view renders no bar (c.spend > 0 gate).
    expect(zero).toMatchObject({ spend: 0, tokens: 0, spendIntensity: 0, tokenIntensity: 0 });
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

describe('logNorm — log ramp anchored at the section peak', () => {
  it('maps the peak to 1 and non-positive values to 0', () => {
    expect(logNorm(30, 30)).toBe(1);
    expect(logNorm(0, 30)).toBe(0);
    expect(logNorm(-5, 30)).toBe(0);
  });
  it('is monotonic between 1 and the peak', () => {
    expect(logNorm(10, 30)).toBeGreaterThan(0);
    expect(logNorm(10, 30)).toBeLessThan(logNorm(20, 30));
    expect(logNorm(20, 30)).toBeLessThan(1);
  });
  it('floors sub-1 values (e.g. sub-$1 spend) at 0 and copes with a degenerate peak', () => {
    expect(logNorm(0.5, 100)).toBe(0);
    expect(logNorm(1, 1)).toBe(1); // peak <= 1
  });
});

describe('compositeBoost — the LLM ranking boost', () => {
  it('is 0 when the entity has no spend or tokens (never demoted)', () => {
    expect(compositeBoost(0, 0, 100, 1e9, 0.5, 0.8)).toBe(0);
  });
  it('weights cost over tokens at equal normalised magnitude', () => {
    const costHeavy = compositeBoost(100, 0, 100, 1e9, 0.5, 0.8); // spend at peak, no tokens
    const tokenHeavy = compositeBoost(0, 1e9, 100, 1e9, 0.5, 0.8); // tokens at peak, no spend
    expect(costHeavy).toBeGreaterThan(tokenHeavy);
    expect(costHeavy).toBeCloseTo(0.5 * 0.8, 10);
    expect(tokenHeavy).toBeCloseTo(0.5 * 0.2, 10);
  });
  it('is bounded by boostMax when both signals peak, and scales with it', () => {
    expect(compositeBoost(100, 1e9, 100, 1e9, 0.5, 0.8)).toBeCloseTo(0.5, 10);
    expect(compositeBoost(100, 1e9, 100, 1e9, 1.0, 0.8)).toBeCloseTo(1.0, 10);
  });
});

describe('topAppsByActivity — composite ranking', () => {
  // Names for the survivors; the join tolerates extra rows, so return all three.
  const withNames = () => {
    h.appsFind.mockReturnValue({
      project: () => cursor([{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }, { key: 'c', name: 'C' }]),
    });
  };
  const rows = () => cursor([
    { _id: 'a', active: 10 },
    { _id: 'b', active: 30 },
    { _id: 'c', active: 20 },
  ]);

  it('ranks by activity descending when no boost is given, dropping sort/limit into JS', async () => {
    h.aggregate.mockReturnValue(rows());
    withNames();
    const r = await topAppsByActivity('2026-01-01', 3);
    expect(r.map((x) => x.app_key)).toEqual(['b', 'c', 'a']);
    // ranks across all entities — the aggregate no longer sorts/limits in the store
    const pipeline = h.aggregate.mock.calls[0][0];
    expect(pipeline.some((s: Record<string, unknown>) => s.$sort || s.$limit != null)).toBe(false);
  });

  it('a zero boost leaves the activity order unchanged', async () => {
    h.aggregate.mockReturnValue(rows());
    withNames();
    const r = await topAppsByActivity('2026-01-01', 3, () => 0);
    expect(r.map((x) => x.app_key)).toEqual(['b', 'c', 'a']);
  });

  it('a boost can promote a lower-activity app into (and up) the top N', async () => {
    h.aggregate.mockReturnValue(rows());
    withNames();
    // 'a' has the least activity but a large boost — it should surface into top 2.
    const r = await topAppsByActivity('2026-01-01', 2, (k) => (k === 'a' ? 1 : 0));
    expect(r[0].app_key).toBe('a');
    expect(r.map((x) => x.app_key)).toContain('b');
    expect(r).toHaveLength(2);
  });
});

describe('topUsersByActivity — composite ranking keys the boost by email', () => {
  const id1 = new ObjectId();
  const id2 = new ObjectId();
  const setup = () => {
    h.aggregate.mockReturnValue(cursor([
      { _id: id1, active: 30 }, // most active
      { _id: id2, active: 10 },
    ]));
    h.usersFind.mockReturnValue({
      project: () => cursor([{ _id: id1, email: 'big@x.com' }, { _id: id2, email: 'small@x.com' }]),
    });
  };

  it('ranks by activity when no boost is given', async () => {
    setup();
    const r = await topUsersByActivity('2026-01-01', 2);
    expect(r.map((x) => x.email)).toEqual(['big@x.com', 'small@x.com']);
  });

  it('invokes the boost with the portal email (not the user id) and can promote', async () => {
    setup();
    const seen: string[] = [];
    // Boost keyed by EMAIL — the regression this guards: a user-id key would miss.
    const boost = (email: string): number => {
      seen.push(email);
      return email === 'small@x.com' ? 1 : 0;
    };
    const r = await topUsersByActivity('2026-01-01', 2, boost);
    expect(seen.sort()).toEqual(['big@x.com', 'small@x.com']); // called with emails
    expect(r[0].email).toBe('small@x.com'); // lifted above the more-active user
  });
});
