/* Read-only diagnostic for the dashboard 30d vs full-window activity scores.
 * Reuses the app's own compiled code paths (dist/*) against the live store.
 * Run inside the production container, e.g. piped over stdin:
 *   docker exec -i <container> node - < scripts/diag-usage.cjs
 * or copied in and run:  node diag-usage.cjs
 * Requires the app to have been built (dist/ present) and the usual env
 * (MONGODB_CONN_STR, MONGODB_DB, USAGE_HEATMAP_DAYS, TIMEZONE) available.
 */
const fs = require('fs');
const path = require('path');
// Locate the app's dist/ without relying on __dirname (undefined via stdin).
const ROOT = [process.cwd(), '/app', path.join(__dirname || '.', '..')]
  .find((r) => { try { return fs.existsSync(path.join(r, 'dist', 'config.js')); } catch { return false; } });
if (!ROOT) { console.error('Could not locate dist/ — run from the app root (/app).'); process.exit(1); }
const R = (p) => require(path.join(ROOT, 'dist', p));

(async () => {
  const { config } = R('config.js');
  const db = R('db.js');
  const usage = R('usage.js');
  const {
    heatmapSinceDay,
    DASHBOARD_RANK_DAYS,
    usageDay,
    topAppsByActivity,
    topUsersByActivity,
    dailyCountsForApp,
    dailyCountsForUser,
  } = usage;

  await db.connect();
  const backend = db.usingSqlite() ? 'sqlite' : 'mongodb';

  const now = Date.now();
  const rankSince = heatmapSinceDay(now, DASHBOARD_RANK_DAYS); // 30d cutoff
  const heatSince = heatmapSinceDay(now, config.usageHeatmapDays); // full-window cutoff

  const sum = (m) => { let n = 0; m.forEach((v) => { n += v; }); return n; };

  console.log('=== config / windows ===');
  console.log({
    backend,
    timezone: config.timezone,
    today: usageDay(now),
    DASHBOARD_RANK_DAYS,
    usageHeatmapDays: config.usageHeatmapDays,
    rankSince_30d_cutoff: rankSince,
    heatSince_full_cutoff: heatSince,
  });

  // Overall day distribution straight from the collection.
  const all = await db.col.usageDaily.find({}).toArray();
  const days = all.map((r) => r.day).filter(Boolean).sort();
  const inRank = all.filter((r) => r.day >= rankSince).length;
  const inHeat = all.filter((r) => r.day >= heatSince).length;
  const between = all.filter((r) => r.day >= heatSince && r.day < rankSince).length;
  console.log('\n=== usage_daily distribution ===');
  console.log({
    totalRows: all.length,
    minDay: days[0] ?? null,
    maxDay: days[days.length - 1] ?? null,
    rows_within_30d: inRank,
    rows_within_full_window: inHeat,
    rows_between_30d_and_full: between, // >0 means 150d MUST exceed 30d per card
    rows_older_than_full_window: all.length - inHeat,
  });

  // Rows per day (compact), so you can eyeball where activity actually sits.
  const byDay = new Map();
  for (const r of all) byDay.set(r.day, (byDay.get(r.day) || 0) + 1);
  const perDay = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  console.log('\n=== rows per day (day: count) ===');
  console.log(perDay.map(([d, c]) => `${d}: ${c}`).join('\n'));

  // Reproduce the dashboard cards exactly.
  const limit = config.dashboardTopLimit;
  const [topApps, topUsers] = await Promise.all([
    topAppsByActivity(rankSince, limit),
    topUsersByActivity(rankSince, limit),
  ]);

  console.log('\n=== Top apps: active(30d) vs scoreFull(full) ===');
  for (const a of topApps) {
    const counts = await dailyCountsForApp(a.app_key, heatSince);
    console.log({ app: a.app_key, active_30d: a.active, scoreFull_full: sum(counts), heatmapDaysCovered: counts.size });
  }

  console.log('\n=== Top users: active(30d) vs scoreFull(full) ===');
  for (const u of topUsers) {
    const counts = await dailyCountsForUser(u.user_id, heatSince);
    console.log({ user: u.email, active_30d: u.active, scoreFull_full: sum(counts), heatmapDaysCovered: counts.size });
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
