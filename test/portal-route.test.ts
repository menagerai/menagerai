import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sessionsFind: vi.fn(),
  destroySession: vi.fn(),
  revokeSession: vi.fn(),
  audit: vi.fn(),
  clearSessionCookie: vi.fn(),
}));

vi.mock('../src/db', () => ({
  col: {
    sessions: { find: h.sessionsFind },
    apps: { find: () => ({ sort: () => ({ toArray: async () => [] }) }) },
  },
}));
vi.mock('../src/config', () => ({ config: { session: { cookieName: 'menagerai_session', secure: true } } }));
vi.mock('../src/audit', () => ({ audit: h.audit }));
vi.mock('../src/decide', () => ({ decide: vi.fn(async () => ({ allowed: false })) }));
vi.mock('../src/sessions', () => ({ clearSessionCookie: h.clearSessionCookie, destroySession: h.destroySession, revokeSession: h.revokeSession }));

import { portalRouter } from '../src/routes/portal';
import { i18n } from '../src/i18n'; // real — supplies res.locals.t for flash()

// Mount the portal router as a signed-in user with a known current session id.
function appAs(user: unknown, sessionId?: string) {
  const app = express();
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  app.use(i18n);
  app.use((req, _res, next) => {
    (req as { user?: unknown; sessionId?: string }).user = user;
    (req as { sessionId?: string }).sessionId = sessionId;
    next();
  });
  app.use(portalRouter);
  return app;
}

const me = { _id: 'me', email: 'me@example.com', roles: [] };

beforeEach(() => {
  h.sessionsFind.mockReset();
  h.destroySession.mockReset();
  h.revokeSession.mockReset();
  h.audit.mockReset();
  h.clearSessionCookie.mockReset();
});

describe('POST /profile/sessions/:id/revoke', () => {
  it('scopes the revoke to the requesting user (IDOR defense)', async () => {
    h.revokeSession.mockResolvedValue(false);
    await request(appAs(me, 'current')).post('/profile/sessions/someoneelse/revoke');
    expect(h.revokeSession).toHaveBeenCalledWith('someoneelse', 'me');
  });

  it('flashes a benign message and does not audit when nothing was revoked', async () => {
    h.revokeSession.mockResolvedValue(false);
    const res = await request(appAs(me, 'current')).post('/profile/sessions/ghost/revoke');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/profile');
    expect(res.headers.location).toContain('lvl=error');
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('revokes another (non-current) session by tombstoning it: audits and redirects to /profile', async () => {
    h.revokeSession.mockResolvedValue(true);
    const res = await request(appAs(me, 'current')).post('/profile/sessions/other/revoke');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/profile');
    expect(res.headers.location).toContain('lvl=success');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'session.revoked', target_id: 'other' }));
    expect(h.clearSessionCookie).not.toHaveBeenCalled();
  });

  it('revoking the current session deletes it, clears the cookie and bounces home', async () => {
    h.destroySession.mockResolvedValue(undefined);
    const res = await request(appAs(me, 'current')).post('/profile/sessions/current/revoke');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(h.destroySession).toHaveBeenCalledWith('current');
    expect(h.clearSessionCookie).toHaveBeenCalled();
  });
});
