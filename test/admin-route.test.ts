import cookieParser from 'cookie-parser';
import express from 'express';
import path from 'path';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  userDeleteOne: vi.fn(),
  userUpdateMany: vi.fn(),
  destroyUserSessions: vi.fn(),
  evictUser: vi.fn(),
  evictAll: vi.fn(),
  mgmtSetSuspended: vi.fn(),
  mgmtDeleteUser: vi.fn(),
  mgmtUpdateUser: vi.fn(),
  managementConfigured: vi.fn(),
  ruleFindOne: vi.fn(),
  ruleDeleteOne: vi.fn(),
  ruleUpdateOne: vi.fn(),
  roleFindOne: vi.fn(),
  roleDeleteOne: vi.fn(),
  roleUpdateOne: vi.fn(),
  appFindOne: vi.fn(),
  appDeleteOne: vi.fn(),
  appUpdateOne: vi.fn(),
  roleUpdateMany: vi.fn(),
  usageDeleteMany: vi.fn(),
  usageUpdateMany: vi.fn(),
  userInsertOne: vi.fn(),
  ruleInsertOne: vi.fn(),
  ruleFind: vi.fn(),
}));

const SUPERADMIN = 'admin@example.com';

vi.mock('../src/db', () => ({
  col: {
    users: { findOne: h.findOne, insertOne: h.userInsertOne, updateOne: h.updateOne, deleteOne: h.userDeleteOne, updateMany: h.userUpdateMany },
    emailRules: { findOne: h.ruleFindOne, find: h.ruleFind, insertOne: h.ruleInsertOne, deleteOne: h.ruleDeleteOne, updateOne: h.ruleUpdateOne },
    roles: { findOne: h.roleFindOne, deleteOne: h.roleDeleteOne, updateOne: h.roleUpdateOne, updateMany: h.roleUpdateMany },
    apps: { findOne: h.appFindOne, deleteOne: h.appDeleteOne, updateOne: h.appUpdateOne },
    usageDaily: { deleteMany: h.usageDeleteMany, updateMany: h.usageUpdateMany },
  },
}));
vi.mock('../src/usage', () => ({
  topAppsForUser: vi.fn(async () => []),
  topUsersForApp: vi.fn(async () => []),
  topAppsByActivity: vi.fn(async () => []),
  topUsersByActivity: vi.fn(async () => []),
  DASHBOARD_RANK_DAYS: 30,
  dailyCountsForUser: vi.fn(async () => new Map()),
  dailyCountsForApp: vi.fn(async () => new Map()),
  heatmapSinceDay: () => '2025-01-01',
  buildHeatmap: () => ({ weeks: [], max: 0 }),
  usageDay: () => '2026-06-25',
}));
vi.mock('../src/sessions', () => ({ destroyUserSessions: h.destroyUserSessions, getSessionId: () => undefined, touchSession: async () => null, sessionIsRevoked: async () => false }));
vi.mock('../src/decide', () => ({ decide: vi.fn(async () => ({ allowed: false })), evictUser: h.evictUser, evictAll: h.evictAll }));
// Provisioning now flows through the IdP seam: getIdentityProvider().provisioning
// is present exactly when management is configured (toggled via h.managementConfigured).
vi.mock('../src/idp', () => ({
  getIdentityProvider: () => ({
    name: 'Logto',
    oidcClient: vi.fn(),
    userinfo: vi.fn(),
    provisioning: h.managementConfigured()
      ? { createUser: vi.fn(async () => ({ id: 'logto-new' })), updateUser: h.mgmtUpdateUser, deleteUser: h.mgmtDeleteUser, setSuspended: h.mgmtSetSuspended }
      : undefined,
  }),
}));
vi.mock('../src/idp/config', () => ({ managementConfigured: h.managementConfigured }));
vi.mock('../src/config', () => ({ config: { superadminEmail: 'admin@example.com', usageHeatmapDays: 365, dashboardTopLimit: 6 } }));
// Keep the REAL matchEmail (the import route uses it); override only emailAllowed.
vi.mock('../src/rules', async (orig) => ({ ...(await orig<Record<string, unknown>>()), emailAllowed: vi.fn(async () => true) }));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

