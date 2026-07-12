# App Integration Patterns

Apps behind Menagerai are a mix of Python, JavaScript, and other frameworks. The access-control plane should support multiple integration paths so existing apps can be migrated gradually.

## Pattern A: Native OIDC integration

Best for mature apps with real backend/session logic.

Flow:

```text
User visits app
→ app redirects to Logto
→ user signs in
→ app receives ID/access token
→ app verifies token signature, issuer, audience, and expiry
→ app calls Menagerai to check app access (a binary allow/deny)
→ on allow, app renders UI from the forwarded identity (email, organizational roles),
  deriving any in-app roles/permissions itself
```

Good fit for:

- Next.js
- React with backend
- FastAPI
- Express
- Django
- Apps with existing internal user/role logic

Pros:

- Standards-based.
- Clean security model.
- Good for apps needing deep internal authorization.

Cons:

- Requires code changes in each app.

## Pattern B: Reverse proxy / ForwardAuth

Best for simple dashboards, static apps, and current password-gated legacy apps.

Flow:

```text
User → Auth Proxy → App
```

The proxy authenticates the user (via Logto), asks Menagerai what that user is allowed to do by calling `/api/access/resolve` over an M2M token (see [`authorization-semantics.md`](authorization-semantics.md) §2), and injects trusted headers:

```http
X-Menagerai-User-Email: alice@example.com
X-Menagerai-User-ID: user_123
X-Menagerai-Roles: finance_staff,employee
X-Menagerai-Proxy-Secret: <per-app shared secret>
```

`X-Menagerai-Roles` carries the user's ORGANIZATIONAL role keys, not per-app roles — Menagerai forwards identity, not an in-app role. There is no `X-Menagerai-App-Role`.

Good fit for:

- Static apps.
- Simple dashboards.
- Apps with shared password challenge.
- Legacy apps where fast rollout matters more than deep role integration.

Pros:

- Minimal app changes.
- Fast migration path.
- Centralized enforcement.

Cons:

- Apps must not be directly exposed.
- Header spoofing must be prevented.
- Less flexible for function-level authorization.

### Header trust mechanism

"Only trust headers from the proxy" is a requirement, not a mechanism. Enforce it with defense in depth — all three layers, not one:

```text
1. Network isolation
   - Protected app containers are never published to the public internet.
   - They listen only on the internal network the proxy shares with them
     (e.g. a private Coolify/Docker network). The only public entrypoint is
     the proxy.

2. Inbound header stripping
   - The proxy unconditionally strips any client-supplied X-Menagerai-* header
     BEFORE it sets its own. A request arriving with X-Menagerai-User-Email is
     scrubbed; the client cannot smuggle identity in.

3. Proxy → app authentication
   - The proxy proves it is the proxy on every hop, via either:
       a. mTLS between proxy and app, or
       b. a PER-APP shared secret header (X-Menagerai-Proxy-Secret). Menagerai stores
          each app's secret in its `apps` doc, injects it on allowed
          /gateway/verify responses, and the app validates it against its own
          MENAGERAI_PROXY_SECRET env. Per-app, not global — a leak is contained to
          one app and rotates independently.
   - The app rejects any request whose X-Menagerai-* headers are not accompanied
     by valid proxy authentication, even on the internal network.
```

If any single layer fails (a container gets accidentally published, a header isn't stripped), the others still hold. The shared secret / mTLS in layer 3 is what makes header spoofing infeasible even for an attacker already inside the network.

Security requirement:

```text
Only trust identity/access headers from the internal proxy path.
Never trust public client-provided X-Menagerai-* headers.
```

Possible tools:

- oauth2-proxy
- Traefik ForwardAuth
- Caddy auth portal
- Nginx `auth_request`
- Custom lightweight gateway

## Pattern C: Shared Menagerai auth SDK / middleware

Create small internal helper packages for repeated integrations.

Possible packages:

```text
menagerai_auth_python
@menagerai/auth-node
```

The Menagerai access check is binary — it answers "may this user reach this app?", not "with what app role?". The SDK surfaces that gate plus the forwarded identity; any in-app role/permission guard is the app's own logic over the user's email and organizational roles.

Python shape:

```python
user = get_current_menagerai_user(request)
require_app_access("purchase-approval")  # binary gate
# the app derives its own internal roles from user.email / user.roles
```

TypeScript shape:

```ts
const user = await getMenageraiUser(req);
await requireAppAccess(user, "purchase-approval");  // binary gate
// the app derives its own internal roles from user.email / user.roles
```

Responsibilities:

- Verify Logto JWTs.
- Call the Menagerai access-check API (binary allow/deny).
- Cache access checks for a short TTL.
- Standardize redirect and unauthorized errors.
- Extract current user (email, ID, organizational roles).
- Expose the forwarded identity so the app can build its own guards if it needs them.

## Access-check API

Prefer live access checks over stuffing access state into long-lived JWTs. The check is a coarse, gate-level decision: a binary allow/deny per (user, app). It does not return an app role or a permission bundle — finer-grained authorization is the app's own concern.

The full contract — endpoints, who may call them, token modes, request/response shapes, and edge cases — is defined in [`authorization-semantics.md`](authorization-semantics.md). In short:

```text
POST /api/access/check        user-token mode — an app asks about the signed-in
                              user (subject = token sub). Patterns A and C.
POST /api/access/batch-check  user-token mode over many apps — the portal launcher.
POST /api/access/resolve      M2M mode — a trusted backend (the proxy in Pattern B)
                              asks about an explicitly named subject.
```

Example `/check` response:

```json
{
  "subject": "user_123",
  "app": "purchase-approval",
  "allowed": true
}
```

## Token strategy

Use a hybrid strategy:

```text
Logto token:
- identity
- subject ID
- email
- email_verified
- stable basic claims

Menagerai:
- app access (binary allow/deny per user+app)
- live status

Apps:
- cache access checks for 1–5 minutes
- perform live check for critical admin actions
- own any internal roles/permissions, derived from the forwarded identity
```

Avoid baking access state into long-lived tokens because grant changes and offboarding need to take effect quickly.

## Existing app migration classification

For every app, capture:

```text
App name
URL
Repo
Framework
Current auth type
Has internal roles?
Criticality
Suggested integration pattern
```

Classify as:

```text
proxy-only
native-OIDC
middleware-needed
complex-internal-RBAC
```

## Legacy app handling

### Type 1: no auth / password gate only

Protect with reverse-proxy auth first. Phase out the password challenge later.

### Type 2: internal user table

Map Logto identity to the internal user table:

```text
Logto email: alice@example.com
Internal user: user_id 42
```

Migration fields:

```text
internal_users.external_auth_provider = "logto"
internal_users.external_user_id = "logto_sub"
internal_users.email = "alice@example.com"
```

### Type 3: internal role system

Menagerai only decides whether the user may reach the app (binary allow/deny). It does not pass an app role. An app with an internal role system maps the forwarded identity — chiefly the email, optionally the organizational roles — to its own internal roles and permissions.

Example:

```text
Forwarded identity: alice@example.com (organizational roles: finance_staff)
App's own internal mapping:
- can_view_purchase
- can_approve_purchase
- can_export_report
```

Menagerai does not centralize app permissions. It centralizes the top-level access gate; each app keeps its own internal roles where it needs them.
