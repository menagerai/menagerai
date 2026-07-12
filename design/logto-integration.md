# Logto Integration Design

## Recommended setup

Use Logto as Menagerai's identity provider, not as the full business authorization system.

```text
Logto owns:
- hosted sign-in
- authentication
- verified email / subject ID
- sessions and tokens
- identity-level suspension/deletion

Menagerai owns:
- approval rules
- organizational status
- departments
- organizational roles
- app grants (organizational role → app; a binary access gate, not in-app roles)
- audit logs
- offboarding workflow
```

## Free-plan-safe organizational pattern

The agreed path is:

```text
1. Create first admin user in Logto.
2. Confirm that admin can sign in.
3. Disable public registration.
4. Menagerai becomes the only user-provisioning interface.
5. Menagerai uses Logto Management API for user CRUD.
6. Individual apps use Logto identity + Menagerai authorization.
```

This avoids relying on hosted-domain restriction features that may not be available on Logto Cloud free production tenants.

## Why not rely on Logto email-domain restriction?

Logto's documented sign-in-time domain restriction path is Custom token claims with `api.denyAccess()`.

Example pattern:

```js
const getCustomJwtClaims = async ({ token, api }) => {
  const email = token.email?.toLowerCase();
  const domain = email?.split('@')[1];

  const allowedDomains = [
    'example.com',
    'example.net',
  ];

  if (!domain || !allowedDomains.includes(domain)) {
    api.denyAccess('Only approved company email addresses are allowed.');
  }

  return {};
};
```

However, this feature may only be available for:

- Logto OSS users
- Logto Cloud tenants with development environments
- Logto Cloud paid production tenants

Therefore, for a free hosted production setup, do not assume `api.denyAccess()` is available.

## Why not Logto blocklist?

Logto blocklist is not an allowlist. It is useful for blocking disposable domains or known-bad emails during registration/account linking, but existing users with blocked addresses can still sign in.

It is not sufficient as organizational access enforcement.

## Why not organization JIT alone?

Logto organization just-in-time provisioning can add users to organizations based on verified email domain during signup. This can be useful later, but it does not fully solve sign-in denial or business authorization for existing users.

Treat organization JIT as onboarding automation, not final access control.

## Bootstrap safety checklist

Before disabling registration:

```text
[ ] At least one real admin user exists in Logto.
[ ] The admin can complete hosted sign-in successfully.
[ ] That same email is seeded as `system_admin` in the Menagerai database.
[ ] A Logto machine-to-machine application exists for Management API access.
[ ] Menagerai backend can obtain a client-credentials token.
[ ] Menagerai can create a disposable test user in Logto.
[ ] Menagerai can disable/delete that test user in Logto.
[ ] Public registration is disabled.
[ ] A random unregistered email cannot register.
[ ] The bootstrap admin can still sign in after registration is disabled.
```

Skipping the first three can lock operators out of the admin plane.

## Management API credentials

The browser/admin frontend must never call the Logto Management API directly.

Store credentials only on the Menagerai backend as environment variables:

```text
LOGTO_ENDPOINT
LOGTO_M2M_APP_ID
LOGTO_M2M_APP_SECRET
LOGTO_MANAGEMENT_API_RESOURCE
```

Backend flow:

```text
Menagerai backend obtains client_credentials token
→ calls Logto Management API
→ records request/response/error in sync log
→ writes audit log for the admin action
```

## User lifecycle

### Create / invite user

1. Admin enters email, name, department, initial organizational role, and app access.
2. Menagerai validates email against the approved rules.
3. Menagerai creates local user row with status `pending` or `active`.
4. Menagerai creates Logto user via Management API.
5. Menagerai stores returned `logto_user_id`.
6. Menagerai optionally sends invitation, password reset, or magic-link flow.
7. Menagerai writes audit log and sync event.

### Update user

1. Menagerai updates business fields, roles, and app grants.
2. Menagerai syncs identity fields to Logto only when needed.
3. Menagerai writes before/after audit log.

### Disable / offboard user

1. Mark Menagerai user as `disabled`.
2. Suspend, delete, or deactivate user in Logto according to retention policy.
3. Revoke sessions/tokens where supported.
4. Remove or deactivate app access grants.
5. Write audit log.

Do not merely revoke app grants during offboarding. Identity-level disable is required too.

## Keeping Menagerai and Logto in sync (both directions)

`logto_sync_events` covers the **write** path (Menagerai → Logto): every user create, update, and disable Menagerai initiates is logged so drift is visible. But identity state can also change **on the Logto side** — an operator suspends or deletes a user directly in the Logto console, or Logto deactivates an account. Nothing in the write-path log catches that, so Menagerai needs a **read** path back.

```text
Menagerai → Logto   write path   provisioning, updates, offboarding (logged in
                                 logto_sync_events)
Logto → Menagerai   read path    identity-level suspension/deletion reflected back
                                 into Menagerai user.status
```

### Primary: Logto webhooks

Subscribe the Menagerai backend to Logto webhooks for identity-level events:

```text
User.Suspended / User.Deleted  → Menagerai sets users.status = disabled,
                                 revokes app grants per offboarding policy,
                                 writes an audit log (actor = "logto-webhook").
User.Created (out-of-band)     → flag for admin review; Menagerai-provisioned users
                                 already have a row, so an unmatched create
                                 means someone bypassed Menagerai.
```

Verify the webhook signature so the endpoint cannot be spoofed.

### Backstop: periodic reconcile sweep

Webhooks can be missed (downtime, delivery failure). Run a periodic job that lists Logto users via the Management API and reconciles against Menagerai users:

```text
- Logto user suspended/deleted but Menagerai user active → disable in Menagerai, audit.
- Menagerai user active but absent in Logto              → flag drift for admin.
- Mismatched email / logto_user_id                       → flag drift for admin.
```

This is the read-path counterpart to `logto_sync_events` and closes the loop: authorization stays Menagerai-owned, identity-level suspension stays Logto-owned, and neither side silently diverges from the other. Because apps live-check Menagerai on a short TTL (see [`authorization-semantics.md`](authorization-semantics.md) §3), a reflected disable takes effect everywhere within one cache window.

### Implemented today: display-name sync (both directions)

The webhook/reconcile machinery above is the broader design; the **name** field is kept in sync now, at two no-extra-infrastructure touchpoints, when the Management API is configured (`managementConfigured()`) and the user is linked (`logto_user_id` set):

```text
Menagerai → Logto   on profile edit   admin edits a user's name in the portal →
                                      PATCH /api/users/:id { name } (best-effort; the
                                      local save still succeeds and a sync failure is
                                      surfaced as a warning). Stamps last_synced_to_logto_at.
Logto → Menagerai   on sign-in        the OIDC callback reads the `name` claim; if it
                                      differs from the stored name, the portal adopts it
                                      and writes an audit (action user.name_synced_from_logto).
```

Each side is last-write-wins for the name (low-stakes, single field). The login pull means a name changed directly in Logto reflects in the portal on the user's next sign-in; a webhook (`User.Data.Updated`) would make the reverse direction real-time but is not required for this field. The **email** is deliberately not synced/editable — it is the identity key Logto asserts; correcting it means delete + recreate the user.
