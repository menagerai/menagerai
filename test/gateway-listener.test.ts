import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// No cookie on these requests, so loadUser short-circuits and the verify handler
// 404s on a non-/apps path before touching the DB — but the routers imported by
// buildPublicApp still need these IO modules stubbed so import/mount is inert.
vi.mock('../src/db', () => ({ col: {} }));
vi.mock('../src/sessions', () => ({ getSessionId: () => undefined, touchSession: async () => null, sessionIsRevoked: async () => false, destroyUserSessions: vi.fn() }));
vi.mock('../src/decide', () => ({ decide: vi.fn(), decideCached: vi.fn(), evictUser: vi.fn(), evictAll: vi.fn() }));
vi.mock('../src/usage', () => ({ recordUsage: vi.fn() }));
vi.mock('../src/idp', () => ({ getIdentityProvider: () => null, generators: {}, resetProvider: vi.fn() }));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

import { buildGatewayApp, buildPublicApp } from '../src/app';

// A passing preflight → the app routes normally (no config screen). buildPublicApp
// now requires this; the config-error path is covered in startup-checks.test.ts.
const okStartup = { ok: true as const, problems: [], checkedAt: new Date() };

// A bare GET /gateway/verify (no X-Forwarded-Uri) resolves to a non-/apps path, so
// the gateway router answers "Unknown path." (404) when it is mounted. When it is
// NOT mounted, the request falls through to the global "Not found" 404 — that
// difference is exactly what proves whether verify is being served.
function verify(app: ReturnType<typeof buildGatewayApp>) {
  return request(app).get('/gateway/verify');
}

describe('gateway listener wiring', () => {
  it('the internal gateway app serves /gateway/verify', async () => {
    const res = await verify(buildGatewayApp());
    expect(res.status).toBe(404);
    expect(res.text).toBe('Unknown path.'); // handled by the gateway router
  });

  it('the public app serves /gateway/verify when mountGateway is true', async () => {
    const res = await verify(buildPublicApp({ mountGateway: true, startup: okStartup }));
    expect(res.status).toBe(404);
    expect(res.text).toBe('Unknown path.'); // gateway router mounted
  });

  it('the public app does NOT serve /gateway/verify when mountGateway is false', async () => {
    const res = await verify(buildPublicApp({ mountGateway: false, startup: okStartup }));
    expect(res.status).toBe(404);
    expect(res.text).toBe('Not found'); // global catch-all — verify is unreachable here
  });
});
