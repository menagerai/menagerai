import { ObjectId } from 'mongodb';
import { col } from './db';
import { config } from './config';
import { AppDoc, Decision, Role, User } from './types';
import { ttlCache } from './ttl-cache';

/**
 * The single authorization decision — PURE and total. All callers funnel here.
 * Access is BINARY: this is only coarse, gate-level control (may the user reach
 * the app at all). Any finer-grained authorization is the app's own concern,
 * decided inside the app from the forwarded identity. Precedence
 * (see design/authorization-semantics.md §1):
 *   1. status gate  2. user deny  3. user allow  4. role allow  5. default deny
 *
 * `app` is the resolved app doc (or null = unknown); `roleDocs` are the user's
 * organizational roles. No IO, so it is exhaustively unit-testable.
 */
export function decideFrom(user: User | null, app: AppDoc | null, roleDocs: Role[]): Decision {
  if (!user) return { allowed: false, reason: 'no_user' };
  if (user.status !== 'active') return { allowed: false, reason: 'inactive' };
  if (!app || app.status !== 'active') return { allowed: false, reason: 'unknown_app' };

  const overrides = (user.app_overrides || []).filter((o) => o.app === app.key);

  // 2. user-level deny — kill switch, beats everything below
  if (overrides.some((o) => o.effect === 'deny')) {
    return { allowed: false, reason: 'deny_user' };
  }

  // 3. user-level allow — one-off escape hatch
  if (overrides.some((o) => o.effect === 'allow')) {
    return { allowed: true, reason: 'allow_user' };
  }

  // 4. role-level allow — the normal path (grants are allow-only)
  for (const r of roleDocs) {
    if ((r.grants || []).some((g) => g.app === app.key)) {
      return { allowed: true, reason: 'allow_role' };
    }
  }

  // 5. default deny
  return { allowed: false, reason: 'no_grant' };
}

// IO wrapper: fetch the app + the user's roles, then delegate to decideFrom.
// The two lookups are independent, so run them in parallel; the app doc comes
// from the shared registry cache (see appCached) so a decision-cache miss does
// not re-hit Mongo for an app the verify handler already resolved.
export async function decide(user: User | null, appKey: string): Promise<Decision> {
  if (!user || user.status !== 'active') return decideFrom(user, null, []);
  const [app, roleDocs] = await Promise.all([
    appCached(appKey),
    col.roles.find({ key: { $in: user.roles || [] } }).toArray(),
  ]);
  return decideFrom(user, app, roleDocs);
}

// ---- App-registry cache for the verify hot path ----
// Every verify resolves the app doc (status, public_paths, proxy_secret). Cache
// it briefly so the hottest path in the system makes at most one apps.findOne
// per app per TTL instead of one (or two) per request. Evicted wholesale on any
// app/role edit via evictAll().
const appCache = ttlCache<string, AppDoc | null>(config.appCacheTtlMs);

export async function appCached(appKey: string): Promise<AppDoc | null> {
  const hit = appCache.get(appKey);
  if (hit !== undefined) return hit;
  const app = await col.apps.findOne({ key: appKey });
  appCache.set(appKey, app);
  return app;
}

// ---- Session→user micro-cache for loadUser ----
// loadUser must always read the session (that IS the auth check), but the user
// doc it resolves changes rarely. Cache it for a short TTL keyed by user id, so
// back-to-back requests from the same user skip the users.findOne. Evicted
// instantly on any user change via evictUser().
const userCache = ttlCache<string, User | null>(config.userCacheTtlMs);

export async function userCached(userId: ObjectId): Promise<User | null> {
  const key = String(userId);
  const hit = userCache.get(key);
  if (hit !== undefined) return hit;
  const user = await col.users.findOne({ _id: userId });
  userCache.set(key, user);
  return user;
}

// ---- Short-lived in-process decision cache for the gateway hot path ----
const cache = ttlCache<string, Decision>(config.decisionCacheTtlMs);

function cacheKey(userId: string, appKey: string): string {
  return `${userId}::${appKey}`;
}

// Keyed by user id (the decision depends on user + app, not the specific
// session), so eviction on disable/grant-change is exact.
export async function decideCached(user: User, appKey: string): Promise<Decision> {
  const key = cacheKey(String(user._id), appKey);
  const hit = cache.get(key);
  if (hit) return hit;
  const decision = await decide(user, appKey);
  cache.set(key, decision);
  return decision;
}

// Proactive eviction on offboarding / grant changes so it is instant rather
// than waiting out the TTL. Also drops the user's cached doc so a status/role
// change takes effect on the very next request.
export function evictUser(userId: string): void {
  const prefix = `${userId}::`;
  cache.deleteWhere((key) => key.startsWith(prefix));
  userCache.delete(userId);
}

// Called on any app or role edit. Clears decisions (they depend on both) and the
// app-registry cache so an app status/secret/public-path change is picked up
// immediately rather than after the TTL.
export function evictAll(): void {
  cache.clear();
  appCache.clear();
}
