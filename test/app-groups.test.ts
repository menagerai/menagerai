import cookieParser from 'cookie-parser';
import express from 'express';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// App Groups are display-only folders for the portal launcher. These tests run
// the real services, routers and EJS views against an in-memory SQLite store, so
// they cover the actual query/update semantics end to end — and, crucially, that
// grouping never changes who can see which app.

const store = vi.hoisted(() => ({ backend: null as unknown as import('../src/store/types').StoreBackend }));
vi.mock('../src/db', async () => {
  const { openSqlite } = await import('../src/store/sqlite');
  store.backend = openSqlite(':memory:');
  return { col: store.backend.col };
});
const auditMock = vi.hoisted(() => vi.fn());
vi.mock('../src/audit', () => ({ audit: auditMock }));
// The JSON API is API-key gated; stand the key owner in as an admin.
vi.mock('../src/middleware/apiKeyAuth', () => ({
  requireApiKey: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: 'admin1', email: 'admin@example.com', status: 'active', roles: ['system_admin'] };
    next();
  },
}));

import { col } from '../src/db';
import { evictAll } from '../src/decide';
import { ApiError, NotFoundError } from '../src/services/errors';
import * as groupsSvc from '../src/services/app-groups';
import * as appsSvc from '../src/services/apps';
import { adminRouter } from '../src/routes/admin';
import { portalRouter } from '../src/routes/portal';
import { buildApiRouter } from '../src/api/mount';
import { i18n, translate } from '../src/i18n';

const ACTOR = 'admin1';
const admin = { _id: 'admin1', email: 'admin@example.com', status: 'active', roles: ['system_admin'] };
const staff = { _id: 'staff1', email: 'staff@example.com', status: 'active', roles: ['staff'], app_overrides: [] };

function webApp(user: unknown) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve('views'));
  app.use(cookieParser());
  app.use(i18n);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    (req as { user?: unknown }).user = user;
    res.locals.fmtTime = (v: unknown) => (v ? String(v) : '');
    next();
  });
  app.use('/api/admin', buildApiRouter());
  app.use('/admin', adminRouter);
  app.use(portalRouter);
  return app;
}

// Expected flash redirect for an admin-UI action.
function flashUrl(base: string, key: string, lvl: 'success' | 'error') {
  return `${base}?msg=${encodeURIComponent(translate('en', key))}&lvl=${lvl}`;
}

async function expectApiError(p: Promise<unknown>, status: number, key: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).i18nKey).toBe(key);
}

async function positions(): Promise<Record<string, number>> {
  const rows = await col.appGroups.find().toArray();
  return Object.fromEntries(rows.map((g) => [g.key, g.position]));
}

async function addApp(key: string, name: string, extra: Record<string, unknown> = {}) {
  const now = new Date();
  await col.apps.insertOne({
    key, name, base_path: `/apps/${key}`, auth_mode: 'proxy', status: 'active', description: '',
    public_paths: [], proxy_secret: 's', default_base_url: '', created_at: now, updated_at: now, ...extra,
  });
}

beforeAll(async () => {
  await col.apps.createIndex({ key: 1 }, { unique: true });
  await col.roles.createIndex({ key: 1 }, { unique: true });
  await col.appGroups?.createIndex({ key: 1 }, { unique: true });
});
afterAll(async () => {
  await store.backend.close();
});
beforeEach(async () => {
  for (const c of Object.values(col)) await c.deleteMany({});
  auditMock.mockReset();
  evictAll();
});

