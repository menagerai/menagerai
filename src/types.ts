import { ObjectId } from 'mongodb';

export type UserStatus = 'pending' | 'active' | 'disabled';
export type Effect = 'allow' | 'deny';

export interface AppOverride {
  app: string; // app key
  effect: Effect; // allow = one-off grant; deny = per-user kill switch
  reason?: string;
  created_by?: string;
  created_at: Date;
}

export interface User {
  _id?: ObjectId;
  logto_user_id?: string | null;
  email: string; // lowercased, unique
  name?: string;
  department?: string;
  status: UserStatus;
  source: 'manual' | 'import' | 'api';
  roles: string[]; // organizational role keys
  app_overrides: AppOverride[];
  created_by?: string;
  created_at: Date;
  updated_at: Date;
  last_login_at?: Date | null;
  last_synced_to_logto_at?: Date | null;
}

export interface RoleGrant {
  app: string; // app key — allow-only: holding the role grants access to the app
}

export interface Role {
  _id?: ObjectId;
  key: string; // unique, immutable
  name: string;
  description?: string;
  grants: RoleGrant[];
  created_at: Date;
  updated_at: Date;
}

export interface PublicPath {
  method: string; // "*" or an HTTP method
  pattern: string; // app-relative glob, e.g. /api/public/**
}

export type AuthMode = 'oidc' | 'proxy' | 'sdk' | 'legacy';
export type AppStatus = 'active' | 'disabled' | 'planned';

export interface AppDoc {
  _id?: ObjectId;
  key: string; // unique, immutable — also the /apps/<key> path segment
  name: string;
  base_path?: string;
  repo_url?: string;
  // One of the operator-configured DEFAULT_BASE_URLS, or '' for unset. When set,
  // the launcher links to `https://${default_base_url}${base_path}` instead of
  // the portal-relative path, so the app opens on its own domain.
  default_base_url?: string;
  auth_mode: AuthMode;
  status: AppStatus;
  description?: string;
  public_paths: PublicPath[];
  proxy_secret: string;
  created_at: Date;
  updated_at: Date;
}

export interface EmailAllowRule {
  _id?: ObjectId;
  type: 'exact' | 'domain';
  pattern: string;
  status: 'active' | 'disabled';
  description?: string;
  created_by?: string;
  created_at: Date;
}

// A self-managed, admin-scoped API key. The plaintext secret is shown exactly
// once at creation and never stored — only its sha256 hash is persisted, plus a
// non-secret prefix and last-4 for the masked display in the list. A key inherits
// the full admin power of its owner at call time (re-checked on every request),
// so revoking the owner's role or disabling the account also disables the key.
export interface ApiKey {
  _id?: ObjectId;
  name: string; // user-supplied label
  user_id: ObjectId; // owner — the admin who created it; keys are listed per-owner
  prefix: string; // non-secret, e.g. "dvk_Ab12Cd" — shown in the masked display
  last4: string; // last 4 chars of the secret — shown in the masked display
  token_hash: string; // sha256(secret) hex — the ONLY stored form of the secret
  created_at: Date;
  last_used_at?: Date | null;
  revoked_at?: Date | null; // soft revoke: kept for the audit trail, excluded from auth
}

export interface SessionDoc {
  _id: string; // opaque session id (also the cookie value)
  user_id: ObjectId;
  email: string;
  logto_sub?: string;
  created_at: Date;
  expires_at: Date; // sliding idle expiry (TTL index)
  absolute_expiry: Date; // hard cap
  // Best-effort device fingerprint for the self-service session list. Captured at
  // login and refreshed (throttled) on activity; the IP is the latest client IP
  // seen across the portal and any linked app (X-Forwarded-For, trust proxy).
  ip?: string;
  user_agent?: string; // raw UA, truncated; rendered via describeUserAgent()
  last_seen_at?: Date;
  // A revoked session is kept as a short-lived tombstone so a browser that still
  // presents the old cookie can be forced through an interactive IdP login instead
  // of silently minting a fresh ACP session from its existing SSO cookie.
  revoked_at?: Date;
}

export interface AuditLog {
  _id?: ObjectId;
  actor_user_id?: ObjectId | string | null;
  action: string;
  target_type?: string;
  target_id?: string;
  before?: unknown;
  after?: unknown;
  // Channel the action came through: 'ui' (a logged-in admin session) or 'api'
  // (a programmatic call with an API key). When 'api', the key that authorized it
  // is recorded too, so API activity is fully traceable in the audit log.
  via?: 'ui' | 'api';
  api_key_id?: string;
  api_key_name?: string;
  created_at: Date;
}

// One row per (user, app, business-day) — the grain for DAU stats and the
// activity heatmap. The first successful gateway access on a given day inserts
// the row; further hits the same day only refresh last_at.
export interface UsageDaily {
  _id?: ObjectId;
  user_id: ObjectId;
  app_key: string;
  day: string; // 'YYYY-MM-DD' in the configured TIMEZONE
  first_at: Date;
  last_at: Date;
}

// Access is binary at this layer: the portal only performs coarse,
// gate-level access control (may this user reach the app at all). The ACP does
// not model in-app roles; any finer-grained authorization is the app's own
// responsibility, decided inside the app from the forwarded user identity.
export interface Decision {
  allowed: boolean;
  reason: 'allow_user' | 'allow_role' | 'deny_user' | 'no_grant' | 'inactive' | 'unknown_app' | 'no_user';
}
