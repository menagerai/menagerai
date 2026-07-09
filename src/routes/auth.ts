import { Router } from 'express';
import { config } from '../config';
import { col } from '../db';
import { audit } from '../audit';
import { generators, getIdentityProvider } from '../idp';
import { providerConfig } from '../idp/config';
import { markSetupComplete } from '../bootstrap';
import { clearSessionCookie, createSession, destroySession, getSessionId, setSessionCookie } from '../sessions';
import { originOf, safeReturnTo, syncedNameFromClaims } from '../util';

function origin(req: { get(name: string): string | undefined }): string {
  return originOf(req, config.portalHosts, config.baseUrl);
}

const TX_COOKIE = 'menagerai_oidc_tx';

export const authRouter = Router();

authRouter.get('/login', async (req, res) => {
  const idp = getIdentityProvider();
  if (!idp) {
    // No provider configured yet — send the operator through first-run setup.
    res.redirect('/setup');
    return;
  }
  try {
    const client = await idp.oidcClient();
    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = generators.state();
    const nonce = generators.nonce();
    const returnTo = safeReturnTo(req.query.next);
    const forceLogin = req.query.force === '1';
    // Stay on whatever (allowlisted) host the user is on.
    const redirect_uri = `${origin(req)}/callback`;

    res.cookie(TX_COOKIE, JSON.stringify({ code_verifier, state, nonce, returnTo, redirect_uri }), {
      httpOnly: true,
      secure: config.session.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });

    const url = client.authorizationUrl({
      redirect_uri,
      scope: providerConfig()?.scopes || 'openid profile email',
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      // A revoked-session redirect (force=1) forces the IdP to re-prompt instead of
      // silently re-authenticating from its SSO cookie.
      ...(forceLogin ? { prompt: 'login' } : {}),
    });
    res.redirect(url);
  } catch (err) {
    console.error('login error', err);
    res.status(500).send('Sign-in failed to start.');
  }
});

authRouter.get('/callback', async (req, res) => {
  const raw = req.cookies?.[TX_COOKIE];
  if (!raw) return res.redirect('/login');
  let tx: { code_verifier: string; state: string; nonce: string; returnTo: string; redirect_uri: string };
  try {
    tx = JSON.parse(raw);
  } catch {
    return res.redirect('/login');
  }
  res.clearCookie(TX_COOKIE, { path: '/' });

  try {
    const idp = getIdentityProvider();
    if (!idp) return res.redirect('/login');
    const client = await idp.oidcClient();
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(tx.redirect_uri, params, {
      code_verifier: tx.code_verifier,
      state: tx.state,
      nonce: tx.nonce,
    });
    const claims = tokenSet.claims();
    const sub = claims.sub;
    const email = String(claims.email || '').toLowerCase();
    if (!email) return res.status(403).send('Your Logto account has no email; cannot sign in.');

    // Authorization is ACP-owned: the user must already be provisioned + active.
    let user = await col.users.findOne({ logto_user_id: sub });
    if (!user) user = await col.users.findOne({ email });
    if (!user || user.status !== 'active') {
      return res.redirect('/no-access?reason=not_provisioned');
    }

    // Link the Logto subject on first sign-in if it was provisioned by email only.
    const sets: Record<string, unknown> = { last_login_at: new Date(), updated_at: new Date() };
    if (!user.logto_user_id) sets.logto_user_id = sub;
    // Pull a name change made in Logto back into the portal so the two stay synced.
    const syncedName = syncedNameFromClaims(user.name, claims.name);
    if (syncedName !== undefined) {
      sets.name = syncedName;
      sets.last_synced_to_logto_at = new Date();
    }
    await col.users.updateOne({ _id: user._id }, { $set: sets });
    user.logto_user_id = user.logto_user_id || sub;
    // A system_admin signing in completes first-run setup (flip the guard now).
    if (user.roles?.includes('system_admin')) markSetupComplete();
    if (syncedName !== undefined) {
      await audit({ actor_user_id: user._id, action: 'user.name_synced_from_logto', target_type: 'user', target_id: String(user._id), before: { name: user.name }, after: { name: syncedName } });
      user.name = syncedName;
    }

    const sid = await createSession(user, { ip: req.ip, ua: req.get('user-agent') });
    setSessionCookie(res, sid);
    await audit({ actor_user_id: user._id, action: 'login', target_type: 'user', target_id: String(user._id) });
    res.redirect(safeReturnTo(tx.returnTo));
  } catch (err) {
    console.error('callback error', err);
    res.status(400).send('Sign-in could not be completed. Please try again.');
  }
});

authRouter.get('/logout', async (req, res) => {
  const sid = getSessionId(req);
  if (sid) await destroySession(sid);
  clearSessionCookie(res);
  // Clear the IdP SSO session too, else the next login silently re-establishes.
  const idp = getIdentityProvider();
  if (idp) {
    try {
      const client = await idp.oidcClient();
      return res.redirect(client.endSessionUrl({ post_logout_redirect_uri: `${origin(req)}/` }));
    } catch (err) {
      console.error('logout endSession error', err);
    }
  }
  res.redirect('/');
});
