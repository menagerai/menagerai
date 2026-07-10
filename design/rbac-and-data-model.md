# RBAC and Data Model

## Role model

Use a two-level model.

### Organizational / platform roles

These describe the user inside your organization.

Examples:

```text
employee
finance_staff
sales_staff
procurement_staff
department_manager
executive
external_vendor
system_admin
```

### Access is binary — Menagerai does not model app roles

Menagerai performs only coarse, **gate-level** access control: a binary allow/deny
per `(user, app)`. It does **not** model in-app roles or permissions. Access to
reach an app comes from an organizational role grant or a per-user override; once a
user is allowed, the gateway forwards their identity and organizational roles to the
app, and the app decides any finer-grained authorization itself.

```text
User → OrganizationalRole → (grants access to) App
User → DirectAppOverride → (allow | deny) App
```

Support both inherited grants and direct overrides:

- Role-derived access: `finance_staff` is granted access to the finance app.
- Direct allow override: Alice is granted access to one app without a role.
- Direct deny override: Bob belongs to a broad role but is excluded from a sensitive app.

> **Apps MAY have their own internal roles** (viewer, approver, admin, …) and
> permission schemes — but those live inside the app, keyed off the forwarded
> identity (chiefly email) and organizational roles. Menagerai neither stores nor
> forwards a per-app role. See
> [`authorization-semantics.md`](authorization-semantics.md).

## Suggested database schema

