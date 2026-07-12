# App onboarding — <App Name>

Copy this file to `apps/<key>.md` and fill it in when bringing an app under the Menagerai portal. Worked example: [`demo.md`](demo.md) (Node/Express). See the design docs for the model: [`deployment-and-gateway.md`](../design/deployment-and-gateway.md), [`authorization-semantics.md`](../design/authorization-semantics.md), [`app-integration-patterns.md`](../design/app-integration-patterns.md).

## 1. Catalogue facts

```text
Key            <url-safe [a-z0-9_-], starts alphanumeric; also the /apps/<key>
               path segment — immutable>
Name           <human name>
Repo           <git remote / local path>
Framework      <e.g. Express + SQLite, FastAPI, Next.js>
Current auth    <none | shared password | internal users | OIDC>
Has internal roles?   <yes/no — and what they are>
Criticality    <low | medium | high>
Pattern        <proxy-only | native-OIDC | middleware-needed | complex-internal-RBAC>
```

## 2. Route map → access policy

List every route and decide its policy. Public = reachable anonymously (third-party API, health, webhooks). Protected = gateway-authenticated. Default is protected.

```text
ROUTE                       POLICY      NOTES
GET  /healthz               public      health check
...                         protected   ...
```

The public rows become the app's `public_paths` allowlist; everything else is gated by the gateway.

## 3. In-app authorization (if any)

Menagerai only decides whether a user may reach the app at all — a binary allow/deny per (user, app). It does **not** model in-app roles. On an allow the gateway forwards the user's identity and organizational roles: `X-Menagerai-User-Email` / `X-Menagerai-User-ID` / `X-Menagerai-Roles` (organizational role keys, comma-separated) / `X-Menagerai-Proxy-Secret`. There is no `X-Menagerai-App-Role`.

If the app needs finer-grained internal authorization, it implements that itself from the forwarded identity (chiefly the email, optionally the organizational roles in `X-Menagerai-Roles`) — not from any Menagerai-provided per-app role. If it doesn't, every gateway-cleared user simply has full access.

## 4. `apps` document (Menagerai seed)

```json
{
  "key": "<key>",
  "name": "<Name>",
  "base_path": "/apps/<key>",
  "auth_mode": "proxy",
  "status": "active",
  "public_paths": [ /* { method, pattern } — app-relative */ ],
  "proxy_secret": "<generated on registration>"
}
```

In practice you don't hand-write this — register the app in the admin UI (`/admin/apps`), which generates the `proxy_secret`; then edit `public_paths` on the app's page. There is no `app_roles` or `default_role` to set — access is binary. Keys allow `[a-z0-9_-]`, must start alphanumeric, and are immutable. There is no `url` field — apps are reached at `/apps/<key>` on every portal host (host-relative), so routing is key-based.

## 5. Code changes to the app

```text
[ ] App runs under base path /apps/<key> (basePath / root_path / base).
[ ] Remove the app's own auth gate (password / login).
[ ] Trust the gateway: read X-Menagerai-User-Email / -User-ID / -Roles.
[ ] Validate X-Menagerai-Proxy-Secret against MENAGERAI_PROXY_SECRET before trusting them.
[ ] Any finer-grained authz is the app's own job (decide from the email / -Roles).
[ ] Public routes stay reachable with NO X-Menagerai-* headers (anonymous).
[ ] Local-dev bypass (DEV_TRUST) injects a fake user so the app runs without a gateway.
[ ] On 401 from an API call, re-auth via a TOP-LEVEL navigation (so the gateway's
    Sec-Fetch-Mode=navigate → 302 → Logto flow runs). Do NOT blind-loop: an
    unconditional reload() on 401 spins forever when the 401 is the app's own
    proxy-secret check (gateway is fine, secret is missing) — guard it.
```

> Pitfall seen with the demo app: if the app shell is served *statically/unauthenticated* (so it always loads) while its APIs are gated, a misconfigured gateway shows as an infinite reload loop, not an error. Identity/signing is a *portal* concern — the app never talks to Logto and never cares about the ES384 alg; it only validates `X-Menagerai-Proxy-Secret` and reads the `X-Menagerai-*` headers.

## 6. Coolify wiring

Confirm first: **Server → Proxy is Traefik** (not Caddy) — `menagerai-auth@file` is Traefik-only. (The `caddy_*` labels Coolify also emits are inert under Traefik.)

```text
[ ] FQDN = <host>/apps/<key>   (host WITH path → PathPrefix router + auto stripprefix)
[ ] Env: APP_BASE_PATH=/apps/<key>
         MENAGERAI_PROXY_SECRET=<this app's secret — must equal apps.proxy_secret in Menagerai>
[ ] Labels (Readonly OFF) → add menagerai-auth@file as the FIRST middleware on the
    HTTPS router, before stripprefix/gzip:
      traefik.http.routers.https-<id>.middlewares=menagerai-auth@file,<existing...>
    (ordering is mandatory — ForwardAuth must see the full /apps/<key>/... path)
[ ] Prefix strip: keep it only if the app tolerates a stripped inbound path
    (routes at "/", re-adds prefix for outbound links). For basePath/root_path
    frameworks, REMOVE the "…-stripprefix" entry so the app gets /apps/<key>/...
[ ] NO second public FQDN / exposed port — reachable only through the gateway
[ ] Redeploy (labels apply on redeploy; confirm Readonly stayed off)
```

## 7. Verify

Set `GATEWAY_LOG=1` on menagerai and tail its logs while testing — one line per gated request. **No line for a gated path ⇒ ForwardAuth isn't attached** (the classic "loops with no logs" failure).

```text
[ ] gateway logs show a line for /apps/<key>/...   (proves the middleware is wired)
[ ] curl a protected path with no cookie           → 302 (browser) / 401 (api)
[ ] curl a protected path with no proxy secret     → 401 (spoof attempt blocked)
[ ] curl /apps/<key>/api/me with a session cookie  → 200 (401=secret, 403=grant)
[ ] curl a public path with no auth                → 200
[ ] a non-granted user is denied at the gateway    → 302 (browser) / 403 (api)
[ ] a granted user reaches every protected route   → 200
```

See [`../DEPLOY.md`](../DEPLOY.md) §7 for the full symptom→cause troubleshooting table.
