import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findOne, appCached, decideCached, recordUsage } = vi.hoisted(() => ({ findOne: vi.fn(), appCached: vi.fn(), decideCached: vi.fn(), recordUsage: vi.fn() }));
vi.mock('../src/db', () => ({ col: { apps: { findOne } } }));
vi.mock('../src/decide', () => ({ appCached, decideCached }));
vi.mock('../src/usage', () => ({ recordUsage }));

import { gatewayRouter } from '../src/routes/gateway';

const fakeApp = {
  key: 'demo',
  status: 'active',
  proxy_secret: 'SECRET123',
  default_base_url: 'app.example.com',
  public_paths: [
    { method: 'GET', pattern: '/healthz' },
    { method: 'GET', pattern: '/api/public' },
    { method: 'GET', pattern: '/api/public/**' },
  ],
};

function makeApp(user: unknown, opts: { sessionRevoked?: boolean } = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = user;
    (req as { sessionRevoked?: boolean }).sessionRevoked = opts.sessionRevoked;
    next();
  });
  app.use(gatewayRouter);
  return app;
}

const aUser = { _id: 'u1', email: 'a@example.com', roles: ['staff'] };

function verify(app: express.Express, uri: string, method = 'GET') {
  return request(app).get('/gateway/verify').set('X-Forwarded-Uri', uri).set('X-Forwarded-Method', method);
}

beforeEach(() => {
  findOne.mockReset();
  appCached.mockReset();
  decideCached.mockReset();
  recordUsage.mockReset();
  // The verify handler now resolves the app through the cached registry helper.
  appCached.mockImplementation(async (key: string) => (key === 'demo' ? fakeApp : null));
});

describe('/gateway/verify — routing & app resolution', () => {
  it('404 for a non-/apps path', async () => {
    const res = await verify(makeApp(null), '/login');
    expect(res.status).toBe(404);
  });
  it('404 for an unknown app key', async () => {
    const res = await verify(makeApp(null), '/apps/ghost/x');
    expect(res.status).toBe(404);
  });
});

describe('/gateway/verify — public paths (anonymous)', () => {
  it('lets a public read through with 200 and NO identity headers', async () => {
    const res = await verify(makeApp(null), '/apps/demo/api/public/abc');
    expect(res.status).toBe(200);
    expect(res.headers['x-menagerai-user-email']).toBeUndefined();
    expect(res.headers['x-menagerai-proxy-secret']).toBeUndefined();
  });
  it('does not treat a protected path as public', async () => {
    decideCached.mockResolvedValue({ allowed: false });
    const res = await verify(makeApp(null), '/apps/demo/api/tree');
    expect(res.status).toBe(401); // no user → unauth, not public
  });
});

describe('/gateway/verify — unauthenticated', () => {
  it('redirects a browser navigation to the app default base URL with next', async () => {
    const res = await verify(makeApp(null), '/apps/demo/api/tree').set('Sec-Fetch-Mode', 'navigate');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://app.example.com/login?next=');
    expect(res.headers.location).toContain(encodeURIComponent('/apps/demo/api/tree'));
  });
  it('falls back to the request/canonical origin when the app default base URL is not allowlisted', async () => {
    appCached.mockImplementation(async (key: string) => (key === 'demo' ? { ...fakeApp, default_base_url: 'evil.example.com' } : null));
    const res = await verify(makeApp(null), '/apps/demo/api/tree')
      .set('Sec-Fetch-Mode', 'navigate')
      .set('X-Forwarded-Host', 'notallowed.example.com')
      .set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://portal.test/login?next=');
  });
  it('forces an interactive login when the presented session was revoked', async () => {
    const res = await verify(makeApp(null, { sessionRevoked: true }), '/apps/demo/api/tree').set('Sec-Fetch-Mode', 'navigate');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?next=');
    expect(res.headers.location).toContain('&force=1');
  });
  it('returns 401 JSON for an API/XHR request', async () => {
    const res = await verify(makeApp(null), '/apps/demo/api/tree').set('Accept', 'application/json');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthenticated' });
  });
});

describe('/gateway/verify — authorized', () => {
  it('200 + injects identity and the per-app proxy secret on allow', async () => {
    decideCached.mockResolvedValue({ allowed: true, reason: 'allow_role' });
    const res = await verify(makeApp(aUser), '/apps/demo/api/tree');
    expect(res.status).toBe(200);
    expect(res.headers['x-menagerai-user-email']).toBe('a@example.com');
    expect(res.headers['x-menagerai-proxy-secret']).toBe('SECRET123');
    expect(res.headers['x-menagerai-roles']).toBe('staff');
    // Access is binary: no per-app role header is forwarded.
    expect(res.headers['x-menagerai-app-role']).toBeUndefined();
    // Usage recorded for the (user, app) on allow.
    expect(recordUsage).toHaveBeenCalledWith('u1', 'demo');
  });
});

describe('/gateway/verify — usage is recorded ONLY on real allowed access', () => {
  it('does not record usage for public, unauthenticated, or forbidden requests', async () => {
    await verify(makeApp(null), '/apps/demo/api/public/abc'); // public/anonymous
    decideCached.mockResolvedValue({ allowed: false });
    await verify(makeApp(null), '/apps/demo/api/tree').set('Accept', 'application/json'); // unauth
    await verify(makeApp(aUser), '/apps/demo/api/tree').set('Accept', 'application/json'); // forbidden
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('/gateway/verify — forbidden', () => {
  it('redirects a denied browser to the no-access page', async () => {
    decideCached.mockResolvedValue({ allowed: false });
    const res = await verify(makeApp(aUser), '/apps/demo/api/tree').set('Sec-Fetch-Mode', 'navigate');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/no-access?app=demo');
  });
  it('returns 403 JSON for a denied API request', async () => {
    decideCached.mockResolvedValue({ allowed: false });
    const res = await verify(makeApp(aUser), '/apps/demo/api/tree').set('Accept', 'application/json');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', app: 'demo' });
  });
});

describe('/gateway/verify — traversal cannot ride the public allowlist', () => {
  it('encoded ../ in a public-looking URL resolves to a PROTECTED path → 401, not anonymous 200', async () => {
    const res = await verify(makeApp(null), '/apps/demo/api/public/..%2f..%2fadmin').set('Accept', 'application/json');
    // normalizes to /apps/demo/admin (protected); must NOT be treated as public.
    expect(res.status).toBe(401);
    expect(res.headers['x-menagerai-proxy-secret']).toBeUndefined();
  });
});