import { adminRouter } from '../src/routes/admin';
import { i18n } from '../src/i18n'; // real (not mocked) — needed so views render with t()
import { topAppsByActivity, topUsersByActivity } from '../src/usage'; // mocked above

function appAs(user: unknown) {
  const app = express();
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = user;
    next();
  });
  app.use('/admin', adminRouter);
  return app;
}

const admin = { _id: 'admin1', email: 'admin@example.com', roles: ['system_admin'] };
const targetId = new ObjectId();

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  h.updateOne.mockResolvedValue({});
  h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', status: 'active', logto_user_id: null });
  h.ruleDeleteOne.mockResolvedValue({ deletedCount: 1 });
  h.ruleUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  h.userDeleteOne.mockResolvedValue({ deletedCount: 1 });
  h.userUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  h.roleUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  h.roleDeleteOne.mockResolvedValue({ deletedCount: 1 });
  h.roleUpdateOne.mockResolvedValue({});
  h.appDeleteOne.mockResolvedValue({ deletedCount: 1 });
  h.appUpdateOne.mockResolvedValue({});
  h.usageDeleteMany.mockResolvedValue({ deletedCount: 0 });
  h.usageUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  h.managementConfigured.mockReturnValue(false); // default: no Logto M2M
  h.mgmtUpdateUser.mockResolvedValue(undefined);
  h.userInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
  h.ruleInsertOne.mockResolvedValue({});
  h.ruleFind.mockReturnValue({ toArray: async () => [] }); // no active rules by default
});

