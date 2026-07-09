import { Request, Response, Router } from 'express';
import { config } from '../config';
import { appCached, decideCached } from '../decide';
import { isNavigation, matchesPublic, normalizePath, parseAppPath } from '../gateway-logic';
import { recordUsage } from '../usage';
import { extractHost, originOf } from '../util';
import { AppDoc } from '../types';

function originalUri(req: Request): string {
  return req.get('x-forwarded-uri') || req.originalUrl || '/';
}

// Where a gateway redirect (login / no-access) should land. Prefer the app's own
// configured default host when set AND allowlisted (DEFAULT_BASE_URLS), so an
// /apps/<key> flow stays on that app's domain instead of bouncing to the canonical
// portal host. Otherwise fall back to the request host allowlist / canonical base
// URL (host-injection safe).
function redirectOriginFor(req: Request, app: AppDoc): string {
  const defaultHost = extractHost(app.default_base_url || '');
  if (defaultHost && config.defaultBaseUrls.includes(defaultHost)) {
    return `https://${defaultHost}`;
  }
  return originOf(req, config.portalHosts, config.baseUrl);
}

function wantsHtml(req: Request): boolean {
  return isNavigation(req.get('sec-fetch-mode'), req.get('accept'));
}

// Opt-in per-request decision logging (set GATEWAY_LOG=1). Off by default to
// avoid noise/PII; invaluable for diagnosing redirect loops and 401/403s since
// every verify otherwise returns a quiet 200/302 that nothing records.
const GATEWAY_LOG = process.env.GATEWAY_LOG === '1';
function glog(req: Request, method: string, uri: string, outcome: string): void {
  if (!GATEWAY_LOG) return;
  const who = req.user ? req.user.email : 'anon';
  const nav = wantsHtml(req) ? 'nav' : 'api';
  console.log(`[gateway] ${method} ${uri} (${nav}) user=${who} -> ${outcome}`);
}

export const gatewayRouter = Router();

// Traefik ForwardAuth target. See design/deployment-and-gateway.md §/gateway/verify.
gatewayRouter.all('/gateway/verify', async (req: Request, res: Response) => {
  const fwdUri = originalUri(req);
  const method = (req.get('x-forwarded-method') || req.method || 'GET').toUpperCase();

  const parsed = parseAppPath(normalizePath(fwdUri));
  if (!parsed) {
    glog(req, method, fwdUri, '404 not-a-app-path');
    return res.status(404).send('Unknown path.');
  }
  const { appKey, relPath } = parsed;

  const app: AppDoc | null = await appCached(appKey);
  if (!app || app.status !== 'active') {
    glog(req, method, fwdUri, `404 unknown-app(${appKey})`);
    return res.status(404).send('Unknown app.');
  }

  // Public paths: anonymous pass-through, no identity headers.
  if (matchesPublic(app.public_paths, method, relPath)) {
    glog(req, method, fwdUri, '200 public');
    return res.status(200).end();
  }

  // Redirect app entrypoints to the app's configured default host when present and
  // allowlisted; otherwise the request host (X-Forwarded-Host) / canonical base URL.
  const portalOrigin = redirectOriginFor(req, app);

  // Protected: require an authenticated, active user.
  if (!req.user) {
    if (wantsHtml(req)) {
      glog(req, method, fwdUri, `302 login (no session) -> ${portalOrigin}/login`);
      const force = req.sessionRevoked ? '&force=1' : '';
      return res.redirect(`${portalOrigin}/login?next=${encodeURIComponent(fwdUri)}${force}`);
    }
    glog(req, method, fwdUri, '401 unauthenticated (no session)');
    return res.status(401).json({ error: 'unauthenticated', login_url: '/login' });
  }

  const decision = await decideCached(req.user, appKey);
  if (!decision.allowed) {
    if (wantsHtml(req)) {
      glog(req, method, fwdUri, `302 no-access (${decision.reason})`);
      return res.redirect(`${portalOrigin}/no-access?app=${encodeURIComponent(appKey)}`);
    }
    glog(req, method, fwdUri, `403 forbidden (${decision.reason})`);
    return res.status(403).json({ error: 'forbidden', app: appKey });
  }

  // The gateway only does coarse, gate-level access control. A cleared user
  // gets the identity headers; the app decides any finer-grained authorization
  // itself from these (chiefly the email) — the ACP forwards no app-specific role.
  res.set('X-Menagerai-User-Email', req.user.email);
  res.set('X-Menagerai-User-ID', String(req.user._id));
  res.set('X-Menagerai-Roles', (req.user.roles || []).join(','));
  res.set('X-Menagerai-Proxy-Secret', app.proxy_secret);
  // Record a usage day for this (user, app). Fire-and-forget: recordUsage never
  // rejects, so it must not add latency to the ForwardAuth response.
  recordUsage(String(req.user._id), appKey);
  glog(req, method, fwdUri, `200 allow (${decision.reason})`);
  res.status(200).end();
});
