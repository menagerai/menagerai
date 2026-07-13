import { Request, Router } from 'express';
import { col } from '../db';
import { decide } from '../decide';
import { getIdentityProvider } from '../idp';
import { ttlCache } from '../ttl-cache';

export const accessRouter = Router();

// Small cache so repeated checks for the same token don't hit Logto each time.
const TOKEN_TTL = 60_000;
const tokenCache = ttlCache<string, string>(TOKEN_TTL);

function bearer(req: Request): string | null {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function subjectFromToken(token: string): Promise<string | null> {
  const hit = tokenCache.get(token);
  if (hit) return hit;
  const info = await getIdentityProvider()?.userinfo(token);
  if (!info) return null;
  tokenCache.set(token, info.sub);
  return info.sub;
}

// Coarse, gate-level access check: may this subject reach the app at all? The
// ACP does not model in-app roles, so there is nothing finer to report than
// allow/deny — any finer authorization is the app's own concern.
async function checkOne(sub: string, appKey: string) {
  const user = await col.users.findOne({ logto_user_id: sub });
  const d = await decide(user, appKey);
  return { app: appKey, allowed: d.allowed };
}

// User-token mode: subject = the token's sub. See authorization-semantics §2.
accessRouter.post('/api/access/check', async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  const sub = await subjectFromToken(token);
  if (!sub) return res.status(401).json({ error: 'invalid_token' });
  const { app } = req.body || {};
  if (!app) return res.status(400).json({ error: 'app required' });
  const result = await checkOne(sub, app);
  res.json({ subject: sub, ...result });
});

accessRouter.post('/api/access/batch-check', async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  const sub = await subjectFromToken(token);
  if (!sub) return res.status(401).json({ error: 'invalid_token' });
  const apps: string[] = Array.isArray(req.body?.apps) ? req.body.apps : [];
  const results = await Promise.all(apps.map((a) => checkOne(sub, a)));
  res.json({ subject: sub, results });
});

// M2M resolve mode is not enabled in this milestone (no app uses it yet — the
// only integration is via the gateway). Implementing it requires
// verifying M2M tokens and a trusted-client allowlist; deferred deliberately.
accessRouter.post('/api/access/resolve', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', detail: 'M2M resolve is not enabled yet.' });
});
