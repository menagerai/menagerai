import express, { Response, Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { ObjectId } from 'mongodb';
import { flash } from '../flash';
import { col } from '../db';
import { decide } from '../decide';
import { requireAdmin } from '../middleware/auth';
import { config } from '../config';
import { managementConfigured } from '../idp/config';
import { buildHeatmap, dailyCountsForApp, dailyCountsForUser, heatmapSinceDay, topAppsForUser, topUsersForApp, topAppsByActivity, topUsersByActivity, DASHBOARD_RANK_DAYS } from '../usage';
import { parseRoster } from '../admin-logic';
import { ApiError, NotFoundError } from '../services/errors';
import { isSuperadmin, PROTECTED_ROLE } from '../services/common';
import * as usersSvc from '../services/users';
import * as rolesSvc from '../services/roles';
import * as appsSvc from '../services/apps';
import * as rulesSvc from '../services/emailRules';
import { createApiKey, listApiKeys, maskedDisplay, revokeApiKey } from '../services/apiKeys';
import { buildOpenApiDocument } from '../api/openapi';
import { swaggerAssetsPath, swaggerHtml } from '../api/docs';

// Batch user import accepts a small spreadsheet in memory; cap the size and the
// row count so a stray upload can't exhaust memory or hammer Logto.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const IMPORT_MAX_ROWS = 5000;

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// Expose the active path so the sidebar can highlight the current section
// (read in partials/head via res.locals). The sidebar itself shows for any
// admin (isAdmin), on every page — not just under /admin.
adminRouter.use((req, res, next) => {
  res.locals.activePath = req.baseUrl + (req.path === '/' ? '' : req.path); // e.g. /admin, /admin/users
  next();
});

function oid(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}
function actor(req: { user?: { _id?: unknown } | null }): string {
  return req.user?._id ? String(req.user._id) : 'unknown';
}

// Map a service error onto a UI response: a missing resource is the plain 404
// page; a validation/precondition ApiError flashes its (i18n) message back to
// `base`; anything else is an unexpected 500. This keeps the admin pages behaving
// exactly as before while the rules live in the shared services.
function fail(res: Response, base: string, err: unknown): void {
  if (err instanceof NotFoundError) {
    res.status(404).send('Not found');
    return;
  }
  if (err instanceof ApiError) {
    flash(res, base, err.i18nKey, err.vars, err.level);
    return;
  }
  console.error('admin handler error', err);
  res.status(500).send('Internal error');
}

// Admin landing → the dashboard (first sidebar item, the panel's overview).
adminRouter.get('/', (_req, res) => res.redirect('/admin/dashboard'));

// ---- Dashboard ----
// Overview of recent activity: Top apps and Top users, each ranked by activity
// over a short trailing window (DASHBOARD_RANK_DAYS) so the lists track what's
// busy now. Every card carries the same full-window heatmap shown on that
// entity's own page, and links through to it.
adminRouter.get('/dashboard', async (req, res) => {
  const now = Date.now();
  const rankSince = heatmapSinceDay(now, DASHBOARD_RANK_DAYS);
  const heatSince = heatmapSinceDay(now, config.usageHeatmapDays);
  const limit = config.dashboardTopLimit;
  const [topApps, topUsers] = await Promise.all([
    topAppsByActivity(rankSince, limit),
    topUsersByActivity(rankSince, limit),
  ]);
  // Each card carries the full-window heatmap and an activity score over both
  // windows: `active` is Σ DAU over the short rank window; `scoreFull` is Σ DAU
  // over the heatmap window (the same days the heatmap draws). sumCounts folds
  // the per-day counts we already fetched for the heatmap.
  const sumCounts = (m: Map<string, number>): number => {
    let n = 0;
    m.forEach((v) => { n += v; });
    return n;
  };
  const [appCards, userCards] = await Promise.all([
    Promise.all(topApps.map(async (a) => {
      const counts = await dailyCountsForApp(a.app_key, heatSince);
      return { ...a, scoreFull: sumCounts(counts), heatmap: buildHeatmap(counts, now, config.usageHeatmapDays) };
    })),
    Promise.all(topUsers.map(async (u) => {
      const counts = await dailyCountsForUser(u.user_id, heatSince);
      return { ...u, scoreFull: sumCounts(counts), heatmap: buildHeatmap(counts, now, config.usageHeatmapDays) };
    })),
  ]);
  res.render('admin/dashboard', {
    user: req.user, isAdmin: true,
    appCards, userCards,
    heatmapDays: config.usageHeatmapDays, rankDays: DASHBOARD_RANK_DAYS, topN: limit,
  });
});

// ---- Users ----
adminRouter.get('/users', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const users = await usersSvc.listUsers(q || undefined);
  res.render('admin/users', { user: req.user, isAdmin: true, users, q, managementConfigured: managementConfigured(), msg: req.query.msg || null });
});

