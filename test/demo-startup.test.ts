import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cfg: { demoSecret: '' } }));
vi.mock('../src/config', () => ({ config: h.cfg }));

import { runDemoStartupChecks } from '../src/demo/startup';

const GOOD_SECRET = 'x'.repeat(20);
let savedBase: string | undefined;

beforeEach(() => {
  savedBase = process.env.PORTAL_BASE_URL;
  process.env.PORTAL_BASE_URL = 'https://demo.example.com';
  h.cfg.demoSecret = GOOD_SECRET;
});
afterEach(() => {
  if (savedBase === undefined) delete process.env.PORTAL_BASE_URL;
  else process.env.PORTAL_BASE_URL = savedBase;
});

describe('runDemoStartupChecks', () => {
  it('is ok with a base URL and a strong DEMO_SECRET — and needs no LOGTO_* vars', () => {
    const check = runDemoStartupChecks();
    expect(check.ok).toBe(true);
    expect(check.problems).toHaveLength(0);
  });

  it('flags a missing DEMO_SECRET', () => {
    h.cfg.demoSecret = '';
    const check = runDemoStartupChecks();
    expect(check.ok).toBe(false);
    expect(check.problems.some((p) => p.key === 'DEMO_SECRET' && p.severity === 'missing')).toBe(true);
  });

  it('flags a too-short DEMO_SECRET as invalid', () => {
    h.cfg.demoSecret = 'short';
    const check = runDemoStartupChecks();
    expect(check.problems.some((p) => p.key === 'DEMO_SECRET' && p.severity === 'invalid')).toBe(true);
  });

  it('flags a missing PORTAL_BASE_URL', () => {
    delete process.env.PORTAL_BASE_URL;
    const check = runDemoStartupChecks();
    expect(check.problems.some((p) => p.key === 'PORTAL_BASE_URL' && p.severity === 'missing')).toBe(true);
  });
});
