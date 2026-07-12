# Deployment Topology and Gateway

This document describes the runtime shape of the portal — how apps are addressed, who terminates authentication, and the exact login/session sequence. It makes concrete the integration patterns in [`app-integration-patterns.md`](app-integration-patterns.md) and the endpoint contract in [`authorization-semantics.md`](authorization-semantics.md).

## Topology: one domain, apps under subfolders

The portal and all apps live under a single host (per tenant), e.g. `app2.example.com` (or `portal.example.com` for the default deployment). User-facing apps are namespaced under a reserved `/apps/<key>/` prefix so they can never collide with Menagerai's own routes:

```text
app2.example.com/                → Menagerai portal (launcher) — the bare domain
app2.example.com/login,/callback → Menagerai auth
app2.example.com/logout
app2.example.com/api/*           → Menagerai API (access checks, admin API)
app2.example.com/admin/*         → Menagerai admin UI
app2.example.com/gateway/verify  → ForwardAuth endpoint
app2.example.com/apps/<key>/*    → user-facing Coolify apps  ← reserved prefix
        /apps/demo      → app: Demo App
        /apps/finance   → app: Finance Reconciliation
        /apps/sales     → app: Sales Dashboard
```

Consequences of the single-host, subfolder choice:

```text
+ One TLS certificate for the whole portal.
+ One session cookie (Domain=app2.example.com) covers every app → simple SSO.
+ One gateway sees every request → one place to enforce auth.
- Every app MUST run correctly under a base path (/demo), not just "/".
  Asset URLs, internal links, cookie paths, and OAuth/redirect callbacks must
  all be base-path-aware. Making an app base-path-aware is a required step in
  onboarding it (see rollout plan).
```

The base-path requirement is the price of this topology. App onboarding includes verifying the app honors a configured base path before it is routed.

## Path namespace and Traefik routing

Menagerai owns the root namespace; user apps live only under `/apps/`. This partition is what keeps routing unambiguous — without it, an app keyed `admin` or `api` would shadow Menagerai routes and precedence would have to be hand-tuned.

```text
PathPrefix(`/apps/`)  → app routers (ForwardAuth middleware) → Coolify backends
everything else       → Menagerai service
```

Routing and the access check both derive from the URL, so onboarding an app needs no bespoke gateway config:

```text
- The path segment after /apps/ IS the app key.
  /apps/demo/...  → app key "demo"
- The ForwardAuth middleware extracts that key and runs decide(user, key)
  against Menagerai. No per-app rule beyond "this key maps to this backend".
- Onboard an app = insert an `apps` row with that key + point a Coolify
  service at it. The route and the authorization check follow from the key.
```

App keys are unique (see `apps.key` in the data model), so two apps can never claim the same subtree. Any key is legal — even `admin` or `api` — because it resolves to `/apps/admin`, never `/admin`.

### Prefix handling and base paths

Each app is configured to run under its full public base path `/apps/<key>` (e.g. Next.js `basePath`, FastAPI `root_path`, Vite `base`). The principle is to **not strip** the prefix before forwarding, so a base-path-aware app receives `/apps/<key>/...` and generates correct links and asset URLs.

**Operational reality (Coolify).** When the app's FQDN includes a path (`host/apps/<key>`), Coolify *auto-generates a `stripprefix` middleware* on the router. Two configurations work; pick by how the app consumes its base path:

```text
- No-strip (preferred, required for basePath/root_path frameworks):
  remove the auto-added "…-stripprefix" entry from the router's middleware
  chain. The app gets /apps/<key>/... intact; its basePath handles the rest.
- Keep-strip (fine for apps tolerant of a stripped path): the app routes at
  "/" and only re-adds the prefix when generating OUTBOUND URLs (as the demo
  app does via APP_BASE_PATH). A Next.js basePath app would 404 here — it
  expects the prefix inbound — so such apps must use no-strip.
```

**Middleware ordering invariant.** `menagerai-auth` (ForwardAuth) must be the **first** middleware in the chain — before any `stripprefix`/compression. ForwardAuth reports the request URI *as seen at its position in the chain* via `X-Forwarded-Uri`, and the gateway needs the full `/apps/<key>/...` path to extract the key and match `public_paths`. If `stripprefix` runs first, the gateway sees `/...` with the key gone and returns NOT_FOUND.

An app doing its own native OIDC registers its redirect URI as `https://app2.example.com/apps/<key>/callback` in Logto. Apps that let the gateway handle authentication need no callback of their own.

## The gateway terminates authentication

