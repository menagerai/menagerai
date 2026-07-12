import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rolesUpdate: vi.fn(),
  appsUpdate: vi.fn(),
  usersUpdate: vi.fn(),
  rulesUpdate: vi.fn(),
}));

vi.mock('../src/config', () => ({ config: { demoSecret: 'test-demo-secret-0123456789' } }));
vi.mock('../src/db', () => ({
  col: {
    roles: { updateOne: h.rolesUpdate },
    apps: { updateOne: h.appsUpdate },
    users: { updateOne: h.usersUpdate },
    emailRules: { updateOne: h.rulesUpdate },
  },
}));

import { DEMO_APPS, DEMO_PERSONAS, demoProxySecret, seedDemo } from '../src/demo/seed';

afterEach(() => vi.clearAllMocks());

describe('demoProxySecret', () => {
  it('is deterministic per key and differs across keys', () => {
    expect(demoProxySecret('pulse')).toBe(demoProxySecret('pulse'));
    expect(demoProxySecret('pulse')).not.toBe(demoProxySecret('wiki'));
  });
});

describe('seedDemo', () => {
  it('upserts all roles, apps, personas and the domain rule', async () => {
    await seedDemo();
    expect(h.rolesUpdate).toHaveBeenCalledTimes(4);
    expect(h.appsUpdate).toHaveBeenCalledTimes(DEMO_APPS.length);
    expect(h.usersUpdate).toHaveBeenCalledTimes(DEMO_PERSONAS.length);
    expect(h.rulesUpdate).toHaveBeenCalledTimes(1);
  });

  it('writes each app active/proxy with its derived secret and a /healthz public path', async () => {
    await seedDemo();
    const pulse = h.appsUpdate.mock.calls.find((c) => c[0].key === 'pulse');
    expect(pulse).toBeTruthy();
    const set = pulse![1].$set;
    expect(set.auth_mode).toBe('proxy');
    expect(set.status).toBe('active');
    expect(set.proxy_secret).toBe(demoProxySecret('pulse'));
    expect(set.public_paths).toEqual([{ method: 'GET', pattern: '/healthz' }]);
  });

  it('encodes the override matrix — Cam allows desk, Dee denies wiki', async () => {
    await seedDemo();
    const cam = h.usersUpdate.mock.calls.find((c) => String(c[0].email).startsWith('cam@'));
    const dee = h.usersUpdate.mock.calls.find((c) => String(c[0].email).startsWith('dee@'));
    expect(cam![1].$set.app_overrides).toEqual([expect.objectContaining({ app: 'desk', effect: 'allow' })]);
    expect(dee![1].$set.app_overrides).toEqual([expect.objectContaining({ app: 'wiki', effect: 'deny' })]);
  });
});
