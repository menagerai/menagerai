import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only the IdP library needs stubbing (no real network discovery in the provider step).
vi.mock('openid-client', () => ({
  Issuer: { discover: vi.fn(async () => ({ Client: class {} })) },
  generators: { codeVerifier: () => 'v', codeChallenge: () => 'c', state: () => 's', nonce: () => 'n' },
}));

// The app config is frozen at import, and ESM hoists static imports above top-level
// statements — so env for an in-memory SQLite (no Mongo) must be set and the app
// modules imported DYNAMICALLY inside beforeAll, after the env is in place.
let app: express.Express;
let db: typeof import('../src/db');
let superadminEmail: string;

beforeAll(async () => {
  process.env.SQLITE_PATH = ':memory:';
  delete process.env.MONGODB_CONN_STR;
  delete process.env.LOGTO_ENDPOINT;
  delete process.env.LOGTO_APP_ID;
  delete process.env.LOGTO_APP_SECRET;
  process.env.APP_ENCRYPTION_KEY = 'setup-route-test-key';
  process.env.COOKIE_SECURE = 'false';

  db = await import('../src/db');
  await db.connect();
  app = (await import('../src/app')).buildPublicApp({ mountGateway: false });
  superadminEmail = (await import('../src/config')).config.superadminEmail;
});
afterAll(async () => db.close());

describe('first-run setup wizard', () => {
  it('redirects everything to /setup until an admin has signed in', async () => {
    const res = await request(app).get('/').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/setup');
  });

  it('renders the provider step first', async () => {
    const res = await request(app).get('/setup');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connect Logto');
  });

  it('accepts provider config, persisting the secret ENCRYPTED, and advances to the admin step', async () => {
    const res = await request(app)
      .post('/setup/provider')
      .type('form')
      .send({ endpoint: 'https://tenant.logto.app', appId: 'app123', appSecret: 'the-app-secret' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/setup');

    const doc = await db.col.settings.findOne({ key: 'provider' });
    expect(doc?.appId).toBe('app123');
    expect((doc as any).appSecretEnc?.ct).toBeTruthy(); // stored as ciphertext blob
    expect(JSON.stringify(doc)).not.toContain('the-app-secret'); // never in the clear

    const step = await request(app).get('/setup');
    expect(step.text).toContain('Create the administrator');
  });

  it('seeds the superadmin, then shows the finish step, then completes on link', async () => {
    const seed = await request(app).post('/setup/superadmin');
    expect(seed.status).toBe(302);
    const admin = await db.col.users.findOne({ email: superadminEmail });
    expect(admin?.roles).toContain('system_admin');
    expect(admin?.logto_user_id).toBeNull(); // not linked yet

    const finish = await request(app).get('/setup');
    expect(finish.text).toContain('Sign in to finish');

    // Simulate the completing sign-in linking the superadmin.
    await db.col.users.updateOne({ email: superadminEmail }, { $set: { logto_user_id: 'logto-sub-1' } });

    // Setup is now complete: /setup redirects away and normal routing is restored.
    const done = await request(app).get('/setup').redirects(0);
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/');
  });
});