A single **gateway** (reverse proxy with ForwardAuth) sits at the root and is the only public entrypoint. App containers are never published directly — they listen only on the internal network the gateway shares with them. The gateway is responsible for **both**:

```text
authentication   "is this browser a signed-in user?"        (session cookie)
authorization    "is this user allowed to use THIS app?"     (Menagerai access check)
```

Apps behind the gateway do **not** detect cookies or talk to Logto themselves. They receive a request that has already been authenticated and authorized, plus trusted identity headers — the gateway injects exactly four: `X-Menagerai-User-Email`, `X-Menagerai-User-ID`, `X-Menagerai-Roles` (organizational role keys), and `X-Menagerai-Proxy-Secret` (Pattern B). Apps that need finer in-app authorization additionally call `/api/access/check` (Pattern A); apps with deep internal RBAC do that authorization themselves from these headers (email + organizational roles), not from any per-app role the gateway injects (Pattern C). The gateway is the gate in every case.

This replaces the "each app detects the presence/absence of a token and redirects itself" idea: that would make every app reimplement session validation, the Logto redirect dance, and the access check. Centralizing it in the gateway means one implementation, one cookie, one Logto client.

Candidate gateways: Traefik ForwardAuth, oauth2-proxy, nginx `auth_request`, Caddy, or a small custom service. The ForwardAuth target is a Menagerai endpoint (e.g. `GET /gateway/verify`) that reads the session cookie and returns `200` with `X-Menagerai-*` headers when allowed, or `302`/`401` otherwise.

## Coolify: separate deployments behind one Traefik