adminRouter.get('/users/new', async (req, res) => {
  const roles = await col.roles.find().sort({ key: 1 }).toArray();
  res.render('admin/user-new', { user: req.user, isAdmin: true, roles, managementConfigured: managementConfigured() });
});

adminRouter.post('/users', async (req, res) => {
  try {
    const { id } = await usersSvc.createUser(
      { email: req.body.email, name: req.body.name, department: req.body.department, roles: req.body.roles },
      actor(req),
    );
    flash(res, `/admin/users/${id}`, 'flash.userCreated');
  } catch (err) {
    fail(res, '/admin/users/new', err);
  }
});

// --- Batch user import (Excel/CSV). Defined BEFORE /users/:id so the :id route
// doesn't capture the literal "import" segment. ---
adminRouter.get('/users/import', async (req, res) => {
  // Only EXTERNAL roles (key starts with ext_) are assignable in bulk — a guard so
  // a batch import can never accidentally grant a privileged role.
  const roles = (await col.roles.find().sort({ key: 1 }).toArray()).filter((r) => r.key.startsWith('ext_'));
  res.render('admin/users-import', { user: req.user, isAdmin: true, roles, managementConfigured: managementConfigured() });
});

adminRouter.post('/users/import', importUpload.single('file'), async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return flash(res, '/admin/users/import', 'flash.importNoFile');
  }
  const autoRule = req.body.auto_rule === 'on';
  const role = String(req.body.role || '').trim();

  // First worksheet → 2-D cell array → { email, name } roster. (File parsing stays
  // in the UI; the API import endpoint accepts the roster as JSON directly.)
  let roster: { email: string; name: string }[];
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = sheet ? (XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' }) as unknown[][]) : [];
    roster = parseRoster(rows);
  } catch (err) {
    console.error('roster parse failed', err);
    return flash(res, '/admin/users/import', 'flash.importParseFailed');
  }
  if (roster.length === 0) return flash(res, '/admin/users/import', 'flash.importEmpty');
  if (roster.length > IMPORT_MAX_ROWS) {
    return flash(res, '/admin/users/import', 'flash.importTooManyRows', { max: IMPORT_MAX_ROWS });
  }

  try {
    const { counts, problems, role: appliedRole } = await usersSvc.importRoster(
      roster,
      { role, autoRule, source: String(req.file.originalname || '').trim() },
      actor(req),
    );
    res.render('admin/users-import-result', { user: req.user, isAdmin: true, counts, problems, role: appliedRole });
  } catch (err) {
    fail(res, '/admin/users/import', err);
  }
});

adminRouter.get('/users/:id', async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return res.status(404).send('Not found');
  const target = await col.users.findOne({ _id: id });
  if (!target) return res.status(404).send('Not found');
  const [roles, apps] = await Promise.all([
    col.roles.find().sort({ key: 1 }).toArray(),
    col.apps.find({ status: 'active' }).sort({ name: 1 }).toArray(),
  ]);
  // Access preview: what can this user reach? (binary)
  const access: { app: string; allowed: boolean }[] = [];
  for (const a of apps) {
    const d = await decide(target, a.key);
    access.push({ app: a.key, allowed: d.allowed });
  }
  // Usage: most-used apps + an activity heatmap (apps active per day).
  const now = Date.now();
  const [topApps, dayCounts] = await Promise.all([
    topAppsForUser(target._id as ObjectId, config.usageTopLimit),
    dailyCountsForUser(target._id as ObjectId, heatmapSinceDay(now, config.usageHeatmapDays)),
  ]);
  const heatmap = buildHeatmap(dayCounts, now, config.usageHeatmapDays);
  res.render('admin/user', {
    user: req.user, isAdmin: true, target, roles, apps, access,
    topApps, heatmap, heatmapDays: config.usageHeatmapDays,
    isSuperadmin: isSuperadmin(target.email), msg: req.query.msg || null,
  });
});