// ---------------------------------------------------------------------------
describe('app-groups service', () => {
  it('creates groups appended at the end, with name defaulting to the key', async () => {
    expect(await groupsSvc.createGroup({ key: 'finance', name: ' Finance ' }, ACTOR)).toEqual({ key: 'finance' });
    expect(await groupsSvc.createGroup({ key: 'eng' }, ACTOR)).toEqual({ key: 'eng' });
    const list = await groupsSvc.listGroups();
    expect(list.map((g) => [g.key, g.name, g.position])).toEqual([
      ['finance', 'Finance', 0],
      ['eng', 'eng', 1],
    ]);
    expect(list[0].created_at).toBeInstanceOf(Date);
    expect(list[0].updated_at).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledWith({ actor_user_id: ACTOR, action: 'app_group.create', target_type: 'app_group', target_id: 'finance' });
  });

  it.each(['', 'Bad Key', '-x', 'UPPER', 'reorder'])('rejects the invalid or reserved key %j without writing', async (key) => {
    await expectApiError(groupsSvc.createGroup({ key, name: 'x' }, ACTOR), 400, 'flash.invalidAppGroupKey');
    expect(await col.appGroups.find().toArray()).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects a duplicate key with 409', async () => {
    await groupsSvc.createGroup({ key: 'finance' }, ACTOR);
    await expectApiError(groupsSvc.createGroup({ key: 'finance', name: 'Again' }, ACTOR), 409, 'flash.appGroupExists');
    expect(await col.appGroups.find().toArray()).toHaveLength(1);
  });

  it('lists by position, then name', async () => {
    const now = new Date();
    await col.appGroups.insertOne({ key: 'b', name: 'Bravo', position: 1, created_at: now, updated_at: now });
    await col.appGroups.insertOne({ key: 'z', name: 'Zulu', position: 0, created_at: now, updated_at: now });
    await col.appGroups.insertOne({ key: 'a', name: 'Alpha', position: 1, created_at: now, updated_at: now });
    expect((await groupsSvc.listGroups()).map((g) => g.key)).toEqual(['z', 'a', 'b']);
  });

  it('edits only the name (key and position stay); blank name falls back to the key', async () => {
    await groupsSvc.createGroup({ key: 'finance' }, ACTOR);
    await groupsSvc.createGroup({ key: 'eng' }, ACTOR);
    await groupsSvc.editGroup('eng', { name: 'Engineering' }, ACTOR);
    let eng = await col.appGroups.findOne({ key: 'eng' });
    expect([eng?.key, eng?.name, eng?.position]).toEqual(['eng', 'Engineering', 1]);
    expect(auditMock).toHaveBeenLastCalledWith({
      actor_user_id: ACTOR, action: 'app_group.edit', target_type: 'app_group', target_id: 'eng',
      before: { name: 'eng' }, after: { name: 'Engineering' },
    });
    await groupsSvc.editGroup('eng', { name: '   ' }, ACTOR);
    eng = await col.appGroups.findOne({ key: 'eng' });
    expect(eng?.name).toBe('eng');
  });

  it('404s editing, moving or deleting an unknown group', async () => {
    await expect(groupsSvc.editGroup('nope', { name: 'x' }, ACTOR)).rejects.toBeInstanceOf(NotFoundError);
    await expect(groupsSvc.moveGroup('nope', 'up', ACTOR)).rejects.toBeInstanceOf(NotFoundError);
    await expect(groupsSvc.deleteGroup('nope', ACTOR)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('moves a group up/down by swapping with its neighbour; edges are a no-op', async () => {
    for (const k of ['a', 'b', 'c']) await groupsSvc.createGroup({ key: k }, ACTOR);
    await groupsSvc.moveGroup('c', 'up', ACTOR);
    expect((await groupsSvc.listGroups()).map((g) => g.key)).toEqual(['a', 'c', 'b']);
    await groupsSvc.moveGroup('a', 'down', ACTOR);
    expect((await groupsSvc.listGroups()).map((g) => g.key)).toEqual(['c', 'a', 'b']);
    expect(auditMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'app_group.reorder', after: { keys: ['c', 'a', 'b'] } }));

    auditMock.mockReset();
    const before = await positions();
    await groupsSvc.moveGroup('c', 'up', ACTOR); // already first
    await groupsSvc.moveGroup('b', 'down', ACTOR); // already last
    expect(await positions()).toEqual(before);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects a move direction other than up/down', async () => {
    await groupsSvc.createGroup({ key: 'a' }, ACTOR);
    await expectApiError(groupsSvc.moveGroup('a', 'sideways' as 'up', ACTOR), 400, 'flash.invalidAppGroupOrder');
  });

  it('reorders to an exact permutation, normalizing positions to 0..n-1', async () => {
    for (const k of ['a', 'b', 'c']) await groupsSvc.createGroup({ key: k }, ACTOR);
    await groupsSvc.reorderGroups(['c', 'a', 'b'], ACTOR);
    expect(await positions()).toEqual({ c: 0, a: 1, b: 2 });
    expect(auditMock).toHaveBeenLastCalledWith({
      actor_user_id: ACTOR, action: 'app_group.reorder', target_type: 'app_group', target_id: '*',
      before: { keys: ['a', 'b', 'c'] }, after: { keys: ['c', 'a', 'b'] },
    });
  });

  it.each([
    ['a missing key', ['a', 'b']],
    ['an unknown key', ['a', 'b', 'c', 'x']],
    ['a duplicated key', ['a', 'b', 'b']],
    ['a swapped-in unknown key', ['a', 'b', 'x']],
    ['an empty list', []],
    ['a non-array', 'a,b,c'],
  ])('rejects %s and leaves the order untouched', async (_label, keys) => {
    for (const k of ['a', 'b', 'c']) await groupsSvc.createGroup({ key: k }, ACTOR);
    auditMock.mockReset();
    await expectApiError(groupsSvc.reorderGroups(keys as string[], ACTOR), 400, 'flash.invalidAppGroupOrder');
    expect(await positions()).toEqual({ a: 0, b: 1, c: 2 });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('deletes a group: its apps become ungrouped (not deleted), other groups untouched', async () => {
    await groupsSvc.createGroup({ key: 'finance' }, ACTOR);
    await groupsSvc.createGroup({ key: 'eng' }, ACTOR);
    await addApp('ledger', 'Ledger', { group: 'finance' });
    await addApp('payroll', 'Payroll', { group: 'finance' });
    await addApp('ci', 'CI', { group: 'eng' });
    expect(await groupsSvc.deleteGroup('finance', ACTOR)).toEqual({ appsUngrouped: 2 });
    expect(await col.appGroups.findOne({ key: 'finance' })).toBeNull();
    const apps = await col.apps.find().sort({ key: 1 }).toArray();
    expect(apps.map((a) => [a.key, a.group])).toEqual([['ci', 'eng'], ['ledger', ''], ['payroll', '']]);
    expect(auditMock).toHaveBeenLastCalledWith({
      actor_user_id: ACTOR, action: 'app_group.delete', target_type: 'app_group', target_id: 'finance',
      before: { name: 'finance' }, after: { apps_ungrouped: 2 },
    });
  });

  it('a new group after a delete still lands last', async () => {
    for (const k of ['a', 'b', 'c']) await groupsSvc.createGroup({ key: k }, ACTOR);
    await groupsSvc.deleteGroup('a', ACTOR);
    await groupsSvc.createGroup({ key: 'd' }, ACTOR);
    expect((await groupsSvc.listGroups()).map((g) => g.key)).toEqual(['b', 'c', 'd']);
  });
});

// ---------------------------------------------------------------------------
describe('assigning an app to a group (updateApp)', () => {
  beforeEach(async () => {
    await groupsSvc.createGroup({ key: 'finance', name: 'Finance' }, ACTOR);
    await addApp('ledger', 'Ledger');
  });

  it('sets a valid group and records it in the audit diff', async () => {
    await appsSvc.updateApp('ledger', { name: 'Ledger', group: 'finance' }, ACTOR);
    expect((await col.apps.findOne({ key: 'ledger' }))?.group).toBe('finance');
    const call = auditMock.mock.calls.find((c) => c[0].action === 'app.update')![0];
    expect(call.before.group).toBe('');
    expect(call.after.group).toBe('finance');
  });

  it("clears the group with ''", async () => {
    await appsSvc.updateApp('ledger', { group: 'finance' }, ACTOR);
    await appsSvc.updateApp('ledger', { group: '' }, ACTOR);
    expect((await col.apps.findOne({ key: 'ledger' }))?.group).toBe('');
  });

  it('rejects an unknown group without changing the app', async () => {
    await appsSvc.updateApp('ledger', { group: 'finance' }, ACTOR);
    await expectApiError(appsSvc.updateApp('ledger', { name: 'Renamed', group: 'ghost' }, ACTOR), 400, 'flash.unknownAppGroup');
    const app = await col.apps.findOne({ key: 'ledger' });
    expect([app?.name, app?.group]).toEqual(['Ledger', 'finance']);
  });

  it('leaves the group unchanged when the input omits it (API partial update)', async () => {
    await appsSvc.updateApp('ledger', { group: 'finance' }, ACTOR);
    await appsSvc.updateApp('ledger', { name: 'General Ledger' }, ACTOR);
    const app = await col.apps.findOne({ key: 'ledger' });
    expect([app?.name, app?.group]).toEqual(['General Ledger', 'finance']);
  });
});

// ---------------------------------------------------------------------------
describe('portal launcher — grouped, permission-filtered', () => {
  // Finance (pos 0), Engineering (pos 1), Marketing (pos 2, nothing visible).
  async function seed() {
    const now = new Date();
    await col.appGroups.insertOne({ key: 'eng', name: 'Engineering', position: 1, created_at: now, updated_at: now });
    await col.appGroups.insertOne({ key: 'fin', name: 'Finance', position: 0, created_at: now, updated_at: now });
    await col.appGroups.insertOne({ key: 'mkt', name: 'Marketing', position: 2, created_at: now, updated_at: now });
    await addApp('ledger', 'Ledger', { group: 'fin' });
    await addApp('payroll', 'Payroll', { group: 'fin' }); // not granted
    await addApp('vault', 'Vault', { group: 'fin', status: 'disabled' }); // granted but disabled
    await addApp('logs', 'Logs', { group: 'eng' });
    await addApp('ci', 'CI', { group: 'eng' });
    await addApp('ads', 'Ads Manager', { group: 'mkt' }); // not granted → Marketing hidden
    await addApp('wiki', 'Wiki'); // ungrouped
    await addApp('legacy', 'Legacy Portal', { group: 'ghost' }); // dangling group key
    await col.roles.insertOne({
      key: 'staff', name: 'Staff',
      grants: ['ledger', 'vault', 'logs', 'ci', 'wiki', 'legacy'].map((app) => ({ app })),
      created_at: now, updated_at: now,
    });
  }

  // Slice the HTML into one chunk per <details class="app-group"> section.
  function sections(html: string) {
    return html.split('<details class="app-group"').slice(1).map((chunk) => chunk.split('</details>')[0]);
  }

  it('renders visible apps under their groups, in admin order, with "Other" last', async () => {
    await seed();
    const res = await request(webApp(staff)).get('/');
    expect(res.status).toBe(200);
    const s = sections(res.text);
    expect(s).toHaveLength(3);

    expect(s[0]).toMatch(/^ open data-group="fin">/);
    expect(s[0]).toContain('<summary>Finance <span class="muted">(1)</span></summary>');
    expect(s[0]).toContain('Ledger');

    expect(s[1]).toMatch(/^ open data-group="eng">/);
    expect(s[1]).toContain('<summary>Engineering <span class="muted">(2)</span></summary>');
    expect(s[1].indexOf('CI')).toBeGreaterThan(-1);
    expect(s[1].indexOf('CI')).toBeLessThan(s[1].indexOf('Logs')); // name-sorted inside a group

    const other = translate('en', 'launcher.otherGroup');
    expect(s[2]).toMatch(/^ open data-group="_other">/);
    expect(s[2]).toContain(`<summary>${other} <span class="muted">(2)</span></summary>`);
    expect(s[2]).toContain('Legacy Portal'); // dangling group → Other
    expect(s[2]).toContain('Wiki');
  });

  it('never shows an app the user cannot access, nor a group with no visible apps', async () => {
    await seed();
    const res = await request(webApp(staff)).get('/');
    expect(res.text).not.toContain('Payroll'); // no grant
    expect(res.text).not.toContain('Vault'); // disabled
    expect(res.text).not.toContain('Ads Manager');
    expect(res.text).not.toContain('Marketing');
    expect(res.text).not.toContain('data-group="mkt"');
  });

  it('grouping does not change access: same tiles as an all-ungrouped registry', async () => {
    await seed();
    const tiles = (html: string) => [...html.matchAll(/class="app-tile" href="([^"]+)"/g)].map((m) => m[1]).sort();
    const grouped = tiles((await request(webApp(staff)).get('/')).text);
    await col.apps.updateMany({}, { $set: { group: '' } });
    evictAll();
    const flat = tiles((await request(webApp(staff)).get('/')).text);
    expect(grouped).toEqual(['/apps/ci', '/apps/ledger', '/apps/legacy', '/apps/logs', '/apps/wiki']);
    expect(flat).toEqual(grouped);
  });

  it('renders the plain flat grid when no visible app is in a group', async () => {
    await seed();
    await col.apps.updateMany({}, { $set: { group: '' } });
    const res = await request(webApp(staff)).get('/');
    expect(res.text).not.toContain('<details class="app-group"');
    expect(res.text).not.toContain(`>${translate('en', 'launcher.otherGroup')} <`);
    expect(res.text).toContain('<div class="grid">');
    expect([...res.text.matchAll(/class="app-tile"/g)]).toHaveLength(5);
  });

  it('shows the empty state when the user can see nothing', async () => {
    await seed();
    const res = await request(webApp({ ...staff, roles: [] })).get('/');
    expect(res.text).toContain(translate('en', 'launcher.noApps'));
    expect(res.text).not.toContain('<details class="app-group"');
  });

  it('remembers collapsed groups per browser', async () => {
    await seed();
    const res = await request(webApp(staff)).get('/');
    expect(res.text).toContain('menagerai.collapsedGroups');
  });
});

// ---------------------------------------------------------------------------
describe('admin UI — /admin/app-groups', () => {
  it('is admin-only', async () => {
    const res = await request(webApp(staff)).get('/admin/app-groups');
    expect(res.status).toBe(403);
  });

  it('lists groups in order with app counts, drag handles, up/down and the SortableJS script', async () => {
    await groupsSvc.createGroup({ key: 'fin', name: 'Finance' }, ACTOR);
    await groupsSvc.createGroup({ key: 'eng', name: 'Engineering' }, ACTOR);
    await addApp('ledger', 'Ledger', { group: 'fin' });
    await addApp('payroll', 'Payroll', { group: 'fin' });
    const res = await request(webApp(admin)).get('/admin/app-groups');
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html.indexOf('data-key="fin"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-key="fin"')).toBeLessThan(html.indexOf('data-key="eng"'));
    expect(html).toContain('class="drag-handle"');
    expect(html).toContain('action="/admin/app-groups/fin/move"');
    expect(html).toContain('action="/admin/app-groups/fin/delete"');
    expect(html).toContain('action="/admin/app-groups/reorder"');
    expect(html).toContain('<script src="/admin/vendor/sortable.min.js"></script>');
    expect(html).toContain(translate('en', 'appGroups.appCount', { n: 2 }));
    expect(html).toContain(translate('en', 'appGroups.appCount', { n: 0 }));
    // sidebar entry
    expect(html).toContain('href="/admin/app-groups"');
  });

  it('serves the vendored SortableJS file to admins', async () => {
    const res = await request(webApp(admin)).get('/admin/vendor/sortable.min.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('Sortable');
  });

  it('creates a group (PRG + success flash)', async () => {
    const res = await request(webApp(admin)).post('/admin/app-groups').type('form').send({ key: 'fin', name: 'Finance' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.appGroupCreated', 'success'));
    expect((await col.appGroups.findOne({ key: 'fin' }))?.name).toBe('Finance');
  });

  it('flashes an error for an invalid key', async () => {
    const res = await request(webApp(admin)).post('/admin/app-groups').type('form').send({ key: 'Bad Key' });
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.invalidAppGroupKey', 'error'));
  });

  it('renames, moves, reorders and deletes', async () => {
    for (const k of ['a', 'b', 'c']) await groupsSvc.createGroup({ key: k }, ACTOR);
    const app = webApp(admin);

    let res = await request(app).post('/admin/app-groups/b').type('form').send({ name: 'Bravo' });
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.appGroupUpdated', 'success'));
    expect((await col.appGroups.findOne({ key: 'b' }))?.name).toBe('Bravo');

    res = await request(app).post('/admin/app-groups/c/move').type('form').send({ dir: 'up' });
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.appGroupsReordered', 'success'));
    expect(await positions()).toEqual({ a: 0, c: 1, b: 2 });

    res = await request(app).post('/admin/app-groups/reorder').type('form').send('keys=b&keys=a&keys=c');
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.appGroupsReordered', 'success'));
    expect(await positions()).toEqual({ b: 0, a: 1, c: 2 });

    res = await request(app).post('/admin/app-groups/reorder').type('form').send('keys=b&keys=a');
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.invalidAppGroupOrder', 'error'));
    expect(await positions()).toEqual({ b: 0, a: 1, c: 2 });

    res = await request(app).post('/admin/app-groups/a/delete');
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.appGroupDeleted', 'success'));
    expect(await positions()).toEqual({ b: 0, c: 2 });
  });

  it('reorders a single group sent as a scalar form value', async () => {
    await groupsSvc.createGroup({ key: 'solo' }, ACTOR);
    const res = await request(webApp(admin)).post('/admin/app-groups/reorder').type('form').send('keys=solo');
    expect(res.headers.location).toBe(flashUrl('/admin/app-groups', 'flash.appGroupsReordered', 'success'));
  });

  it('404s an unknown group', async () => {
    const res = await request(webApp(admin)).post('/admin/app-groups/nope').type('form').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('admin UI — app pages show and set the group', () => {
  beforeEach(async () => {
    await groupsSvc.createGroup({ key: 'fin', name: 'Finance' }, ACTOR);
    await addApp('ledger', 'Ledger', { group: 'fin' });
    await addApp('wiki', 'Wiki');
  });

  it('app detail page has a group picker with the current group selected', async () => {
    const res = await request(webApp(admin)).get('/admin/apps/ledger');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<select name="group">');
    expect(res.text).toMatch(/<option value="fin" selected>Finance<\/option>/);
    expect(res.text).toContain(`<option value="">${translate('en', 'app.groupNone')}</option>`);
  });

  it('saving the config form sets the group; an unknown group flashes an error', async () => {
    const app = webApp(admin);
    let res = await request(app).post('/admin/apps/wiki').type('form').send({ name: 'Wiki', status: 'active', public_paths: '[]', default_base_url: '', group: 'fin' });
    expect(res.status).toBe(302);
    expect((await col.apps.findOne({ key: 'wiki' }))?.group).toBe('fin');

    res = await request(app).post('/admin/apps/wiki').type('form').send({ name: 'Wiki', status: 'active', public_paths: '[]', default_base_url: '', group: 'ghost' });
    expect(res.headers.location).toBe(flashUrl('/admin/apps/wiki', 'flash.unknownAppGroup', 'error'));
    expect((await col.apps.findOne({ key: 'wiki' }))?.group).toBe('fin');
  });

  it('apps list shows each app’s group', async () => {
    const res = await request(webApp(admin)).get('/admin/apps');
    expect(res.text).toContain(`<th>${translate('en', 'apps.colGroup')}</th>`);
    expect(res.text).toContain('<td>Finance</td>');
  });
});

// ---------------------------------------------------------------------------
describe('JSON API — /api/admin/app-groups', () => {
  it('creates, lists, renames, reorders and deletes', async () => {
    const app = webApp(null);
    expect((await request(app).post('/api/admin/app-groups').send({ key: 'fin', name: 'Finance' })).body).toEqual({ key: 'fin' });
    await request(app).post('/api/admin/app-groups').send({ key: 'eng' });

    let res = await request(app).get('/api/admin/app-groups');
    expect(res.status).toBe(200);
    expect(res.body.map((g: { key: string; position: number }) => [g.key, g.position])).toEqual([['fin', 0], ['eng', 1]]);

    res = await request(app).post('/api/admin/app-groups/eng').send({ name: 'Engineering' });
    expect(res.body).toEqual({ ok: true });

    res = await request(app).post('/api/admin/app-groups/reorder').send({ keys: ['eng', 'fin'] });
    expect(res.body).toEqual({ ok: true });
    expect(await positions()).toEqual({ eng: 0, fin: 1 });

    res = await request(app).post('/api/admin/app-groups/reorder').send({ keys: ['eng'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'flash.invalidAppGroupOrder' });

    res = await request(app).post('/api/admin/app-groups/fin/delete');
    expect(res.body).toEqual({ appsUngrouped: 0 });

    res = await request(app).post('/api/admin/app-groups').send({ key: 'eng' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'flash.appGroupExists' });
  });

  it('POST /apps/:key validates and sets group, and omitting it keeps it', async () => {
    const app = webApp(null);
    await groupsSvc.createGroup({ key: 'fin' }, ACTOR);
    await addApp('ledger', 'Ledger');

    expect((await request(app).post('/api/admin/apps/ledger').send({ group: 'fin' })).body).toEqual({ ok: true });
    expect((await col.apps.findOne({ key: 'ledger' }))?.group).toBe('fin');

    await request(app).post('/api/admin/apps/ledger').send({ name: 'General Ledger' });
    expect((await col.apps.findOne({ key: 'ledger' }))?.group).toBe('fin');

    const res = await request(app).post('/api/admin/apps/ledger').send({ group: 'ghost' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'flash.unknownAppGroup' });
  });
});
