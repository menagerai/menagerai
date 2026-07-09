# Rollout Plan

## Phase 1: Inventory and classification

Inventory deployed apps from Coolify and GitHub.

For each app, capture:

```text
App name
URL
Repo
Framework
Current auth type
Has internal roles?
Criticality
Suggested integration pattern
Notes / blockers
```

Classify each app:

```text
proxy-only
native-OIDC
middleware-needed
complex-internal-RBAC
```

Output should be an app catalog that can later seed the Menagerai database.

## Phase 2: Bootstrap Logto safely

Before disabling registration:

```text
[ ] Create at least one admin user in Logto.
[ ] Confirm that admin can sign in.
[ ] Seed that same email as `system_admin` in Menagerai.
[ ] Create Logto M2M Management API credentials.
[ ] Test Menagerai backend can obtain client-credentials token.
[ ] Test Menagerai can create a disposable Logto user.
[ ] Test Menagerai can disable/delete that user.
[ ] Disable public registration.
[ ] Confirm random unregistered email cannot register.
[ ] Confirm bootstrap admin can still sign in.
```

## Phase 3: Build minimum Menagerai / Portal

Minimum product surface:

```text
Authentication:
- Logto hosted login
- session handling
- current user endpoint

Admin:
- user search
- create/invite user
- disable user
- role assignment
- app assignment
- app catalog management

Authorization:
- organizational roles
- role app grants (organizational role → app)
- direct user overrides
- explicit deny overrides
- /api/access/check (binary allow/deny)
- /api/access/batch-check

Audit:
- audit_logs
- logto_sync_events
```

Minimum user portal:

```text
- show signed-in user's accessible apps
- hide inaccessible apps
- show “no apps assigned yet” if none
- show admin area only for system_admin users
```

## Phase 4: Protect simple apps

Migrate apps with no auth or password-only auth behind reverse proxy / ForwardAuth first.

Goals:

- Replace shared passwords quickly.
- Ensure users have one central sign-in.
- Inject trusted headers where needed.
- Prevent direct public access to protected app containers.

Security checklist:

```text
[ ] App cannot be reached directly from public internet.
[ ] App only trusts X-Menagerai-* headers from proxy.
[ ] Proxy strips client-provided X-Menagerai-* headers before setting them.
[ ] Unauthorized users see an actionable no-access page.
```

## Phase 5: Integrate complex apps natively

For apps with real business logic or internal roles:

- Add native OIDC verification.
- Add shared Python/Node middleware where useful.
- Call Menagerai `/api/access/check` for the binary access gate.
- Each app maps the forwarded identity (email / organizational roles) to its own internal permissions, if it needs any.
- Cache access checks briefly.
- Use live checks for critical admin operations.

## Phase 6: Access review and operations

Add operational features after the first usable version:

```text
- “What can this user access?”
- “Who can access this app?”
- exportable access reports
- periodic access review
- offboarding workflow
- Logto sync status dashboard
- failed sync retry
- break-glass admin policy
```

## Security baseline

Must-have:

```text
- email verification required
- MFA for admins if available
- HTTPS only
- secure cookies
- short-lived access tokens
- audit logs for all admin actions
- disable/deactivate user support
- no direct public access to proxy-protected legacy apps
- apps verify JWT signature, issuer, audience, and expiry
```

Avoid:

```text
- shared passwords
- frontend-only role checks
- hardcoded role config in each app
- trusting public X-Menagerai-* headers
- baking access state into long-lived JWTs instead of live-checking the Menagerai gate
- building a custom password system
```

## Near-term implementation order

1. Create repo documentation and design baseline.
2. Inventory current apps and classify integration mode.
3. Build minimal Menagerai schema and seed bootstrap admin.
4. Wire Logto login.
5. Wire Logto Management API user creation/disable tests.
6. Disable public registration only after bootstrap tests pass.
7. Build app launcher and access-check endpoints.
8. Protect one simple app via proxy auth as pilot.
9. Integrate one complex app via native OIDC/SDK as pilot.
10. Expand app-by-app.
