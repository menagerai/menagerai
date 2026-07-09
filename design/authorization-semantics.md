# Authorization Semantics

This document pins down the parts of the access-control model that must be
unambiguous before any code is written: how an access decision is computed, who
is allowed to ask the access-check endpoints, and how the answer is returned.

The data model lives in [`rbac-and-data-model.md`](rbac-and-data-model.md). This
document defines the *behavior* over that model.

## 1. The access decision

The core question every integration ultimately asks is:

> For user `U` and app `A`, is access allowed?

This is a **binary** decision — allow or deny. Menagerai performs only coarse,
gate-level access control: it decides whether a user may *reach* an app at all.
It does **not** model in-app roles or permissions. Any finer-grained
authorization is each app's own responsibility, decided inside the app from the
forwarded identity (chiefly email) and organizational roles.

There is exactly one function that answers this. Every endpoint, SDK helper, and
proxy is a thin wrapper over it. It must be **total** (always returns a decision)
and **deterministic** (same inputs → same output).

### Inputs

```text
U   the resolved Menagerai user (status, organizational roles)
A   the target app (must exist and be status=active)
```

Relevant tables (see data model):

```text
users.status                       pending | active | disabled
user_roles                         U's organizational roles
role_app_grants(role, A)           effect: allow | deny
user_app_overrides(U, A)           effect: allow | deny
```

### Precedence

Access (allow) comes only from roles. Anything not granted is denied by default.
A per-user deny is the one override that beats a role grant. There is **no
role-level deny** in the current policy — `role_app_grants` are allow-only.

Evaluation stops at the first rule that matches:

```text
1. Status gate
   if U.status != 'active'                       → DENY
   if A is missing or A.status != 'active'       → DENY

2. User-level deny  (the kill switch)
   if any user_app_override(U, A, effect=deny)   → DENY

3. User-level allow (one-off escape hatch)
   if any user_app_override(U, A, effect=allow)  → ALLOW

4. Role-level allow (the normal path)
   if any role_app_grant(role ∈ U.roles, A)      → ALLOW

5. Default
   → DENY
```

### Why this order

- **Default deny.** Access only ever appears because a role grants it (step 4) or
  an admin grants it to one person (step 3). Possessing a work email, or any
  state not listed above, yields no access.
- **A per-user deny beats everything (step 2).** This is the kill switch for "Bob
  is in a broad department role but must be excluded from one sensitive app." It
  is app-scoped: it removes access to the whole app `A`, not one role within it.
- **A per-user allow (step 3) is the rare one-off** — grant one person access to
  one app without inventing a role for them. It cannot override a user-level deny
  (step 2 runs first); if both somehow exist for the same app, deny wins.
- **The decision is binary.** Multiple matching allows do not need to be
  reconciled — any one allow yields `ALLOW`. There is no role or priority to
  resolve, and no permission bundle to return.

### Truth table

`A` is active and `U.status = active` in all rows below.

```text
user deny | user allow | role allow | result
----------+------------+------------+------------------------
   yes    |     -      |     -      | DENY   (step 2)
   yes    |    yes     |     -      | DENY   (step 2)
    -     |    yes     |     -      | ALLOW  (step 3)
    -     |    yes     |    yes     | ALLOW  (step 3)
    -     |     -      |    yes     | ALLOW  (step 4)
    -     |     -      |     -      | DENY   (step 5)
```

### Reference implementation (pseudocode)

```text
function decide(U, A):
    if U.status != 'active':              return DENY
    if A is null or A.status != 'active': return DENY

    uOver = user_app_overrides(U, A)
    if any(o.effect == 'deny'  for o in uOver):  return DENY
    if any(o.effect == 'allow' for o in uOver):  return ALLOW

    rGrant = role_app_grants(U.roles, A)            // allow-only
    if rGrant:  return ALLOW

    return DENY
```

The decision function returns just `{ allowed, reason }` — no app role, no
permissions. On an allow, the gateway forwards identity + organizational roles to the
app; the app decides any finer-grained authorization itself.

