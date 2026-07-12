import { Router } from 'express';
import { config } from '../config';
import { audit } from '../audit';
import { col } from '../db';
import { createSession, clearSessionCookie, destroySession, getSessionId, setSessionCookie } from '../sessions';
import { safeReturnTo } from '../util';
import { DEMO_PERSONAS, seedDemo } from './seed';
import { armReset, getResetAt } from './reset';

// The DEMO_MODE replacement for the OIDC auth router. Mounted at the SAME paths
// (/login, /logout) as the real authRouter so every existing redirect — the
// gateway 302, requireSession — keeps working without change. Sign-in is a
// "sign in as <persona>" picker: no credentials, no IdP.

export const demoAuthRouter = Router();

// Constant, code-defined allowlist. NOT a DB lookup by arbitrary input: visitors
// can create users via the admin UI, and those must never become sign-in targets.
const PERSONA_EMAILS = new Set(DEMO_PERSONAS.map((p) => p.email));

demoAuthRouter.get('/login', (req, res) => {
  res.render('demo-login', {
    user: null,
    isAdmin: false,
    personas: DEMO_PERSONAS,
    next: safeReturnTo(req.query.next),
  });
});

demoAuthRouter.post('/demo/login', async (req, res) => {
  // Defense in depth: the router is only mounted in demo mode, but guard the
  // session-minting endpoint independently too.
  if (!config.demoMode) return res.status(404).send('Not found');

  const email = String(req.body?.email || '').toLowerCase();
  if (!PERSONA_EMAILS.has(email)) return res.redirect('/login');

  // Self-heal: if the persona row was deleted mid-window (e.g. the admin persona
  // deleted it via the UI), reseed once and retry before giving up.
  let user = await col.users.findOne({ email });
  if (!user || user.status !== 'active') {
    await seedDemo();
    user = await col.users.findOne({ email });
  }
  if (!user || user.status !== 'active') return res.redirect('/login');

  const sid = await createSession(user, { ip: req.ip, ua: req.get('user-agent') });
  setSessionCookie(res, sid);
  await col.users.updateOne({ _id: user._id }, { $set: { last_login_at: new Date(), updated_at: new Date() } });
  await audit({ actor_user_id: user._id, action: 'login', target_type: 'user', target_id: String(user._id) });

  // Arm the auto-reset on the first sign-in after a reset (no-op if already armed).
  armReset();

  res.redirect(safeReturnTo(req.body?.next));
});

demoAuthRouter.get('/logout', async (req, res) => {
  const sid = getSessionId(req);
  if (sid) await destroySession(sid);
  clearSessionCookie(res);
  res.redirect('/login');
});

// Unauthenticated status endpoint: lets the countdown be read by curl or by a mock
// app that wants to show the same timer. Always available in demo mode.
demoAuthRouter.get('/demo/status', (_req, res) => {
  res.json({ demoMode: true, resetAt: getResetAt() });
});
