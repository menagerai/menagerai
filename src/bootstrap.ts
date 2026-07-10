import crypto from 'crypto';
import { config } from './config';
import { col } from './db';

// Idempotent bootstrap helpers shared by the seed CLI (src/seed.ts), the startup
// preflight-gated auto-seed (src/server-all.ts / src/server-web.ts), and the
// break-glass CLI (src/relink.ts).

// Ensure the superadmin exists: an exact email allow-rule, the system_admin role,
// and the superadmin user (unlinked — logto_user_id null — until first sign-in).
export async function ensureSuperadmin(email: string): Promise<void> {
  const lower = email.toLowerCase();
  const now = new Date();

  await col.emailRules.updateOne(
    { type: 'exact', pattern: lower },
    { $setOnInsert: { type: 'exact', pattern: lower, description: 'Superadmin address', status: 'active', created_at: now } },
    { upsert: true },
  );

  await col.roles.updateOne(
    { key: 'system_admin' },
    {
      $setOnInsert: {
        key: 'system_admin',
        name: 'System Administrator',
        description: `Full access to the ${config.brandName} admin portal.`,
        grants: [],
        created_at: now,
        updated_at: now,
      },
    },
    { upsert: true },
  );

  await col.users.updateOne(
    { email: lower },
    {
      $setOnInsert: {
        email: lower,
        name: 'Superadmin',
        status: 'active',
        source: 'manual',
        roles: ['system_admin'],
        app_overrides: [],
        logto_user_id: null,
        created_at: now,
        last_login_at: null,
        last_synced_to_logto_at: null,
      },
      $set: { updated_at: now },
    },
    { upsert: true },
  );
  // Ensure the role is present even if the user pre-existed, and the account active.
  await col.users.updateOne({ email: lower }, { $addToSet: { roles: 'system_admin' } });
  await col.users.updateOne({ email: lower }, { $set: { status: 'active' } });
}

// Ensure a demo app exists (behind the gateway) and is granted to the superadmin,
// so a fresh install has something to launch. Returns the app's proxy secret.
//
// Seeded ONLY on a genuinely fresh install (empty app registry). An established
// deployment — e.g. a downstream fork that already runs real apps — gets nothing,
// so a production portal never sprouts a stray demo tile. (This also matters
// because seeding runs on every boot: an unconditional upsert would resurrect the
// demo app on every restart even after an operator deleted it.)
export async function ensureDemoApp(grantEmail: string): Promise<string | undefined> {
  if (await col.apps.findOne({})) return undefined;
  const now = new Date();
  const existing = await col.apps.findOne({ key: 'demo' });
  const proxySecret = existing?.proxy_secret || crypto.randomBytes(32).toString('base64url');
  await col.apps.updateOne(
    { key: 'demo' },
    {
      $set: {
        name: 'Demo App',
        base_path: '/apps/demo',
        auth_mode: 'proxy',
        status: 'active',
        description: 'A demo app protected by the gateway.',
        public_paths: [
          { method: 'GET', pattern: '/healthz' },
          { method: 'GET', pattern: '/api/public' },
          { method: 'GET', pattern: '/api/public/**' },
        ],
        updated_at: now,
      },
      $setOnInsert: { key: 'demo', proxy_secret: proxySecret, created_at: now },
    },
    { upsert: true },
  );

  const user = await col.users.findOne({ email: grantEmail.toLowerCase() });
  if (user) {
    const has = (user.app_overrides || []).some((o) => o.app === 'demo' && o.effect === 'allow');
    if (!has) {
      await col.users.updateOne(
        { _id: user._id },
        { $push: { app_overrides: { app: 'demo', effect: 'allow', reason: 'bootstrap', created_by: 'seed', created_at: now } } },
      );
    }
  }
  const app = await col.apps.findOne({ key: 'demo' });
  return app?.proxy_secret;
}

// Break-glass: clear a user's IdP link so the account can be re-claimed on the next
// sign-in (provider migration or lockout recovery). Re-ensures superadmin standing.
export async function relinkUser(email: string): Promise<void> {
  await ensureSuperadmin(email);
  await col.users.updateOne({ email: email.toLowerCase() }, { $set: { logto_user_id: null, updated_at: new Date() } });
}