## 2. Who may ask — endpoint trust model

There are two distinct callers, and they must not share an endpoint, because they
carry different trust:

- **An app acting as the signed-in user.** It holds the *user's* Logto access
  token. It can only ask about *itself* (the token's subject).
- **A trusted backend service acting on behalf of users** — most importantly the
  auth proxy in Pattern B, which must ask "is *this other user* allowed?" after
  it authenticated them. It holds an *M2M* (client-credentials) token, not a user
  token.

Collapsing these into one endpoint is what made the original draft ambiguous
(a request body carrying someone else's identity over a user token). They are
split:

### `POST /api/access/check` — user-token mode

```text
Caller:    an app, on behalf of the signed-in user
Auth:      Authorization: Bearer <user Logto access token>
Subject:   the token's `sub`. A subject in the body is rejected.
Menagerai must:  verify signature, issuer, audience, expiry, then map sub → Menagerai user.
```

```http
POST /api/access/check
Authorization: Bearer <USER_LOGTO_ACCESS_TOKEN>
Content-Type: application/json

{
  "app": "purchase-approval"
}
```

```json
{
  "subject": "logto_user_123",
  "app": "purchase-approval",
  "allowed": true
}
```

The answer is binary: just whether the subject may reach the app. Menagerai
returns no app role and no permissions — any finer-grained, in-app
authorization is the app's own responsibility, decided from the forwarded
identity.

### `POST /api/access/resolve` — service (M2M) mode

```text
Caller:    a registered trusted backend (the proxy, a batch job)
Auth:      Authorization: Bearer <M2M client-credentials token>
Scope:     access:resolve
Subject:   passed explicitly in the body (logto sub or email)
Menagerai must:  verify the token is M2M, map client_id → a registered trusted client,
           confirm it holds access:resolve, then evaluate for the named subject.
```

```http
POST /api/access/resolve
Authorization: Bearer <M2M_TOKEN>
Content-Type: application/json

{
  "subject": { "logto_user_id": "logto_user_123" },
  "app": "purchase-approval"
}
```

The response shape matches `/check`. Only M2M clients on an allowlist may call
`/resolve`; a user token presented here is rejected, and an M2M token presented
to `/check` is rejected. The two modes never overlap.

### Distinguishing the token type

Logto issues user tokens (interactive, carry a user `sub`) and M2M tokens
(client-credentials, carry a `client_id`, no interactive user). Menagerai keys off
the audience/grant: M2M tokens are scoped to the Management/Menagerai resource via
client credentials and have no end-user subject. Menagerai rejects the wrong token
type per endpoint rather than guessing intent.

### Batch check (portal launcher)

`POST /api/access/batch-check` is the user-token-mode `/check` over many apps in
one call, used to render the launcher. Same auth rules as `/check`.

```http
POST /api/access/batch-check
Authorization: Bearer <USER_LOGTO_ACCESS_TOKEN>

{ "apps": ["finance-reconciliation", "sales-dashboard", "purchase-approval"] }
```

## 3. Caching and freshness

```text
Apps/SDK:  cache a decision for 1–5 minutes per (subject, app).
Critical:  bypass cache and live-check for sensitive admin actions
           (approvals, money movement, user management).
Proxy:     may cache per session for the same short TTL.
```

The short TTL is the deliberate cost of *not* baking authorization into
long-lived JWTs: a revoked grant or a disabled user takes effect within one TTL
window everywhere, without token revocation machinery.

## 4. Edge cases (must be handled explicitly)

```text
- Unknown app key                  → DENY (treat as no access, not an error page)
- Subject has no Menagerai user row → DENY
- Subject user is pending/disabled → DENY (status gate, step 1)
- App status != active             → DENY
- Valid token, no apps assigned    → every check DENY; portal shows
                                      "No apps assigned yet"
- Expired / bad-signature token    → 401, not a decision
- Right token type, wrong endpoint → 401/403, never silently honored
```

A `DENY` is a normal, expected answer and must render an actionable no-access
page — never a 500 and never a generic "error".