describe('admin authorization boundary (via router)', () => {
  it('blocks a non-admin from the admin area', async () => {
    const res = await request(appAs({ email: 'x@example.com', roles: ['staff'] }))
      .get('/admin/users')
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  it('redirects /admin to the dashboard (the first sidebar section)', async () => {
    const res = await request(appAs(admin)).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/dashboard');
  });
});

describe('GET /admin/dashboard — render', () => {
  // Real EJS engine so the new view (and its heatmap partial) actually renders.
  function renderApp(user: unknown) {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.resolve('views'));
    app.use(cookieParser());
    app.use(i18n);
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use('/admin', adminRouter);
    return app;
  }

  it('renders Top apps / Top users cards, each linking to its entity', async () => {
    vi.mocked(topAppsByActivity).mockResolvedValueOnce([{ app_key: 'demo', name: 'Demo', active: 12 }]);
    vi.mocked(topUsersByActivity).mockResolvedValueOnce([{ user_id: 'u1', email: 'dau@example.com', name: 'Dau User', active: 9 }]);
    const res = await request(renderApp(admin)).get('/admin/dashboard').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/admin/apps/demo'); // app card links through
    expect(res.text).toContain('dau@example.com');
    expect(res.text).toContain('/admin/users/u1'); // user card links through
    expect(res.text).toContain('Dau User'); // name shown beside the email
    expect(res.text).toContain('Activity score'); // dual-window score on each card
    expect(res.text).toContain('badge-window'); // day windows rendered as badges
    expect(res.text).toContain('>30d</span>'); // rank-window badge
  });
});

describe('offboarding invariants — disable user', () => {
  it('sets status=disabled, revokes sessions, and evicts the decision cache', async () => {
    const res = await request(appAs(admin)).post(`/admin/users/${targetId}/disable`);

    expect(res.status).toBe(302); // redirect back with a flash message

    // status flipped to disabled
    const statusUpdate = h.updateOne.mock.calls.find((c) => c[1]?.$set?.status === 'disabled');
    expect(statusUpdate).toBeTruthy();

    // active sessions revoked + cache evicted immediately (no waiting out the TTL)
    expect(h.destroyUserSessions).toHaveBeenCalledOnce();
    expect(h.evictUser).toHaveBeenCalledWith(String(targetId));
  });
});

describe('email rules — edit description', () => {
  const ruleId = new ObjectId();

  it('updates the description and redirects', async () => {
    h.ruleFindOne.mockResolvedValue({ _id: ruleId, type: 'domain', pattern: 'example.com', status: 'active', description: 'old' });
    const res = await request(appAs(admin))
      .post(`/admin/email-rules/${ruleId}/description`)
      .type('form')
      .send({ description: '  new note  ' });
    expect(res.status).toBe(302);
    expect(h.ruleUpdateOne).toHaveBeenCalledWith({ _id: expect.anything() }, { $set: { description: 'new note' } });
  });

  it('404s a missing rule without updating', async () => {
    h.ruleFindOne.mockResolvedValue(null);
    const res = await request(appAs(admin)).post(`/admin/email-rules/${ruleId}/description`).type('form').send({ description: 'x' });
    expect(res.status).toBe(404);
    expect(h.ruleUpdateOne).not.toHaveBeenCalled();
  });
});

describe('email rules — delete', () => {
  const ruleId = new ObjectId();

  it('deletes an existing rule and redirects', async () => {
    h.ruleFindOne.mockResolvedValue({ _id: ruleId, type: 'domain', pattern: 'example.com', status: 'active' });
    const res = await request(appAs(admin)).post(`/admin/email-rules/${ruleId}/delete`);
    expect(res.status).toBe(302);
    expect(h.ruleDeleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
  });

  it('404s a missing rule without deleting', async () => {
    h.ruleFindOne.mockResolvedValue(null);
    const res = await request(appAs(admin)).post(`/admin/email-rules/${ruleId}/delete`);
    expect(res.status).toBe(404);
    expect(h.ruleDeleteOne).not.toHaveBeenCalled();
  });

  it('blocks a non-admin', async () => {
    const res = await request(appAs({ email: 'x@example.com', roles: ['staff'] }))
      .post(`/admin/email-rules/${ruleId}/delete`)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
    expect(h.ruleDeleteOne).not.toHaveBeenCalled();
  });
});

describe('user delete — and superadmin protection', () => {
  it('deletes a normal user: revokes sessions, evicts, removes record', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', status: 'active', logto_user_id: null });
    const res = await request(appAs(admin)).post(`/admin/users/${targetId}/delete`);
    expect(res.status).toBe(302);
    expect(h.destroyUserSessions).toHaveBeenCalledOnce();
    expect(h.evictUser).toHaveBeenCalledWith(String(targetId));
    expect(h.userDeleteOne).toHaveBeenCalledOnce();
    expect(h.usageDeleteMany).toHaveBeenCalledWith({ user_id: expect.anything() }); // usage history dropped
  });

  it('refuses to delete the superadmin account', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: SUPERADMIN, status: 'active', logto_user_id: 'lx' });
    const res = await request(appAs(admin)).post(`/admin/users/${targetId}/delete`);
    expect(res.status).toBe(302); // redirected with an error flash
    expect(h.userDeleteOne).not.toHaveBeenCalled();
    expect(h.destroyUserSessions).not.toHaveBeenCalled();
  });

  it('refuses to disable the superadmin account', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: SUPERADMIN, status: 'active', logto_user_id: 'lx' });
    const res = await request(appAs(admin)).post(`/admin/users/${targetId}/disable`);
    expect(res.status).toBe(302);
    expect(h.updateOne).not.toHaveBeenCalled();
    expect(h.destroyUserSessions).not.toHaveBeenCalled();
  });
});

describe('role delete — and system_admin protection', () => {
  it('deletes a normal role and unassigns it from users', async () => {
    h.roleFindOne.mockResolvedValue({ key: 'sales', name: 'Sales', grants: [] });
    const res = await request(appAs(admin)).post('/admin/roles/sales/delete');
    expect(res.status).toBe(302);
    expect(h.userUpdateMany).toHaveBeenCalledWith({ roles: 'sales' }, expect.anything());
    expect(h.roleDeleteOne).toHaveBeenCalledOnce();
    expect(h.evictAll).toHaveBeenCalled();
  });

  it('refuses to delete the system_admin role', async () => {
    h.roleFindOne.mockResolvedValue({ key: 'system_admin', name: 'Admin', grants: [] });
    const res = await request(appAs(admin)).post('/admin/roles/system_admin/delete');
    expect(res.status).toBe(302);
    expect(h.roleDeleteOne).not.toHaveBeenCalled();
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });
});

