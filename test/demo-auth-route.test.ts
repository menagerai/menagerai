import path from 'path';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cfg: { demoMode: true, brandName: 'Menagerai' },
  usersFindOne: vi.fn(),
  usersUpdateOne: vi.fn(),
  createSession: vi.fn(async () => 'sid1'),
  setSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  destroySession: vi.fn(),
  getSessionId: vi.fn(() => undefined),
  audit: vi.fn(),
  seedDemo: vi.fn(async () => {}),
  armReset: vi.fn(),
  getResetAt: vi.fn(() => null),
}));

vi.mock('../src/config', () => ({ config: h.cfg }));
vi.mock('../src/db', () => ({ col: { users: { findOne: h.usersFindOne, updateOne: h.usersUpdateOne } } }));
vi.mock('../src/audit', () => ({ audit: h.audit }));
vi.mock('../src/sessions', () => ({
  createSession: h.createSession,
  setSessionCookie: h.setSessionCookie,
  clearSessionCookie: h.clearSessionCookie,
  destroySession: h.destroySession,
  getSessionId: h.getSessionId,
}));
vi.mock('../src/demo/seed', () => ({
  seedDemo: h.seedDemo,
  DEMO_PERSONAS: [
    { key: 'ada', email: 'ada@demo.menagerai.dev', name: 'Ada', roles: ['system_admin'], overrides: [] },
    { key: 'bo', email: 'bo@demo.menagerai.dev', name: 'Bo', roles: ['analyst'], overrides: [] },
  ],
}));
vi.mock('../src/demo/reset', () => ({ armReset: h.armReset, getResetAt: h.getResetAt }));

import { demoAuthRouter } from '../src/demo/auth';
import { i18n } from '../src/i18n'; // real — supplies res.locals.t for the picker view

function makeApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', 'views'));
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  app.use(i18n);
  app.use((_req, res, next) => {
    res.locals.brand = 'Menagerai';
    const t = res.locals.t as (k: string, v?: Record<string, string | number>) => string;
    res.locals.t = (k: string, v?: Record<string, string | number>) => t(k, { brand: 'Menagerai', ...(v || {}) });
    next();
  });
  app.use(demoAuthRouter);
  return app;
}

beforeEach(() => {
  h.cfg.demoMode = true;
  h.usersFindOne.mockReset();
  h.createSession.mockClear();
  h.setSessionCookie.mockClear();
  h.armReset.mockClear();
  h.seedDemo.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('GET /login (persona picker)', () => {
  it('renders and lists the persona emails', async () => {
    const res = await request(makeApp()).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ada@demo.menagerai.dev');
    expect(res.text).toContain('bo@demo.menagerai.dev');
  });
});

describe('POST /demo/login', () => {
  it('mints a session for a known persona, arms the reset, and redirects to a safe next', async () => {
    h.usersFindOne.mockResolvedValueOnce({ _id: 'u1', email: 'bo@demo.menagerai.dev', status: 'active' });
    const res = await request(makeApp()).post('/demo/login').type('form').send({ email: 'bo@demo.menagerai.dev', next: '/apps/pulse' });
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.setSessionCookie).toHaveBeenCalledTimes(1);
    expect(h.armReset).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/apps/pulse');
  });

  it('sanitizes an open-redirect next to /', async () => {
    h.usersFindOne.mockResolvedValueOnce({ _id: 'u1', email: 'bo@demo.menagerai.dev', status: 'active' });
    const res = await request(makeApp()).post('/demo/login').type('form').send({ email: 'bo@demo.menagerai.dev', next: '//evil.com' });
    expect(res.headers.location).toBe('/');
  });

  it('rejects an email that is not a defined persona (no session)', async () => {
    const res = await request(makeApp()).post('/demo/login').type('form').send({ email: 'intruder@demo.menagerai.dev' });
    expect(h.createSession).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('404s when demo mode is off (defense in depth)', async () => {
    h.cfg.demoMode = false;
    const res = await request(makeApp()).post('/demo/login').type('form').send({ email: 'bo@demo.menagerai.dev' });
    expect(res.status).toBe(404);
    expect(h.createSession).not.toHaveBeenCalled();
  });
});

describe('GET /demo/status', () => {
  it('returns the demo flag and reset epoch', async () => {
    const res = await request(makeApp()).get('/demo/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ demoMode: true, resetAt: null });
  });
});
