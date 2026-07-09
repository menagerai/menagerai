# App onboarding — Demo App

A reference worked example of bringing an app under the Menagerai portal: a
prompt-tree manager with an admin UI and a public read API used by third-party
callers. Use it as the template when onboarding your own apps.

## 1. Catalogue facts

```text
Key            demo
Name           Demo App
URL            https://<portal-host>/apps/demo
Repo           ../demo  (adjacent to this repo)
Framework      Express + better-sqlite3; React admin UI bundled with esbuild
Current auth    shared password (AUTH_PASSWORD, X-Auth-Password header)
Has internal roles?   no (single password = full access)
Criticality    medium (third-party API consumers depend on the public reads)
Pattern        proxy-only  (gateway authenticates; app trusts X-Menagerai-* headers)
```

## 2. Route map → access policy

```text
ROUTE                         POLICY      NOTES
GET  /healthz                 public      container health check
GET  /api/public              public      third-party API — whole tree
GET  /api/public/k1/k2/...    public      third-party API — subtree / prompt text
GET  /api/me                  protected   returns the signed-in user
GET  /api/tree                protected   read tree (any cleared user)
PUT  /api/tree                protected   write tree (any cleared user)
GET  /admin/*, /              protected   admin UI shell (served after gateway auth)
```

The two public rows are the reason this app can't simply be "all behind auth":
external systems read prompt content via `/api/public/**` with no Menagerai session.

## 3. In-app authorization

The demo app has **no in-app roles**. Any gateway-cleared user has full read-write
access — open the admin UI, read the tree, and add/edit/rename/move/delete/
reorder + save. There is no `app_roles` config: Menagerai's binary allow/deny per
(user, app) is the only access decision.

## 4. `apps` document (Menagerai seed)

```json
{
  "key": "demo",
  "name": "Demo App",
  "base_path": "/apps/demo",
  "auth_mode": "proxy",
  "status": "active",
  "public_paths": [
    { "method": "GET", "pattern": "/healthz" },
    { "method": "GET", "pattern": "/api/public" },
    { "method": "GET", "pattern": "/api/public/**" }
  ],
  "proxy_secret": "<generated on registration>"
}
```

## 5. Code changes applied to ../demo

```text
[x] APP_BASE_PATH=/apps/demo (already supported — no code change).
[x] Removed AUTH_PASSWORD, the requireAuth password gate, and POST /api/login.
[x] Added menageraiUser()/requireUser() middleware:
       - validates X-Menagerai-Proxy-Secret against MENAGERAI_PROXY_SECRET,
       - then reads X-Menagerai-User-Email / -User-ID / -Roles (no per-app role).
[x] GET and PUT /api/tree both require an authenticated (gateway-cleared) user —
    no role distinction; any cleared user can read AND write.
[x] Added GET /api/me (any authenticated user) so the UI shows who is signed in.
[x] /api/public/** and /healthz unchanged — anonymous, no proxy-secret required.
[x] DEV_TRUST=1 injects a fake user so `npm start` works with no gateway.
[x] Frontend: removed the password Login; always allows editing; on 401 it reloads
    to trigger gateway login; "Sign out" navigates to the portal /logout.
```

## 6. Coolify wiring  (deployed — working config)

```text
[x] FQDN = app.example.com/apps/demo   (PathPrefix router; Coolify also
    auto-added a stripprefix — kept, because the demo app tolerates a stripped path)
[x] Env:
      APP_BASE_PATH=/apps/demo
      MENAGERAI_PROXY_SECRET=<the demo app's secret from Menagerai>   (must match apps.proxy_secret)
      DB_PATH=/app/data/demo.db   (persistent volume at /app/data)
[x] Labels (Readonly OFF): menagerai-auth@file is the FIRST middleware on the HTTPS
    router, BEFORE stripprefix:
      traefik.http.routers.https-<id>.middlewares=menagerai-auth@file,https-<id>-stripprefix,gzip
[x] No second public FQDN / exposed port — reachable only via the gateway.
```

Note: `/api/public/**` is intentionally anonymous, but it still bears the
`menagerai-auth` middleware — the gateway matches it against `public_paths` and lets
it through without a session. Third-party callers keep using
`https://<portal-host>/apps/demo/api/public/...` unchanged.

## 7. What broke, and what fixed it (lessons → runbook)

These were the real issues bringing the first app online; all are now captured in
[`../DEPLOY.md`](../DEPLOY.md) §4–§7 and [`_TEMPLATE.md`](_TEMPLATE.md):

```text
- Logto sign-in failed with "unexpected JWT alg ... expected RS256, got ES384".
  Logto signs ID tokens ES384; Menagerai now expects ES384 (LOGTO_ID_TOKEN_ALG).
- menagerai-auth@file was never attached to the demo router → Traefik never called
  /gateway/verify → no Menagerai logs at all; the static admin shell loaded but every
  gated API 401'd and the SPA reload()-looped. Attaching the middleware fixed it.
- Coolify auto-added a stripprefix for the path FQDN. menagerai-auth MUST be ordered
  BEFORE it, or the gateway sees /api/... (no /apps/demo) and 404s. Putting
  menagerai-auth first in the chain resolved routing.
- Confirm the server proxy is Traefik (not Caddy) — Coolify emits both label sets.
- Debug aid: GATEWAY_LOG=1 on menagerai prints one decision line per request;
  absence of any line for a gated path = the middleware isn't wired.
```

## 8. Verify

```text
[ ] GET /apps/demo/api/public/<key>           no auth   → 200 + prompt text
[ ] GET /apps/demo/api/tree                   no cookie → 302 (nav) / 401 (xhr)
[ ] GET /apps/demo/api/tree  spoofed X-Menagerai-* but no proxy secret → 401
[ ] a non-granted user is denied at the gateway; a granted user can read AND write
[x] GET and PUT /api/tree require an authenticated (gateway-cleared) user
```