Each user app is its own independent Coolify deployment (own repo, image, and lifecycle). Menagerai is also just another Coolify deployment. They are tied together not by living in one project but by sharing **one Traefik** — Coolify's built-in proxy — and one host. The "gateway" is therefore not a separate box: it is Coolify's Traefik plus a ForwardAuth middleware (pointing at Menagerai's `/gateway/verify`) plus Menagerai itself owning the root paths.

First confirm the Coolify **server proxy is Traefik**, not Caddy: the ForwardAuth mechanism (`menagerai-auth@file` + a Traefik dynamic config) is Traefik-only. Coolify emits both `traefik.*` and `caddy_*` label sets on every app; only the active proxy's labels apply, so seeing `caddy_*` labels is normal.

To wire a new app, set four things so they agree:

```text
1. App base path = /apps/<key>           (basePath / root_path / base)
2. Coolify FQDN  = app2.example.com/apps/<key>   (host WITH a path, not a
                   subdomain). Coolify emits a PathPrefix(/apps/<key>) router
                   AND an auto stripprefix — see "Prefix handling" above for
                   whether to keep or remove it.
3. apps.key      = <key>                  (matches the path segment)
4. Attach menagerai-auth → in the app's Coolify "Labels" (Readonly OFF), add
                   `menagerai-auth@file` as the FIRST middleware on the HTTPS router:
                   traefik.http.routers.https-<id>.middlewares=menagerai-auth@file,<rest>
```

### No bypass route (the failure mode that matters)

By default Coolify wants to give each app its own public domain or exposed port. If an app has one, a user can reach it directly and skip the gateway — and thus the entire access check. The invariant:

```text
- Each app is reachable ONLY via app2.example.com/apps/<key>, through the
  ForwardAuth middleware.
- No second public FQDN, no published host port, no direct container access.
- ForwardAuth must be attached to EVERY app router. An app routed without the
  middleware is unauthenticated and wide open, regardless of the access model.
```

This is the multi-deployment form of "app containers are never published directly." It is an operational check on every app onboarding, not a one-time setup step.

**Detecting a missing middleware.** If `menagerai-auth` is not attached, Traefik never calls `/gateway/verify`, so Menagerai logs nothing for that app — the tell-tale sign. Meanwhile the app's own unauthenticated surface (a static SPA shell, `public_paths`) still serves, while its gated APIs reject the (header-less) request as 401. A browser SPA that reloads on 401 then loops. So: a gated app that loops with **no Menagerai gateway logs** ⇒ ForwardAuth isn't wired. Enable per-request logging with `GATEWAY_LOG=1` on Menagerai to watch each verdict (method, URI, nav/api, user, outcome+reason) while diagnosing.

## The cookie is ours, not Logto's

A common misconception: the browser does **not** carry a "Logto cookie" to `app2.example.com`. Logto's session cookie lives on Logto's own domain (the hosted sign-in host). The cookie checked on every app request is a session the **portal/Menagerai establishes** on the portal domain after a successful OIDC login.

```text
Logto session cookie      on Logto's domain   → enables silent SSO during login
Menagerai session cookie  on the portal host  → what the gateway checks each request
                                                (httpOnly, Secure, SameSite=Lax)
```

Logto's cookie only participates during the login redirect; it is invisible to the apps.

## End-to-end login + access sequence

A logged-out user deep-links straight to a protected app:

```text
 1. Browser → app2.example.com/apps/demo
 2. Gateway: no valid Menagerai session cookie
        → 302 to portal login, remembering the original URL (?next=/apps/demo)
 3. Portal begins OIDC → 302 to Logto hosted sign-in
 4. User authenticates at Logto.
        Logto sets ITS cookie on ITS domain, then 302 back to the portal
        callback with an authorization code.
 5. Portal callback:
        - exchanges code for ID/access tokens
        - verifies signature, issuer, audience, expiry
        - maps token `sub` → Menagerai user (must exist, status=active)
        - establishes the Menagerai session cookie on app2.example.com
        - 302 to the remembered `next` (/apps/demo)
 6. Browser → app2.example.com/apps/demo (now with a valid session)
 7. Gateway ForwardAuth → Menagerai derives app key "demo" from the path and
    runs decide(user, "demo")
        - ALLOW: forward to the Demo App + inject X-Menagerai-* headers
        - DENY : render the actionable "no access to this app" page
```

Opening a second app afterward skips steps 3–5 on the Logto side (its SSO cookie is still valid) and is effectively instant; the gateway still runs step 7's access check for the second app.

### Logout

Logout clears the Menagerai session cookie and redirects through Logto's end-session endpoint so the Logto SSO cookie is also cleared — otherwise the next login would silently re-establish a session.

## The `/gateway/verify` contract

The endpoint Traefik's ForwardAuth middleware calls on every request to `/apps/<key>/...`. It is the single place authentication and the per-app access check are decided. Traefik relays its response: on any non-2xx it returns the status, `Location`, and body to the client unchanged — which is exactly what makes both the browser-redirect and the API-401 flows work from one endpoint.

### Inputs (forwarded by Traefik)

The auth sub-request carries the original request's headers:

```text
Cookie             the Menagerai session cookie (identity)
X-Forwarded-Uri    original path+query → app key + app-relative path
X-Forwarded-Method GET/POST/... → method-scoped public-path match
X-Forwarded-Host   the portal host
X-Forwarded-Proto  https
Sec-Fetch-Mode     "navigate" for a browser navigation (forbidden header → trustworthy)
Accept             fallback navigation signal
```

### Browser vs API discrimination

```text
is_navigation =
    Sec-Fetch-Mode == "navigate"            (if present — modern browsers)
    else Accept contains "text/html"        (fallback)
    else false                              (ambiguous → treat as API)
```

A stray `302` corrupts an API client while a stray `401` is recoverable, so the ambiguous case defaults to API (401).

### Decision order

```text
1. Normalize X-Forwarded-Uri (URL-decode, collapse //, resolve .., trim
   trailing /). Extract app key from /apps/<key> and the app-relative path.
2. Unknown / disabled app key                  → NOT_FOUND
3. App-relative path matches apps.public_paths  → OK (anonymous, NO X-Menagerai-* headers)
   (default-deny, method-scoped — see data model `apps.public_paths`)
4. No / invalid / expired session cookie        → UNAUTH
5. decide(user, key)  (authorization-semantics §1)
        DENY  → FORBIDDEN
        ALLOW → OK (+ X-Menagerai-* headers)
```

### Response matrix

```text
outcome     browser (navigation)                  api (fetch / xhr)
----------  ------------------------------------  ---------------------------------
OK          200 + X-Menagerai-User-Email, -User-ID,   same
            -Roles, -Proxy-Secret
UNAUTH      302 → /login?next=<original-url>       401 {"error":"unauthenticated",
                                                        "login_url":"/login?next=…"}
FORBIDDEN   302 → /no-access?app=<key>             403 {"error":"forbidden",
                                                        "app":"<key>"}
NOT_FOUND   404 no-such-app page                   404 {"error":"unknown_app"}
```

A logged-in user denied an app is redirected to the portal's `/no-access?app=<key>` page (nav back to their launcher), not shown an inline gateway page. Public-path OK responses carry **no** identity headers; the app must treat them as anonymous.

`X-Menagerai-Proxy-Secret` is the target app's own `proxy_secret` (from its `apps` doc), injected only on authenticated OK responses. The app validates it before trusting the other `X-Menagerai-*` headers — defense in depth against a request that reaches the app without traversing the gateway. See the per-app secret rationale in [`rbac-and-data-model.md`](rbac-and-data-model.md) and the header-trust layers in [`app-integration-patterns.md`](app-integration-patterns.md).

### Usage recording (side-effect of OK)

On an authenticated ALLOW only, the gateway records one **DAU** for `(user, app)` — a `usage_daily` row keyed by the business day (in `TIMEZONE`). It is fire-and-forget and best-effort (never blocks or fails the auth response), and an in-process dedup set means at most one write per user/app/day. Public/anonymous and forbidden outcomes are **not** counted (this is the single enforcement point; previews like the launcher and `/api/access/check` don't record). These rows feed the admin "apps used most" / "power users" stats and the activity heatmap. See [`rbac-and-data-model.md`](rbac-and-data-model.md) § `usage_daily`.

### Session cookie

```text
name        menagerai_session   (opaque session id; the session doc lives in MongoDB)
flags       HttpOnly; Secure; SameSite=Lax; Path=/; Domain=<portal host>
idle TTL    8 hours  (sliding — renewed on activity, at most once per ~5 min)
absolute    7 days   (hard cap regardless of activity)
expired     treated as UNAUTH
```

`SameSite=Lax` lets the post-login top-level redirect carry the cookie while blocking cross-site sends. Sessions are **server-side**: the cookie holds only an opaque id, the session document lives in MongoDB with a TTL index. This makes sliding expiry and **forced logout on offboarding** trivial (delete the session doc) — a stateless signed cookie could not be revoked. The per-request lookup cost is absorbed by the decision cache below.

Defaults assume normal business sensitivity. Re-login within these windows is silent while the Logto SSO session (set longer, ~14 days) is still valid, so the Menagerai session can be short without friction. For sensitive/admin deployments, tighten to idle 30–60 min / absolute 8–12 h.

Because authorization is re-evaluated per request (below), session length is **decoupled from offboarding speed**: a disabled user holding a still-valid session is denied at the `decide()` layer within the decision-cache window regardless of how long the session lasts.

### Security requirements

```text
- Normalize the path BEFORE key extraction and public-path matching, or encoded
  traversal (/apps/x/..%2f..%2fadmin) can dodge the rules.
- public_paths is opt-in and default-deny; never a broad /** unless the app is
  intentionally fully public.
- "Public" skips Menagerai auth only — public endpoints (e.g. webhooks) must still
  verify their own caller (signature/HMAC) inside the app.
- Validate `next`: same-host relative paths under /apps/... or / only; never
  honor an absolute or cross-host target (open-redirect).
```

### One policy location

Every request to `/apps/<key>` passes through this middleware and all public-path policy is the per-app `public_paths` allowlist evaluated here. There is **no** Traefik-level bypass router: one auditable policy location, and the auth hop on public paths is negligible.

## Freshness

Two independent cache layers, for two different callers:

```text
Gateway decision cache   covers the ForwardAuth hot path — EVERY request to
                         /apps/<key> (assets, XHR, ...). Without it, decide()
                         (~3 Mongo reads) would run hundreds of times per page.
  key   (session_id, app_key)
  TTL   30 seconds  (in-process LRU; no Redis needed for a single Menagerai instance)
  evict proactively drop a user's entries on disable / grant change, so
        offboarding is instant rather than waiting out the TTL
  also  caches the cheap results too — public-path matches, unknown-app,
        and the session→user resolution

App-side check cache     for apps that call /api/access/check themselves
                         (Patterns A/C). TTL 1–5 min; see
                         [`authorization-semantics.md`](authorization-semantics.md) §3.
```

The two don't stack — each governs its own path. Worst-case staleness for proxy-gated access is the 30 s gateway TTL; a revoked grant, per-user deny, or disabled user takes effect everywhere within that window (immediately, with proactive eviction) without token-revocation machinery. If Menagerai is later run as multiple replicas, the gateway cache becomes per-replica (≤ TTL staleness) or moves to Redis — a scaling optimization, not a day-one need.

## Single-host vs subdomain (recorded decision)

A subdomain-per-app topology (`demo.app2.example.com`) was considered. It lets each app run at "/" unchanged (no base-path work) but requires a wildcard certificate and a session cookie scoped to the parent domain. The single-host subfolder topology was chosen for cookie/TLS simplicity, accepting the per-app base-path requirement as the trade-off. If a future app genuinely cannot run under a base path, revisiting per-app subdomains for that app is the escape hatch.
