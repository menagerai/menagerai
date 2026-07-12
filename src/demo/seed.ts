import crypto from 'crypto';
import { config } from '../config';
import { col } from '../db';
import { AppOverride } from '../types';

// The demo dataset and its idempotent seeder. DEMO_MODE only — never imported on a
// normal boot path except through the demo-gated branches in server-all/app. The
// data is deliberately small and story-driven: four personas whose launchers each
// look different, three mock apps, and the roles/grants/overrides that connect
// them so a visitor can see every branch of the authorization model (role grant,
// multi-role, per-user allow, per-user deny → default deny) at a glance.

export interface DemoPersona {
  key: string; // stable id for the i18n blurb (demo.persona.<key>) and picker order
  email: string; // lowercased; also the login selector — must be unique
  name: string;
  roles: string[];
  overrides: { app: string; effect: 'allow' | 'deny'; reason: string }[];
}

interface DemoRole {
  key: string;
  name: string;
  description: string;
  grants: string[]; // app keys this role grants (allow-only)
}

interface DemoApp {
  key: string;
  name: string;
  description: string;
}

// Reserved domain so no real mailbox is impersonated by a demo persona.
const DEMO_DOMAIN = 'demo.menagerai.dev';

export const DEMO_APPS: DemoApp[] = [
  { key: 'pulse', name: 'Pulse Analytics', description: 'Product analytics dashboard (demo).' },
  { key: 'wiki', name: 'Aviary Wiki', description: 'Internal knowledge base (demo).' },
  { key: 'desk', name: 'Perch Desk', description: 'Support ticket queue (demo).' },
];

const DEMO_ROLES: DemoRole[] = [
  // system_admin mirrors the production role: admin-portal access, no app grants of
  // its own (the superadmin persona reaches apps via a per-user allow, below).
  { key: 'system_admin', name: 'System Administrator', description: 'Full access to the demo admin portal.', grants: [] },
  { key: 'analyst', name: 'Analyst', description: 'Reaches Pulse Analytics.', grants: ['pulse'] },
  { key: 'editor', name: 'Wiki Editor', description: 'Reaches Aviary Wiki.', grants: ['wiki'] },
  { key: 'support', name: 'Support Agent', description: 'Reaches Perch Desk and Aviary Wiki.', grants: ['desk', 'wiki'] },
];

export const DEMO_PERSONAS: DemoPersona[] = [
  {
    key: 'ada',
    email: `ada@${DEMO_DOMAIN}`,
    name: 'Ada (Superadmin)',
    roles: ['system_admin', 'analyst', 'editor', 'support'],
    overrides: [],
  },
  {
    key: 'bo',
    email: `bo@${DEMO_DOMAIN}`,
    name: 'Bo (Analyst)',
    roles: ['analyst'],
    overrides: [],
  },
  {
    key: 'cam',
    email: `cam@${DEMO_DOMAIN}`,
    name: 'Cam (Editor)',
    // editor → wiki; plus a per-user allow on desk to demo the override path.
    roles: ['editor'],
    overrides: [{ app: 'desk', effect: 'allow', reason: 'Demo: per-user allow override' }],
  },
  {
    key: 'dee',
    email: `dee@${DEMO_DOMAIN}`,
    name: 'Dee (Support, wiki revoked)',
    // support → desk + wiki; a per-user deny on wiki demonstrates deny beating a
    // role grant (decideFrom precedence), leaving Dee with desk only.
    roles: ['support'],
    overrides: [{ app: 'wiki', effect: 'deny', reason: 'Demo: per-user deny override' }],
  },
];

// Derive an app's proxy secret from DEMO_SECRET so it is stable across resets (the
// mock-app containers hold it in env and must keep working) yet not committed to
// the repo. Per-app so a leak is contained to one app.
export function demoProxySecret(appKey: string): string {
  return crypto.createHmac('sha256', config.demoSecret).update(`proxy:${appKey}`).digest('base64url');
}

// Log the derived per-app secrets once at boot so the operator can paste each into
// its mock app's MENAGERAI_PROXY_SECRET env. Printed only in demo mode.
export function logDemoSecrets(): void {
  console.log('[demo] derived per-app proxy secrets (set each as the app container MENAGERAI_PROXY_SECRET):');
  for (const a of DEMO_APPS) console.log(`[demo]   ${a.key}: ${demoProxySecret(a.key)}`);
}

// Idempotent: upsert-by-natural-key so this is safe to run after a wipe (the reset
// path) AND as a self-heal if a persona was deleted mid-window via the admin UI.
export async function seedDemo(): Promise<void> {
  const now = new Date();

  for (const r of DEMO_ROLES) {
    await col.roles.updateOne(
      { key: r.key },
      {
        $set: { name: r.name, description: r.description, grants: r.grants.map((app) => ({ app })), updated_at: now },
        $setOnInsert: { key: r.key, created_at: now },
      },
      { upsert: true },
    );
  }

  for (const a of DEMO_APPS) {
    await col.apps.updateOne(
      { key: a.key },
      {
        $set: {
          name: a.name,
          base_path: `/apps/${a.key}`,
          auth_mode: 'proxy',
          status: 'active',
          description: a.description,
          public_paths: [{ method: 'GET', pattern: '/healthz' }],
          proxy_secret: demoProxySecret(a.key),
          updated_at: now,
        },
        $setOnInsert: { key: a.key, created_at: now },
      },
      { upsert: true },
    );
  }

  // Allow-rules so the personas (and hand-added demo.menagerai.dev users) are
  // creatable/visible through the admin UI: a domain rule plus one exact rule per
  // persona (the domain rule alone would suffice, but the exact rules make the
  // Email-rules screen more illustrative).
  await col.emailRules.updateOne(
    { type: 'domain', pattern: DEMO_DOMAIN },
    { $set: { status: 'active', description: 'Demo personas' }, $setOnInsert: { type: 'domain', pattern: DEMO_DOMAIN, created_at: now } },
    { upsert: true },
  );

  for (const p of DEMO_PERSONAS) {
    const overrides: AppOverride[] = p.overrides.map((o) => ({
      app: o.app,
      effect: o.effect,
      reason: o.reason,
      created_by: 'demo-seed',
      created_at: now,
    }));
    await col.users.updateOne(
      { email: p.email },
      {
        $set: {
          name: p.name,
          status: 'active',
          source: 'manual',
          roles: p.roles,
          app_overrides: overrides,
          logto_user_id: null,
          updated_at: now,
        },
        $setOnInsert: { email: p.email, created_at: now, last_login_at: null, last_synced_to_logto_at: null },
      },
      { upsert: true },
    );
  }
}