describe('app delete — cleans references', () => {
  it('deletes the app and strips grants + overrides', async () => {
    h.appFindOne.mockResolvedValue({ key: 'demo', name: 'Demo', status: 'active' });
    const res = await request(appAs(admin)).post('/admin/apps/demo/delete');
    expect(res.status).toBe(302);
    expect(h.roleUpdateMany).toHaveBeenCalledWith({ 'grants.app': 'demo' }, expect.anything());
    expect(h.userUpdateMany).toHaveBeenCalledWith({ 'app_overrides.app': 'demo' }, expect.anything());
    expect(h.appDeleteOne).toHaveBeenCalledOnce();
    expect(h.usageDeleteMany).toHaveBeenCalledWith({ app_key: 'demo' }); // usage history dropped
    expect(h.evictAll).toHaveBeenCalled();
  });
});

describe('user profile edit', () => {
  it('updates name + department but never the email', async () => {
    const res = await request(appAs(admin))
      .post(`/admin/users/${targetId}/profile`)
      .type('form')
      .send({ name: 'New Name', department: 'Ops', email: 'attacker@evil.com' });
    expect(res.status).toBe(302);
    const set = h.updateOne.mock.calls.find((c) => c[1]?.$set?.name === 'New Name')?.[1].$set;
    expect(set).toMatchObject({ name: 'New Name', department: 'Ops' });
    expect(set).not.toHaveProperty('email'); // email is immutable
  });

  it('does not push to Logto when management is not configured', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', name: 'Old', status: 'active', logto_user_id: 'lx' });
    await request(appAs(admin)).post(`/admin/users/${targetId}/profile`).type('form').send({ name: 'New', department: '' });
    expect(h.mgmtUpdateUser).not.toHaveBeenCalled();
  });
});

describe('user profile edit — Logto name sync (push)', () => {
  beforeEach(() => h.managementConfigured.mockReturnValue(true));

  it('pushes a changed name to Logto for a linked user', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', name: 'Old', status: 'active', logto_user_id: 'logto-123' });
    const res = await request(appAs(admin)).post(`/admin/users/${targetId}/profile`).type('form').send({ name: 'New Name', department: 'Ops' });
    expect(res.status).toBe(302);
    expect(h.mgmtUpdateUser).toHaveBeenCalledWith('logto-123', { name: 'New Name' });
  });

  it('skips the Logto call when the name is unchanged', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', name: 'Same', status: 'active', logto_user_id: 'logto-123' });
    await request(appAs(admin)).post(`/admin/users/${targetId}/profile`).type('form').send({ name: 'Same', department: 'Ops' });
    expect(h.mgmtUpdateUser).not.toHaveBeenCalled();
  });

  it('skips the Logto call for an unlinked user', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', name: 'Old', status: 'active', logto_user_id: null });
    await request(appAs(admin)).post(`/admin/users/${targetId}/profile`).type('form').send({ name: 'New', department: '' });
    expect(h.mgmtUpdateUser).not.toHaveBeenCalled();
  });

  it('still saves locally and warns when the Logto push fails', async () => {
    h.findOne.mockResolvedValue({ _id: targetId, email: 't@example.com', name: 'Old', status: 'active', logto_user_id: 'logto-123' });
    h.mgmtUpdateUser.mockRejectedValue(new Error('boom'));
    const res = await request(appAs(admin)).post(`/admin/users/${targetId}/profile`).type('form').send({ name: 'New', department: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('lvl=warning');
    // local name write happened before the (failed) push
    expect(h.updateOne.mock.calls.some((c) => c[1]?.$set?.name === 'New')).toBe(true);
  });
});