// Edit profile (name, department). Email is immutable by design — a wrong email
// means delete + recreate the user (it is the identity key Logto asserts).
adminRouter.post('/users/:id/profile', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    const { syncWarning } = await usersSvc.updateProfile(req.params.id, { name: req.body.name, department: req.body.department }, actor(req));
    if (syncWarning) flash(res, base, 'flash.profileSyncFailed', undefined, 'warning');
    else flash(res, base, 'flash.profileUpdated');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/users/:id/roles', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    await usersSvc.setRoles(req.params.id, req.body.roles, actor(req));
    flash(res, base, 'flash.rolesUpdated');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/users/:id/overrides', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    await usersSvc.setOverride(req.params.id, { app: req.body.app, effect: req.body.effect, reason: req.body.reason }, actor(req));
    flash(res, base, 'flash.overrideSet');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/users/:id/overrides/delete', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    await usersSvc.deleteOverride(req.params.id, String(req.body.app || ''), actor(req));
    flash(res, base, 'flash.overrideRemoved');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/users/:id/disable', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    await usersSvc.disableUser(req.params.id, actor(req));
    flash(res, base, 'flash.userDisabled');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/users/:id/enable', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    await usersSvc.enableUser(req.params.id, actor(req));
    flash(res, base, 'flash.userEnabled');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/users/:id/delete', async (req, res) => {
  const base = `/admin/users/${req.params.id}`;
  try {
    await usersSvc.deleteUser(req.params.id, actor(req));
    flash(res, '/admin/users', 'flash.userDeleted');
  } catch (err) {
    fail(res, base, err);
  }
});

// ---- Roles ----
adminRouter.get('/roles', async (req, res) => {
  const roles = await col.roles.find().sort({ key: 1 }).toArray();
  res.render('admin/roles', { user: req.user, isAdmin: true, roles, msg: req.query.msg || null });
});

adminRouter.post('/roles', async (req, res) => {
  try {
    const { key } = await rolesSvc.createRole({ key: req.body.key, name: req.body.name, description: req.body.description }, actor(req));
    flash(res, `/admin/roles/${key}`, 'flash.roleCreated');
  } catch (err) {
    fail(res, '/admin/roles', err);
  }
});

adminRouter.get('/roles/:key', async (req, res) => {
  const role = await col.roles.findOne({ key: req.params.key });
  if (!role) return res.status(404).send('Not found');
  const apps = await col.apps.find({ status: 'active' }).sort({ name: 1 }).toArray();
  // Only offer apps this role doesn't already grant, so the "add grant" picker
  // can't re-add a duplicate; when none are left the picker is disabled.
  const granted = new Set((role.grants || []).map((g) => g.app));
  const availableApps = apps.filter((a) => !granted.has(a.key));
  res.render('admin/role', { user: req.user, isAdmin: true, role, availableApps, protectedRole: PROTECTED_ROLE, msg: req.query.msg || null });
});

// Edit a role's display fields (name, description). The key is edited separately.
adminRouter.post('/roles/:key/edit', async (req, res) => {
  const base = `/admin/roles/${req.params.key}`;
  try {
    await rolesSvc.editRole(req.params.key, { name: req.body.name, description: req.body.description }, actor(req));
    flash(res, base, 'flash.roleUpdated');
  } catch (err) {
    fail(res, base, err);
  }
});

