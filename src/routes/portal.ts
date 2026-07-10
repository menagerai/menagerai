import { Router } from 'express';
import { col } from '../db';
import { config } from '../config';
import { audit } from '../audit';
import { decide } from '../decide';
import { flash } from '../flash';
import { LANG_COOKIE, pickLang } from '../i18n';
import { requireSession } from '../middleware/auth';
import { clearSessionCookie, destroySession, revokeSession } from '../sessions';
import { describeUserAgent } from '../util';

export const portalRouter = Router();

// Language switch (top bar). Sets the locale cookie and returns to the page the
// user was on (same-site path only). No auth — must work on the no-access page.
portalRouter.get('/set-lang', (req, res) => {
  const lang = pickLang(req.query.lang);
  res.cookie(LANG_COOKIE, lang, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.secure,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  let back = '/';
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.pathname.startsWith('/')) back = u.pathname + u.search;
    } catch {
      /* ignore malformed referer */
    }
  }
  res.redirect(back);
});

// App launcher — shows only the apps the signed-in user can access.
portalRouter.get('/', requireSession, async (req, res) => {
  const user = req.user!;
  const apps = await col.apps.find({ status: 'active' }).sort({ name: 1 }).toArray();
  const accessible: { key: string; name: string; description: string; url: string }[] = [];
  for (const app of apps) {
    const d = await decide(user, app.key);
    if (d.allowed) {
      accessible.push({
        key: app.key,
        name: app.name,
        description: app.description || '',
        // Relative so the link stays on whichever portal host the user is on —
        // unless the app has a configured default_base_url, in which case the
        // full absolute URL on that domain is generated instead.
        url: app.default_base_url
          ? `https://${app.default_base_url}${app.base_path || `/apps/${app.key}`}`
          : `/apps/${app.key}`,
      });
    }
  }
  res.render('launcher', {
    user,
    apps: accessible,
    isAdmin: user.roles?.includes('system_admin'),
  });
});

// User profile — self-service active-session management. Lists the signed-in
// user's live sessions (latest IP, parsed device, last active) and lets them
// revoke any one of them. Revoking deletes the session doc, so that device is
// bounced to login on its next portal OR linked-app request (both run loadUser →
// touchSession, which returns null for a missing doc) — leaving other sessions up.
portalRouter.get('/profile', requireSession, async (req, res) => {
  const user = req.user!;
  const now = new Date();
  const docs = await col.sessions
    .find({ user_id: user._id, expires_at: { $gt: now }, absolute_expiry: { $gt: now }, revoked_at: { $exists: false } })
    .toArray();
  const sessions = docs
    .map((s) => ({
      id: s._id,
      ip: s.ip || '',
      device: describeUserAgent(s.user_agent),
      userAgent: s.user_agent || '',
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at || s.created_at,
      isCurrent: s._id === req.sessionId,
    }))
    // Current device first, then most-recently-active.
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  res.render('profile', {
    user,
    isAdmin: user.roles?.includes('system_admin'),
    sessions,
  });
});

// Revoke one of the signed-in user's sessions. Scoped by user_id so a user can
// only ever end their OWN session (the opaque _id is unguessable, but scoping is
// defense-in-depth against IDOR). The id is an opaque base64url token, not an
// ObjectId — compare as a plain string.
portalRouter.post('/profile/sessions/:id/revoke', requireSession, async (req, res) => {
  const user = req.user!;
  const id = String(req.params.id);
  // Revoking your CURRENT session logs you out here, so just delete it (the cookie
  // is cleared below). Other sessions are tombstoned so the other browser is forced
  // through an interactive login instead of silently re-authenticating via SSO.
  const deleted = id === req.sessionId ? (await destroySession(id), true) : await revokeSession(id, user._id!);
  if (!deleted) {
    // Don't distinguish "not yours" from "already gone" — avoids an enumeration
    // oracle and is the same outcome to the user either way.
    return flash(res, '/profile', 'flash.sessionNotFound', undefined, 'error');
  }
  await audit({ actor_user_id: user._id, action: 'session.revoked', target_type: 'session', target_id: id });
  // Revoking the current session is normally routed to /logout by the UI, but
  // handle it defensively: clear the cookie and bounce home (a /profile redirect
  // would just hit requireSession and drop the toast, so don't promise one).
  if (id === req.sessionId) {
    clearSessionCookie(res);
    return res.redirect('/');
  }
  flash(res, '/profile', 'flash.sessionRevoked', undefined, 'success');
});

// Actionable no-access page (denied app, or not-provisioned after Logto login).
portalRouter.get('/no-access', (req, res) => {
  res.status(403).render('no-access', {
    user: req.user || null,
    app: typeof req.query.app === 'string' ? req.query.app : null,
    reason: typeof req.query.reason === 'string' ? req.query.reason : null,
  });
});

portalRouter.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