describe('role edit + rename', () => {
  it('edits name/description without touching the key', async () => {
    h.roleFindOne.mockResolvedValue({ key: 'sales', name: 'Sales', grants: [] });
    const res = await request(appAs(admin)).post('/admin/roles/sales/edit').type('form').send({ name: 'Sales Team', description: 'd' });
    expect(res.status).toBe(302);
    expect(h.roleUpdateOne).toHaveBeenCalledWith({ key: 'sales' }, { $set: expect.objectContaining({ name: 'Sales Team', description: 'd' }) });
    expect(h.roleDeleteOne).not.toHaveBeenCalled();
  });

  it('renames the key and cascades to every holder', async () => {
    h.roleFindOne.mockResolvedValueOnce({ key: 'sales', name: 'Sales', grants: [] }); // the role being renamed
    h.roleFindOne.mockResolvedValueOnce(null); // new key is free
    h.userUpdateMany.mockResolvedValue({ modifiedCount: 2 });
    const res = await request(appAs(admin)).post('/admin/roles/sales/rename').type('form').send({ new_key: 'sales_team' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/admin/roles/sales_team');
    expect(h.roleUpdateOne).toHaveBeenCalledWith({ key: 'sales' }, { $set: expect.objectContaining({ key: 'sales_team' }) });
    expect(h.userUpdateMany).toHaveBeenCalledWith({ roles: 'sales' }, { $set: expect.objectContaining({ 'roles.$': 'sales_team' }) });
    expect(h.evictAll).toHaveBeenCalled();
  });

  it('refuses to rename the system_admin role', async () => {
    h.roleFindOne.mockResolvedValue({ key: 'system_admin', name: 'Admin', grants: [] });
    const res = await request(appAs(admin)).post('/admin/roles/system_admin/rename').type('form').send({ new_key: 'whatever' });
    expect(res.status).toBe(302);
    expect(h.roleUpdateOne).not.toHaveBeenCalled();
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects renaming onto an existing key', async () => {
    h.roleFindOne.mockResolvedValueOnce({ key: 'sales', name: 'Sales', grants: [] });
    h.roleFindOne.mockResolvedValueOnce({ key: 'ops', name: 'Ops', grants: [] }); // target exists
    const res = await request(appAs(admin)).post('/admin/roles/sales/rename').type('form').send({ new_key: 'ops' });
    expect(res.status).toBe(302);
    expect(h.roleUpdateOne).not.toHaveBeenCalled();
  });
});

describe('app rename — cascades all references', () => {
  it('rewrites the key on the app, grants, overrides and usage rows', async () => {
    h.appFindOne.mockResolvedValueOnce({ key: 'demo', name: 'Demo', status: 'active' }); // the app
    h.appFindOne.mockResolvedValueOnce(null); // new key is free
    const res = await request(appAs(admin)).post('/admin/apps/demo/rename').type('form').send({ new_key: 'demo_renamed' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/admin/apps/demo_renamed');
    expect(h.appUpdateOne).toHaveBeenCalledWith({ key: 'demo' }, { $set: expect.objectContaining({ key: 'demo_renamed', base_path: '/apps/demo_renamed' }) });
    expect(h.roleUpdateMany).toHaveBeenCalledWith({ 'grants.app': 'demo' }, expect.anything(), expect.objectContaining({ arrayFilters: expect.anything() }));
    expect(h.userUpdateMany).toHaveBeenCalledWith({ 'app_overrides.app': 'demo' }, expect.anything(), expect.objectContaining({ arrayFilters: expect.anything() }));
    expect(h.usageUpdateMany).toHaveBeenCalledWith({ app_key: 'demo' }, { $set: { app_key: 'demo_renamed' } });
    expect(h.evictAll).toHaveBeenCalled();
  });

  it('rejects an invalid new key without writing', async () => {
    h.appFindOne.mockResolvedValueOnce({ key: 'demo', name: 'Demo', status: 'active' });
    const res = await request(appAs(admin)).post('/admin/apps/demo/rename').type('form').send({ new_key: 'Bad Key' });
    expect(res.status).toBe(302);
    expect(h.appUpdateOne).not.toHaveBeenCalled();
  });
});

describe('POST /admin/users/import — batch user import', () => {
  // The success path renders a result view, so this app has the real i18n
  // middleware + EJS engine wired (unlike appAs, which only handles redirects).
  function renderApp(user: unknown) {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.resolve('views'));
    app.use(cookieParser());
    app.use(i18n);
    app.use(express.urlencoded({ extended: true }));
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use('/admin', adminRouter);
    return app;
  }
  function csvBuf(rows: (string | number)[][]): Buffer {
    return Buffer.from(rows.map((row) => row.map((cell) => String(cell)).join(',')).join('\n'), 'utf8');
  }
  const HEADER: (string | number)[] = ['Email', 'Name'];

  beforeEach(() => {
    h.findOne.mockResolvedValue(null); // no existing user, by default, for import rows
  });

  it('(a) out-of-pattern email + auto_rule on → creates an exact rule then the user with the ext_ role', async () => {
    h.roleFindOne.mockResolvedValue({ key: 'ext_viewer', name: 'External Viewer' });
    const buf = csvBuf([HEADER, ['ext1@outside.com', 'Ext One']]);
    const res = await request(renderApp(admin))
      .post('/admin/users/import')
      .field('auto_rule', 'on')
      .field('role', 'ext_viewer')
      .attach('file', buf, 'roster.csv');
    expect(res.status).toBe(200);
    expect(h.ruleInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      type: 'exact', pattern: 'ext1@outside.com', status: 'active',
      // provenance: "bulk import · <file> · <date>"
      description: expect.stringContaining('bulk import · roster.csv · '),
    }));
    expect(h.userInsertOne).toHaveBeenCalledWith(expect.objectContaining({ email: 'ext1@outside.com', source: 'import', roles: ['ext_viewer'] }));
  });

  it('(b) auto_rule off → out-of-pattern row is skipped (no rule, no user)', async () => {
    const buf = csvBuf([HEADER, ['ext2@outside.com', 'Ext Two']]);
    const res = await request(renderApp(admin))
      .post('/admin/users/import')
      .field('role', '')
      .attach('file', buf, 'roster.csv');
    expect(res.status).toBe(200);
    expect(h.ruleInsertOne).not.toHaveBeenCalled();
    expect(h.userInsertOne).not.toHaveBeenCalled();
  });

  it('(c) existing email is skipped', async () => {
    h.findOne.mockResolvedValue({ _id: new ObjectId(), email: 'dupe@outside.com' });
    const buf = csvBuf([HEADER, ['dupe@outside.com', 'Dupe']]);
    const res = await request(renderApp(admin))
      .post('/admin/users/import')
      .field('auto_rule', 'on')
      .attach('file', buf, 'roster.csv');
    expect(res.status).toBe(200);
    expect(h.userInsertOne).not.toHaveBeenCalled();
  });

  it('(e) SECURITY: a non-ext_ role in the body is rejected — nothing is created', async () => {
    h.roleFindOne.mockResolvedValue({ key: 'system_admin', name: 'Admin' }); // exists, but not ext_
    const buf = csvBuf([HEADER, ['ext3@outside.com', 'Ext Three']]);
    const res = await request(renderApp(admin))
      .post('/admin/users/import')
      .field('auto_rule', 'on')
      .field('role', 'system_admin')
      .attach('file', buf, 'roster.csv');
    expect(res.status).toBe(302); // flash redirect, not a render
    expect(res.headers.location).toContain('/admin/users/import');
    expect(h.userInsertOne).not.toHaveBeenCalled();
    expect(h.ruleInsertOne).not.toHaveBeenCalled();
  });

  it('rejects when no file is uploaded', async () => {
    const res = await request(renderApp(admin)).post('/admin/users/import').field('auto_rule', 'on');
    expect(res.status).toBe(302);
    expect(h.userInsertOne).not.toHaveBeenCalled();
  });
});
