import path from 'path';
import ejs from 'ejs';
import { describe, expect, it } from 'vitest';
import { translate } from '../src/i18n';
import { formatInstant } from '../src/util';

const VIEWS = path.resolve(__dirname, '..', 'views');
// Every view gets t()/lang/fmtTime from res.locals in the app; provide the real
// ones here so the smoke render exercises actual locale lookups (en) and the
// timezone-aware time formatter.
const t = (key: string, vars?: Record<string, string | number>) => translate('en', key, vars);
const fmtTime = (value: Date | string | number | null | undefined, opts?: { seconds?: boolean }) =>
  formatInstant(value, 'Asia/Shanghai', opts);
const render = (file: string, locals: Record<string, unknown>) =>
  ejs.renderFile(path.join(VIEWS, file), { t, lang: 'en', fmtTime, ...locals }, {});

const user = { email: 'admin@example.com', name: 'Admin' };
const appDoc = {
  key: 'demo',
  name: 'Demo',
  base_path: '/apps/demo',
  auth_mode: 'proxy',
  status: 'active',
  description: '',
  proxy_secret: 'secret',
  public_paths: [{ method: 'GET', pattern: '/healthz' }],
};

// Every admin/portal template must render without throwing, given the locals its
// route supplies. Catches template typos and undefined-variable references that
// would otherwise only surface on a live page hit.
const cases: [string, Record<string, unknown>][] = [
  ['launcher.ejs', { user, isAdmin: false, apps: [{ key: 'demo', name: 'Demo', url: '/apps/demo' }] }],
  // Demo persona picker (bare page, no session yet) + the idle demo banner.
  [
    'demo-login.ejs',
    {
      user: null,
      isAdmin: false,
      demoMode: true,
      demoResetAt: null,
      next: '/',
      personas: [{ key: 'bo', email: 'bo@demo.menagerai.dev', name: 'Bo (Analyst)', roles: ['analyst'], overrides: [] }],
    },
  ],
  // Armed demo banner (countdown branch) + GA tag injection on the launcher.
  ['launcher.ejs', { user, isAdmin: false, apps: [], demoMode: true, demoResetAt: 1893456000000, gaId: 'G-TEST12345' }],
  ['no-access.ejs', { user: null, app: 'demo', reason: null }],
  ['no-access.ejs', { user, app: null, reason: 'not_provisioned' }],
  ['admin/users.ejs', { user, isAdmin: true, users: [], q: '', managementConfigured: false, msg: null }],
  ['admin/user-new.ejs', { user, isAdmin: true, roles: [], managementConfigured: false }],
  [
    'admin/user.ejs',
    {
      user,
      isAdmin: true,
      target: { _id: 'u1', email: 't@example.com', status: 'active', roles: [], app_overrides: [], department: '', logto_user_id: null, last_login_at: null },
      roles: [{ key: 'system_admin', name: 'Admin' }],
      apps: [appDoc],
      access: [{ app: 'demo', allowed: true }],
      topApps: [{ app_key: 'demo', days: 3, last: new Date() }],
      heatmap: { weeks: [[{ day: '2026-06-23', count: 1, level: 1 }, { day: null, count: 0, level: 0 }]], max: 1 },
      heatmapDays: 365,
      isSuperadmin: false,
      msg: null,
    },
  ],
  [
    // superadmin: Delete/Disable must be suppressed (protected branch)
    'admin/user.ejs',
    {
      user,
      isAdmin: true,
      target: { _id: 'sa', email: 'admin@example.com', status: 'active', roles: ['system_admin'], app_overrides: [], department: '', logto_user_id: 'lx', last_login_at: null },
      roles: [{ key: 'system_admin', name: 'Admin' }],
      apps: [appDoc],
      access: [],
      topApps: [], // exercise the "No usage recorded yet" branch
      heatmap: { weeks: [], max: 0 },
      heatmapDays: 365,
      isSuperadmin: true,
      msg: null,
    },
  ],
  // roles list with both the protected system_admin and a deletable role
  ['admin/roles.ejs', { user, isAdmin: true, roles: [{ key: 'system_admin', name: 'Admin', grants: [] }, { key: 'sales', name: 'Sales', grants: [] }], msg: null }],
  ['admin/role.ejs', { user, isAdmin: true, role: { key: 'r', name: 'R', grants: [] }, availableApps: [appDoc], protectedRole: 'system_admin', msg: null }],
  // system_admin role: the rename form must be suppressed (protected branch)
  ['admin/role.ejs', { user, isAdmin: true, role: { key: 'system_admin', name: 'Admin', grants: [] }, availableApps: [appDoc], protectedRole: 'system_admin', msg: null }],
  // role where every app is already granted: the add-grant picker is disabled
  ['admin/role.ejs', { user, isAdmin: true, role: { key: 'full', name: 'Full', grants: [{ app: 'demo' }] }, availableApps: [], protectedRole: 'system_admin', msg: null }],
  ['admin/apps.ejs', { user, isAdmin: true, apps: [appDoc], msg: null }],
  ['admin/app.ejs', { user, isAdmin: true, app: appDoc, access: [], topUsers: [{ user_id: 'u1', email: 't@x.com', days: 2, last: new Date() }], heatmap: { weeks: [[{ day: '2026-06-23', count: 2, level: 2 }]], max: 2 }, heatmapDays: 365, defaultBaseUrls: ['app.example.com', 'intra.example.com'], msg: null }],
  ['admin/email-rules.ejs', { user, isAdmin: true, rules: [{ _id: 'r1', type: 'domain', pattern: 'example.com', status: 'active', description: '' }], msg: null }],
  ['admin/audit.ejs', { user, isAdmin: true, logs: [] }],
  // Profile (self-service sessions): current + other + a legacy doc missing
  // ip/user_agent/last_seen (rendered as fallbacks). isAdmin:false here; the
  // isAdmin:true / sidebar branch is exercised in the dedicated test below.
  [
    'profile.ejs',
    {
      user,
      isAdmin: false,
      sessions: [
        { id: 's1', ip: '203.0.113.5', device: 'Chrome on macOS', userAgent: 'Mozilla/5.0 ... Chrome', createdAt: new Date(), lastSeenAt: new Date(), isCurrent: true },
        { id: 's2', ip: '198.51.100.9', device: 'Safari on iOS', userAgent: 'Mozilla/5.0 ... Safari', createdAt: new Date(), lastSeenAt: new Date(), isCurrent: false },
        { id: 's3', ip: '', device: 'Unknown device', userAgent: '', createdAt: new Date(), lastSeenAt: new Date(), isCurrent: false },
      ],
    },
  ],
];