The Menagerai store is **backend-pluggable** — SQLite by default, MongoDB
optionally (see [`open-considerations.md`](open-considerations.md)). The tables
below are the *logical* model — they name the entities and relationships clearly.
The physical realization (the same collections and fields, backed by either
SQLite JSON-document tables or MongoDB collections, with embedding) is in
[Physical model: collections](#physical-model-collections) at the end of this
document.

### users

```text
users
- id
- logto_user_id
- email
- name
- department
- status: pending | active | disabled
- source: manual | import | api
- created_by
- created_at
- updated_at
- last_login_at
- last_synced_to_logto_at
```

### email_allow_rules

```text
email_allow_rules
- id
- type: domain | exact | regex
- pattern
- status: active | disabled
- description
- created_by
- created_at
```

Examples:

```text
@example.com
consultant@example.com
.*@example\.(com|net)
```

### organizational_roles

```text
organizational_roles
- id
- key
- name
- description
- created_at
- updated_at
```

### user_roles

```text
user_roles
- user_id
- role_id
- created_by
- created_at
```

### apps

```text
apps
- id
- key
- name
- url
- repo_url
- auth_mode: oidc | proxy | sdk | legacy
- status: active | disabled | planned
- description
- created_at
- updated_at
```

Example app declaration:

```json
{
  "id": "purchase-approval",
  "name": "Purchase Approval System",
  "url": "https://app.example.com",
  "auth_integration": "oidc_jwt"
}
```

### role_app_grants

```text
role_app_grants
- organizational_role_id
- app_id
- effect: allow | deny
- created_by
- created_at
```

A grant means "holding this role lets you reach this app." It carries no app
role.

### user_app_overrides

```text
user_app_overrides
- user_id
- app_id
- effect: allow | deny
- reason
- created_by
- created_at
```

Explicit deny is useful when a user belongs to a broad department role but must be excluded from one app.

The precedence among role grants and per-user overrides — and how multiple
matching rows collapse to a single decision — is defined in
[`authorization-semantics.md`](authorization-semantics.md) §1. In the current
policy:

- `role_app_grants` are **allow-only** (the `effect` column exists for forward
  compatibility but `deny` is unused). Access comes only from roles.
- `user_app_overrides.effect = deny` is the per-user kill switch and beats any
  role grant.
- `user_app_overrides.effect = allow` is a rare one-off grant for a single person
  to a single app, used when creating a whole role would be overkill.
- Anything not granted is denied by default.

### App roles and permissions — out of scope

Menagerai intentionally does **not** model app roles or permissions. There are no
`app_roles`, `permissions`, or `app_role_permissions` tables: access is binary
(reach-the-app or not), and any in-app role/permission scheme belongs to the app
itself. See [`authorization-semantics.md`](authorization-semantics.md).

### audit_logs

```text
audit_logs
- id
- actor_user_id
- action
- target_type
- target_id
- before_json
- after_json
- logto_request_id
- created_at
```

Audit logs are mandatory for organizational trust.

### logto_sync_events

```text
logto_sync_events
- id
- user_id
- operation
- status: pending | success | failed
- request_json
- response_json
- error_message
- created_at
```

Use sync events to avoid silent drift between Menagerai and Logto.

## Minimum admin portal features

### User management

- Search users by email/name.
- See status, department, roles, and assigned apps.
- Create/invite user.
- Disable/offboard user.
- View last login and sync status.

### Role management

- Create organizational role.
- Assign users to role.
- Assign role grants to apps (binary reach-the-app access).

### App management

- Register app.
- Configure URL and repo URL.
- Configure public paths and the proxy secret.
- Configure auth integration mode.
- See who has access.

### Access preview

Important admin views:

```text
What can Alice access?
- Purchase Approval: Allowed
- Finance Reconciliation: Allowed
- Sales Dashboard: No access
```

```text
Who can access Purchase Approval?
- Alice Zhang: Allowed
- Bob Li: Allowed
- Chen Wang: Allowed
```

These views prevent permission drift and make access review practical.

## Physical model: collections

The Menagerai store is backend-pluggable: the same logical tables are realized as
the same collections and fields either way — as SQLite JSON-document tables
(the default) or as MongoDB collections. In both backends a document is the unit
of storage; **embed** data that is owned by one parent, **reference** data that is
shared. On SQLite each collection is a table `(id TEXT PRIMARY KEY, doc TEXT)`
holding the document as JSON, with queried/indexed fields exposed as generated
columns so real indexes back them; on MongoDB each is a native collection. The
document shapes below are identical across backends.

```text
- A user OWNS its per-user overrides         → embedded in the user doc
- A user REFERENCES organizational roles     → array of role keys
- A role OWNS its app grants                 → embedded in the role doc (allow-only)
- email_allow_rules / audit_logs / sessions /
  usage_daily                                → standalone collections
  (audit_logs is append-only; usage_daily is
   one row per user×app×active-day)
```

> **Implementation status.** Collections actually created by the store
> (`src/store/`): `users`, `roles`, `apps`, `email_allow_rules`, `sessions`, `audit_logs`,
> `usage_daily`. `logto_sync_events` from the logical model is **not**
> implemented — Logto provisioning/offboarding uses the Management API directly
> plus `users.last_synced_to_logto_at`, rather than an events queue.

### `users`

```json
{
  "_id": "...",
  "logto_user_id": "logto_user_123",
  "email": "alice@example.com",
  "name": "Alice Zhang",
  "department": "Finance",
  "status": "active",
  "source": "manual",
  "roles": ["finance_staff", "employee"],
  "app_overrides": [
    { "app": "purchase-approval", "effect": "allow",
      "reason": "covering for manager", "created_by": "...", "created_at": "..." },
    { "app": "exec-dashboard", "effect": "deny",
      "reason": "not authorized", "created_by": "...", "created_at": "..." }
  ],
  "created_by": "...", "created_at": "...", "updated_at": "...",
  "last_login_at": "...", "last_synced_to_logto_at": "..."
}
```

### `roles`  (organizational roles)

```json
{
  "_id": "...",
  "key": "finance_staff",
  "name": "Finance Staff",
  "description": "...",
  "grants": [
    { "app": "finance-reconciliation" },
    { "app": "sales-dashboard" }
  ],
  "created_at": "...", "updated_at": "..."
}
```

`grants` are allow-only (role-level deny is not used; see
[`authorization-semantics.md`](authorization-semantics.md) §1).

### `apps`

```json
{
  "_id": "...",
  "key": "purchase-approval",
  "name": "Purchase Approval System",
  "base_path": "/apps/purchase-approval",
  "repo_url": "...",
  "auth_mode": "oidc",
  "status": "active",
  "description": "...",
  "public_paths": [
    { "method": "*",    "pattern": "/health" },
    { "method": "POST", "pattern": "/api/webhooks/**" }
  ],
  "proxy_secret": "<generated per app on registration>",
  "created_at": "...", "updated_at": "..."
}
```

`public_paths` is the default-deny allowlist of app-relative paths that skip
Menagerai authentication, evaluated by the gateway (see
[`deployment-and-gateway.md`](deployment-and-gateway.md) §`/gateway/verify`).
Patterns match the path **after** stripping `/apps/<key>`, are method-scoped, and
requests matching them reach the app anonymously (no `X-Menagerai-*` headers).

`proxy_secret` is a per-app random value generated when the app is registered.
The gateway injects it as the `X-Menagerai-Proxy-Secret` response header on allowed
requests (Traefik copies it to the upstream), and the app validates it against
its own `MENAGERAI_PROXY_SECRET` env before trusting any `X-Menagerai-*` header — so a
request that reaches the app *without* passing through the gateway (a
misconfigured public route, or an internal attacker) cannot spoof identity.
Per-app (not shared) keeps a leak's blast radius to one app and allows
independent rotation.

### `email_allow_rules`, `audit_logs`

Standalone collections, one document per row of the logical tables above.
`audit_logs` is append-only and maps cleanly to a document per event in either
backend. (`sessions` is documented in
[`deployment-and-gateway.md`](deployment-and-gateway.md) § Session cookie.)

### `usage_daily`

App-usage statistics, collapsed from per-request access validations into **DAU =
distinct active days**: one document per `(user, app, business-day)`. The first
successful gateway access on a day inserts the row; further hits that day are a
no-op. The business day is bucketed in the configured `TIMEZONE` (default
`UTC`).

```json
{
  "_id": "...",
  "user_id": "<users._id>",
  "app_key": "demo",
  "day": "2026-06-23",          // 'YYYY-MM-DD' in TIMEZONE
  "first_at": "...",            // set once, on insert
  "last_at": "..."              // refreshed on each same-day hit (for "last used")
}
```

Written only at the gateway enforcement point on an ALLOW (`recordUsage`,
fire-and-forget); previews/listings (launcher, `/api/access/check`, admin access
matrices) and anonymous/forbidden requests are not counted. The unique
`(user_id, app_key, day)` index makes the upsert idempotent (restart- and
replica-safe); an in-process dedup set suppresses redundant same-day writes.

Reads power the admin pages: per-user "apps used most" and per-app "power users"
(active-day counts) and a GitHub-style activity heatmap (per-day intensity). Day
labels are zero-padded strings, so range windows compare lexicographically. Rows
are tiny (bounded by users × apps × active-days); no TTL in v1.

### Integrity Menagerai must enforce in code (no foreign keys)

```text
- Delete a role        → $pull its key from every users.roles.
- Delete/disable an app → cascade to roles[].grants and users[].app_overrides
                          that reference the key (or block deletion while
                          references exist).
- Delete a user or app  → also drop its usage_daily rows (deleteMany by
                          user_id / app_key).
- Rename a role key     → cascade the new key into every users.roles slot.
- Rename an app key      → cascade into roles[].grants, users[].app_overrides
                          and usage_daily.app_key, and reset apps.base_path.
                          The key is also the /apps/<key> URL segment, so the
                          deployment route (Coolify path + APP_BASE_PATH +
                          gateway middleware) MUST be repointed or the app 404s.
- Keys are stable identifiers and immutable as references: renaming is an
  explicit, cascading admin action (above), not an in-place field edit. Names
  and descriptions are freely editable; the system_admin role key is fixed.
- No multi-document transactions are used: multi-step writes (e.g. create user
  + write audit) are ordered so no single operation must span multiple
  documents atomically, so no MongoDB replica set is required.
```

### Indexes

Ensured by the store on startup (the same index set is expressed on either
backend — native indexes on MongoDB, indexes over generated columns on SQLite):

```text
users:              unique email; unique sparse logto_user_id
roles:              unique key
apps:               unique key
email_allow_rules:  (type, pattern)
sessions:           expires_at; user_id
                    (MongoDB: TTL index, expireAfterSeconds: 0; SQLite: no TTL,
                     the store sweeps expired rows periodically plus lazy expiry
                     on read — functionally equivalent)
audit_logs:         created_at desc
usage_daily:        unique (user_id, app_key, day); (app_key, day); (user_id, day)
```

Deferred until the dataset warrants them (queries are admin-only and small):
`users.roles` / `users.app_overrides.app`, `roles.grants.app`, and an
`audit_logs` composite on actor/target.

### `decide(user, app)` read path

```text
1. Load the user doc      → status, roles[], app_overrides[]   (by email or sub)
2. Load the app doc       → status                              (by key)
3. Load the user's roles  → roles where key ∈ user.roles;
                            collect grants where grant.app == app.key
4. Apply the precedence in authorization-semantics §1.
```

Three indexed reads (user, app, roles), cacheable for the short access-check TTL.
