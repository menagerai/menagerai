import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// buildPublicApp mounts every router, so stub the IO modules to keep import inert
// (same approach as gateway-listener.test.ts).
vi.mock('../src/db', () => ({ col: {}, connect: async () => {} }));
vi.mock('../src/sessions', () => ({ getSessionId: () => undefined, touchSession: async () => null, sessionIsRevoked: async () => false, destroyUserSessions: vi.fn() }));
vi.mock('../src/decide', () => ({ decide: vi.fn(), decideCached: vi.fn(), evictUser: vi.fn(), evictAll: vi.fn() }));
vi.mock('../src/usage', () => ({ recordUsage: vi.fn() }));
vi.mock('../src/idp', () => ({ getIdentityProvider: () => null, generators: {}, resetProvider: vi.fn() }));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

import { buildPublicApp } from '../src/app';
import { runStartupChecks } from '../src/startup';

const REQUIRED = [
  'PORTAL_BASE_URL',
  'SUPERADMIN_EMAIL',
  'LOGTO_ENDPOINT',
  'LOGTO_APP_ID',
  'LOGTO_APP_SECRET',
  'LOGTO_M2M_APP_ID',
  'LOGTO_M2M_APP_SECRET',
  'LOGTO_MANAGEMENT_API_RESOURCE',
];

describe('runStartupChecks — env presence', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of REQUIRED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of REQUIRED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reports every required var as missing and marks the check not-ok', async () => {
    // LOGTO_ENDPOINT is unset, so the live OIDC/M2M checks are skipped — hermetic.
    const check = await runStartupChecks();
    expect(check.ok).toBe(false);
    for (const k of REQUIRED) {
      expect(check.problems.some((p) => p.key === k && p.severity === 'missing')).toBe(true);
    }
  });
});

describe('config-error guard', () => {
  const badStartup = {
    ok: false as const,
    problems: [{ key: 'LOGTO_ENDPOINT', severity: 'missing' as const, message: 'LOGTO_ENDPOINT is not set.' }],
    checkedAt: new Date(),
  };

  it('serves the configuration screen (503) for a normal page', async () => {
    const app = buildPublicApp({ mountGateway: false, startup: badStartup });
    const res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(res.text).toContain('Configuration required');
    expect(res.text).toContain('LOGTO_ENDPOINT');
  });

  it('still lets /healthz through so the container does not crash-loop', async () => {
    const app = buildPublicApp({ mountGateway: false, startup: badStartup });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });
});
