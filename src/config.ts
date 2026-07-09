import dotenv from 'dotenv';
import { parseHostList } from './util';

dotenv.config();

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

// The set of hostnames this single portal answers on (interchangeable aliases),
// used to validate the request Host before building redirects (host-injection
// defense). Sourced from — and auto-tracking — the deployment's own domains:
//   - PORTAL_BASE_URL        (canonical, always included)
//   - PORTAL_HOSTS           (explicit comma list, optional)
//   - COOLIFY_FQDN / _URL    (the domains set on the Coolify service)
// All are operator/platform-set (not request-controlled), so safe to trust.
function portalHosts(): string[] {
  return parseHostList(
    opt('PORTAL_BASE_URL', 'http://localhost:3000'),
    opt('PORTAL_HOSTS'),
    process.env.COOLIFY_FQDN,
    process.env.COOLIFY_URL,
  );
}

// The allow-list an app's "default URL" may be chosen from (comma-separated,
// no scheme) — e.g. DEFAULT_BASE_URLS=app1.example.com,app2.example.com.
// Unrelated to portalHosts(): these are *other* domains an app can be launched
// on, not hosts this portal itself answers on.
function defaultBaseUrls(): string[] {
  return parseHostList(opt('DEFAULT_BASE_URLS'));
}

export const config = {
  // Product/brand name shown in the UI, titles, and the admin API spec. Sourced
  // from an env var so a white-label operator *can* override it, but it is left
  // out of .env.example on purpose: unset, it stays "Menagerai".
  brandName: opt('BRAND_NAME', 'Menagerai'),
  port: int('PORT', 3000),
  // /gateway/verify is also served on this dedicated internal-only port. No FQDN
  // routes to it (Coolify publishes only `port`), so it is reachable solely from
  // inside the Docker network (Traefik → menagerai:3001). See DEPLOY.md §4.
  gatewayPort: int('GATEWAY_PORT', 3001),
  // Whether the PUBLIC app also mounts /gateway/verify. Defaults true so an
  // additive deploy keeps 3000 serving while the middleware still targets it;
  // set GATEWAY_PUBLIC=false for the secure end-state (verify on 3001 only).
  gatewayPublic: opt('GATEWAY_PUBLIC', 'true') !== 'false',
  // No trailing slash.
  baseUrl: opt('PORTAL_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  portalHosts: portalHosts(),
  defaultBaseUrls: defaultBaseUrls(),

  // Data store. SQLite is the primary/default backend: a file at SQLITE_PATH
  // (put it on a persistent volume). Setting MONGODB_CONN_STR switches to the
  // MongoDB backend instead — the pluggable secondary. See src/store/.
  sqlitePath: opt('SQLITE_PATH', './data/menagerai.db'),
  mongoUri: opt('MONGODB_CONN_STR'),
  mongoDb: opt('MONGODB_DB', 'menagerai'),

  session: {
    cookieName: opt('SESSION_COOKIE_NAME', 'menagerai_session'),
    idleSeconds: int('SESSION_IDLE_SECONDS', 8 * 60 * 60),
    absoluteSeconds: int('SESSION_ABSOLUTE_SECONDS', 7 * 24 * 60 * 60),
    secure: opt('COOKIE_SECURE', 'true') !== 'false',
  },

  // Identity-provider config is NOT here — it is resolved at runtime (env or the
  // settings store written by first-run setup) in src/idp/config.ts, so it can be
  // configured in the UI without a redeploy.

  superadminEmail: opt('SUPERADMIN_EMAIL', 'admin@example.com').toLowerCase(),
  decisionCacheTtlMs: int('DECISION_CACHE_TTL_MS', 30_000),
  // App-registry cache on the verify hot path — same TTL semantics as the
  // decision cache (evicted proactively on app edits via evictAll()).
  appCacheTtlMs: int('APP_CACHE_TTL_MS', 30_000),
  // Session→user micro-cache in loadUser. Deliberately short: it only saves the
  // per-request users.findOne, and is evicted instantly on any user change
  // (evictUser); the TTL is just the fallback bound on staleness.
  userCacheTtlMs: int('USER_CACHE_TTL_MS', 5_000),
  // Mongo connection pool sizing. Kept warm so the verify path never pays a
  // cold-connection cost under load.
  mongoMaxPoolSize: int('MONGO_MAX_POOL_SIZE', 50),
  mongoMinPoolSize: int('MONGO_MIN_POOL_SIZE', 5),

  // Usage statistics. The business-day boundary is computed in this IANA zone.
  // Defaults to the container's own TZ env if set (so the standard Docker/OS
  // timezone flows through without a second var), else UTC. Any IANA zone works;
  // validated below at boot.
  timezone: opt('TIMEZONE', process.env.TZ || 'UTC'),
  usageTopLimit: int('USAGE_TOP_LIMIT', 10),
  usageHeatmapDays: int('USAGE_HEATMAP_DAYS', 365),
  // How many cards each dashboard list (Top apps / Top users) shows. Purely
  // additive with a sensible default — no deploy-side change required to ship.
  dashboardTopLimit: int('DASHBOARD_TOP_LIMIT', 6),
};

// Fail fast on a bad TIMEZONE rather than throwing later on every usage write.
try {
  new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
} catch {
  throw new Error(`Invalid TIMEZONE: ${config.timezone} (must be an IANA zone, e.g. UTC or America/New_York)`);
}

export function redirectUri(): string {
  return `${config.baseUrl}/callback`;
}
