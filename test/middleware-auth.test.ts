import { describe, expect, it, vi } from 'vitest';

// middleware/auth imports db + sessions at module load; stub them (unused here).
vi.mock('../src/db', () => ({ col: {} }));
vi.mock('../src/sessions', () => ({ getSessionId: () => undefined, touchSession: async () => null, sessionIsRevoked: async () => false }));

import { requireAdmin, requireSession } from '../src/middleware/auth';

function mkReq(opts: { user?: unknown; headers?: Record<string, string>; url?: string }) {
  const headers = opts.headers || {};
  return {
    user: opts.user ?? null,
    originalUrl: opts.url || '/apps/demo',
    get(h: string) {
      return headers[h.toLowerCase()];
    },
  } as never;
}
function mkRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    location: undefined as string | undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(o: unknown) {
      this.body = o;
      return this;
    },
    send(s: unknown) {
      this.body = s;
      return this;
    },
    redirect(u: string) {
      this.location = u;
    },
  };
  return res;
}

describe('requireSession', () => {
  it('passes through an authenticated user', () => {
    const next = vi.fn();
    requireSession(mkReq({ user: { email: 'a@x' } }), mkRes() as never, next);
    expect(next).toHaveBeenCalled();
  });
  it('redirects a browser navigation to login with next', () => {
    const res = mkRes();
    requireSession(mkReq({ headers: { 'sec-fetch-mode': 'navigate' }, url: '/apps/demo' }), res as never, vi.fn());
    expect(res.location).toContain('/login?next=');
    expect(res.location).toContain(encodeURIComponent('/apps/demo'));
  });
  it('returns 401 JSON for an API request', () => {
    const res = mkRes();
    requireSession(mkReq({ headers: { accept: 'application/json' } }), res as never, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthenticated' });
  });
});

describe('requireAdmin', () => {
  it('passes through a system_admin', () => {
    const next = vi.fn();
    requireAdmin(mkReq({ user: { email: 'a@x', roles: ['system_admin'] } }), mkRes() as never, next);
    expect(next).toHaveBeenCalled();
  });
  it('rejects a signed-in non-admin with 403', () => {
    const res = mkRes();
    const next = vi.fn();
    requireAdmin(mkReq({ user: { email: 'a@x', roles: ['staff'] } }), res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
  it('sends an unauthenticated browser to login (delegates to requireSession)', () => {
    const res = mkRes();
    requireAdmin(mkReq({ headers: { 'sec-fetch-mode': 'navigate' } }), res as never, vi.fn());
    expect(res.location).toContain('/login');
  });
});