// Rename a role's key. The key is a stable identifier referenced from
// users.roles, so the rename cascades to every holder.
adminRouter.post('/roles/:key/rename', async (req, res) => {
  const base = `/admin/roles/${req.params.key}`;
  try {
    const { key, usersUpdated } = await rolesSvc.renameRole(req.params.key, String(req.body.new_key || ''), actor(req));
    flash(res, `/admin/roles/${key}`, 'flash.roleKeyRenamed', { count: usersUpdated });
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/roles/:key/grants', async (req, res) => {
  const base = `/admin/roles/${req.params.key}`;
  try {
    await rolesSvc.addGrant(req.params.key, String(req.body.app || ''), actor(req));
    flash(res, base, 'flash.grantSet');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/roles/:key/grants/delete', async (req, res) => {
  const base = `/admin/roles/${req.params.key}`;
  try {
    await rolesSvc.deleteGrant(req.params.key, String(req.body.app || ''), actor(req));
    flash(res, base, 'flash.grantRemoved');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/roles/:key/delete', async (req, res) => {
  const base = `/admin/roles/${req.params.key}`;
  try {
    const { usersUnassigned } = await rolesSvc.deleteRole(req.params.key, actor(req));
    flash(res, '/admin/roles', 'flash.roleDeleted', { count: usersUnassigned });
  } catch (err) {
    fail(res, base, err);
  }
});

// ---- Apps ----
adminRouter.get('/apps', async (req, res) => {
  const apps = await col.apps.find().sort({ name: 1 }).toArray();
  res.render('admin/apps', { user: req.user, isAdmin: true, apps, msg: req.query.msg || null });
});

adminRouter.post('/apps', async (req, res) => {
  try {
    const { key } = await appsSvc.createApp({ key: req.body.key, name: req.body.name, description: req.body.description }, actor(req));
    flash(res, `/admin/apps/${key}`, 'flash.appRegistered');
  } catch (err) {
    fail(res, '/admin/apps', err);
  }
});

adminRouter.get('/apps/:key', async (req, res) => {
  const app = await col.apps.findOne({ key: req.params.key });
  if (!app) return res.status(404).send('Not found');
  // Who can access this app? (binary)
  const users = await col.users.find({ status: 'active' }).toArray();
  const access: { email: string }[] = [];
  for (const u of users) {
    const d = await decide(u, app.key);
    if (d.allowed) access.push({ email: u.email });
  }
  // Usage: power users + an activity heatmap (users active per day).
  const now = Date.now();
  const [topUsers, dayCounts] = await Promise.all([
    topUsersForApp(app.key, config.usageTopLimit),
    dailyCountsForApp(app.key, heatmapSinceDay(now, config.usageHeatmapDays)),
  ]);
  const heatmap = buildHeatmap(dayCounts, now, config.usageHeatmapDays);
  res.render('admin/app', {
    user: req.user, isAdmin: true, app, access,
    topUsers, heatmap, heatmapDays: config.usageHeatmapDays,
    defaultBaseUrls: config.defaultBaseUrls,
    msg: req.query.msg || null,
  });
});

adminRouter.post('/apps/:key', async (req, res) => {
  const base = `/admin/apps/${req.params.key}`;
  try {
    await appsSvc.updateApp(
      req.params.key,
      { name: req.body.name, description: req.body.description, status: req.body.status, public_paths: req.body.public_paths, default_base_url: req.body.default_base_url },
      actor(req),
    );
    flash(res, base, 'flash.appUpdated');
  } catch (err) {
    fail(res, base, err);
  }
});

// Rename an app's key. The key is also the /apps/<key> URL path segment and is
// referenced from role grants, user overrides and usage rows — so the rename
// cascades to all of them. NOTE: the deployment (Coolify FQDN path +
// APP_BASE_PATH + the gateway route) must be updated to match, or the app
// becomes unreachable; the UI warns about this.
adminRouter.post('/apps/:key/rename', async (req, res) => {
  const base = `/admin/apps/${req.params.key}`;
  try {
    const { key } = await appsSvc.renameApp(req.params.key, String(req.body.new_key || ''), actor(req));
    flash(res, `/admin/apps/${key}`, 'flash.appKeyRenamed', { key });
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/apps/:key/delete', async (req, res) => {
  const base = `/admin/apps/${req.params.key}`;
  try {
    await appsSvc.deleteApp(req.params.key, actor(req));
    flash(res, '/admin/apps', 'flash.appDeleted');
  } catch (err) {
    fail(res, base, err);
  }
});

adminRouter.post('/apps/:key/regenerate-secret', async (req, res) => {
  const base = `/admin/apps/${req.params.key}`;
  try {
    await appsSvc.regenerateSecret(req.params.key, actor(req));
    flash(res, base, 'flash.secretRegenerated');
  } catch (err) {
    fail(res, base, err);
  }
});

// ---- Email allow rules ----
adminRouter.get('/email-rules', async (req, res) => {
  const rules = await col.emailRules.find().sort({ created_at: -1 }).toArray();
  res.render('admin/email-rules', { user: req.user, isAdmin: true, rules, msg: req.query.msg || null });
});

adminRouter.post('/email-rules', async (req, res) => {
  try {
    await rulesSvc.createRule({ type: req.body.type, pattern: req.body.pattern, description: req.body.description }, actor(req));
    flash(res, '/admin/email-rules', 'flash.ruleAdded');
  } catch (err) {
    fail(res, '/admin/email-rules', err);
  }
});

// Edit just the description (type and pattern are the rule's identity and stay
// immutable, like a user's email — to change those, delete and re-add).
adminRouter.post('/email-rules/:id/description', async (req, res) => {
  try {
    await rulesSvc.updateDescription(req.params.id, String(req.body.description || ''), actor(req));
    flash(res, '/admin/email-rules', 'flash.ruleUpdated');
  } catch (err) {
    fail(res, '/admin/email-rules', err);
  }
});

adminRouter.post('/email-rules/:id/toggle', async (req, res) => {
  try {
    await rulesSvc.toggleRule(req.params.id, actor(req));
    flash(res, '/admin/email-rules', 'flash.ruleUpdated');
  } catch (err) {
    fail(res, '/admin/email-rules', err);
  }
});

adminRouter.post('/email-rules/:id/delete', async (req, res) => {
  try {
    await rulesSvc.deleteRule(req.params.id, actor(req));
    flash(res, '/admin/email-rules', 'flash.ruleDeleted');
  } catch (err) {
    fail(res, '/admin/email-rules', err);
  }
});

// ---- API access (self-service, per-admin API keys) ----
// Keys are owner-scoped: an admin only ever sees and revokes their own. The full
// secret is shown exactly once, on creation; thereafter only the masked form.
adminRouter.get('/api-keys', async (req, res) => {
  const keys = await listApiKeys(req.user!._id as ObjectId);
  res.render('admin/api-keys', { user: req.user, isAdmin: true, keys, mask: maskedDisplay, newKey: null, msg: req.query.msg || null });
});

adminRouter.post('/api-keys', async (req, res) => {
  try {
    const { key, secret } = await createApiKey(req.user!._id as ObjectId, String(req.body.name || ''));
    const keys = await listApiKeys(req.user!._id as ObjectId);
    // Render directly (not PRG) so the one-time secret can be shown — it is never
    // persisted in plaintext and cannot be recovered later.
    res.render('admin/api-keys', { user: req.user, isAdmin: true, keys, mask: maskedDisplay, newKey: { name: key.name, secret }, msg: null });
  } catch (err) {
    fail(res, '/admin/api-keys', err);
  }
});

adminRouter.post('/api-keys/:id/revoke', async (req, res) => {
  try {
    await revokeApiKey(req.user!._id as ObjectId, req.params.id);
    flash(res, '/admin/api-keys', 'flash.apiKeyRevoked');
  } catch (err) {
    fail(res, '/admin/api-keys', err);
  }
});

// ---- API documentation (Swagger UI) ----
// Auto-generated from the route registry; served only to logged-in admins (this
// whole router is behind requireAdmin). Assets are served same-origin from the
// swagger-ui-dist package — gated pages must not depend on a public CDN.
adminRouter.get('/openapi.json', (_req, res) => res.json(buildOpenApiDocument()));
adminRouter.use('/docs-assets', express.static(swaggerAssetsPath(), { maxAge: '1d' }));
adminRouter.get('/docs', (_req, res) => res.type('html').send(swaggerHtml('/admin/docs-assets', '/admin/openapi.json')));

// ---- Audit log ----
adminRouter.get('/audit', async (req, res) => {
  const logs = await rulesSvc.listAudit();
  res.render('admin/audit', { user: req.user, isAdmin: true, logs });
});