// Admin pages set activePath (admin router) for sidebar highlighting; the
// sidebar layout itself shows for any admin (isAdmin), on every page.
const allCases: [string, Record<string, unknown>][] = cases.map(([file, locals]) =>
  file.startsWith('admin/') ? [file, { ...locals, activePath: '/admin/users' }] : [file, locals],
);

describe('view templates render without throwing', () => {
  it.each(allCases)('%s', async (file, locals) => {
    const html = await render(file, locals);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('the sidebar (admin panel) shows for admins on every page, not for others', async () => {
    // Admin on an admin page
    const adminPage = await render('admin/users.ejs', { user, isAdmin: true, users: [], q: '', managementConfigured: true, msg: null, activePath: '/admin/users' });
    expect(adminPage).toContain('class="sidebar"');
    expect(adminPage).toContain('id="navToggle"');

    // Admin on the portal launcher: sidebar present too
    const adminLauncher = await render('launcher.ejs', { user, isAdmin: true, apps: [] });
    expect(adminLauncher).toContain('class="sidebar"');

    // Admin on the profile page: sidebar present, and the empty-sessions branch renders
    const adminProfile = await render('profile.ejs', { user, isAdmin: true, sessions: [] });
    expect(adminProfile).toContain('class="sidebar"');
    expect(adminProfile).toContain(translate('en', 'profile.empty'));

    // Non-admin on the launcher: no sidebar, no admin panel button
    const plainLauncher = await render('launcher.ejs', { user, isAdmin: false, apps: [] });
    expect(plainLauncher).not.toContain('class="sidebar"');
    expect(plainLauncher).not.toContain('id="navToggle"');
  });
});
