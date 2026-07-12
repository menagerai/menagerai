# Deploy & Bootstrap Runbook

Order: **Logto setup → deploy Menagerai → bootstrap (seed) → gateway middleware → wire demo → verify**. Steps marked 🧑 are yours to run (Coolify / Logto console); the rest is automated.

`portal.example.com` below is only an example — the portal host is fully configurable (`PORTAL_BASE_URL`). One deployment can also answer on **several interchangeable hostnames** (e.g. `app.example.com`, `app2.example.com`); separation between them is cosmetic — all apps are reachable under any host, and real access control is Menagerai's roles/grants. The host allowlist (used to keep redirects on the host you're browsing, and reject injected Host headers) is derived automatically from the deployment's own domains (`COOLIFY_FQDN`) plus `PORTAL_BASE_URL`, with `PORTAL_HOSTS` as an optional explicit addition.

## 1. 🧑 Logto console

1. **Create the portal web app**: Applications → Create → **Traditional Web**.
   - Redirect URIs: add `https://<host>/callback` for **every** host the portal answers on (e.g. `https://portal.example.com/callback`, `https://app.example.com/callback`, `https://app2.example.com/callback`). A shared Logto tenant happily holds multiple callbacks.
   - Post sign-out redirect URIs: add `https://<host>/` for each host.
   - Copy **App ID** and **App secret**; note the tenant **endpoint** (`https://<tenant>.logto.app`).
2. **Ensure the superadmin can sign in**: confirm a Logto user exists for `admin@example.com` (create it if not) with a verified email / working password.
3. **Create a Machine-to-Machine** app (or use existing, each Logto tenant comes with one) and grant it the **Logto Management API** role.
   - Copy its App ID/secret and the Management API resource (`https://<tenant-id>.logto.app/api` or `https://default.logto.app/api`).
   - Without this, Menagerai admin can manage its own records but cannot create/suspend users *in Logto*. The superadmin login does not need it.

> **ID-token signing algorithm.** Logto signs ID tokens with **ES384** by default, not RS256. Menagerai expects ES384 out of the box (`LOGTO_ID_TOKEN_ALG` overrides it). If sign-in ever fails with `unexpected JWT alg received, expected RS256, got: ES384` after a Logto change, set `LOGTO_ID_TOKEN_ALG` to match the tenant.

## 2. 🧑 Deploy Menagerai on Coolify

1. New application → this repo → **Dockerfile** build pack.
2. Domains: add every portal host, comma-separated (e.g. `portal.example.com,app.example.com,app2.example.com`), root path. Application port: `3000`. The host allowlist auto-derives from these (`COOLIFY_FQDN`) — no need to also list them in `PORTAL_HOSTS`.
3. Environment variables:
   ```
   PORTAL_BASE_URL=https://portal.example.com   # canonical/fallback host
   # PORTAL_HOSTS=...                       # optional extra hosts not set as Coolify domains
   SQLITE_PATH=/app/data/menagerai.db     # primary store — put /app/data on a volume
   # MONGODB_CONN_STR=mongodb://...        # optional: use MongoDB instead of SQLite
   COOKIE_SECURE=true
   SUPERADMIN_EMAIL=you@yourco.com    # the first admin — pin it here (must also exist in Logto)
   # --- Logto: ALL REQUIRED, validated at boot (OIDC discovery + an M2M token + one
   #     Management API read). If any is missing/unreachable the app serves a
   #     "Configuration required" screen and seeds nothing until they all pass. ---
   LOGTO_ENDPOINT=https://<tenant>.logto.app
   LOGTO_APP_ID=...
   LOGTO_APP_SECRET=...
   LOGTO_M2M_APP_ID=...                          # Management API (M2M) app — lets Menagerai
   LOGTO_M2M_APP_SECRET=...                       #   provision users into Logto when you add them
   LOGTO_MANAGEMENT_API_RESOURCE=https://<tenant>.logto.app/api
   # optional — usage stats (defaults shown):
   TIMEZONE=UTC                 # business-day boundary for DAU counting
                                #   (defaults to UTC, falling back to the container TZ)
   USAGE_TOP_LIMIT=10           # rows in "most used apps" / "power users"
   USAGE_HEATMAP_DAYS=365       # activity-heatmap window
   # GATEWAY_LOG=1              # log every /gateway/verify decision (debugging)
   # --- gateway verify isolation (see §4) ---
   GATEWAY_PUBLIC=false         # secure end-state: serve verify ONLY on the
                                #   internal port, not the public app. Leave unset
                                #   (defaults true) during the additive migration.
   # GATEWAY_PORT=3001          # internal-only verify port (default 3001); the
                                #   Dockerfile already sets this — no FQDN routes to it.
   ```
4. Deploy. Health check is `GET /healthz` (port 3000). A fresh install can set `GATEWAY_PUBLIC=false` from the start; an existing deployment migrates with no downtime per §4 "Migrate an existing deployment".

> **Data store.** The default is SQLite — a single file at `SQLITE_PATH`. Mount a persistent volume at its directory (e.g. `/app/data`) so it survives redeploys; the file and its parent dir are created on first run. To use MongoDB instead, set `MONGODB_CONN_STR` (and optionally `MONGODB_DB`); `SQLITE_PATH` is then ignored. No replica set is required for either backend.

## 3. First-run bootstrap (automatic — no wizard)

Configuration is env-only; there is no `/setup` step. On startup Menagerai validates the required env (`PORTAL_BASE_URL`, `SUPERADMIN_EMAIL`, and all six `LOGTO_*`) **and** the live Logto connections (OIDC discovery, an M2M token, and one authenticated Management API call), then:

- **All valid** → it idempotently seeds the `SUPERADMIN_EMAIL` admin (email allow-rule
  + `system_admin` role, unlinked) and a `demo` app on every boot. Open the site and **sign in via Logto** as the superadmin — that first sign-in claims the seeded account. That's it.
- **Anything missing / unreachable** → the app still boots (`/healthz` stays green, so no crash-loop) but every page serves a **"Configuration required"** screen naming exactly which var is unset, malformed, or rejected by Logto. Fix it in Coolify and redeploy (env is read only at startup).

Make sure a user with `SUPERADMIN_EMAIL` exists in Logto (step 1) — or enable self-registration for that address — so the claim sign-in succeeds.

**Scripted equivalent:** with the env set, `npm run seed` in the container does the same idempotent seed (superadmin + `demo` app) and prints the demo `MENAGERAI_PROXY_SECRET`.

**Break-glass recovery:** if the superadmin is locked out (lost account, IdP migration), run `npm run relink -- <email>` in the container. It clears the account's IdP link and re-ensures `system_admin`, so it can be re-claimed on the next sign-in — the credential-free equivalent of a password reset.

## 4. 🧑 Gateway ForwardAuth middleware (Traefik dynamic config)

First confirm **Coolify → Server → Proxy** is **Traefik** (not Caddy). This whole mechanism is Traefik-only — `menagerai-auth@file` and this dynamic config don't exist under Caddy. Coolify emits *both* `traefik.*` and `caddy_*` labels on every app; only the labels for the active proxy are used, so the presence of `caddy_*` labels is normal and irrelevant when the proxy is Traefik.

Coolify → Server → Proxy → Dynamic Configurations → add `menagerai-auth.yaml`:

```yaml
http:
  middlewares:
    menagerai-auth:
      forwardAuth:
        address: 'http://menagerai:3001/gateway/verify'
        trustForwardHeader: true
        authResponseHeaders:
          - X-Menagerai-User-Email
          - X-Menagerai-User-ID
          - X-Menagerai-Roles
          - X-Menagerai-Proxy-Secret
```

`address` must use a **stable internal service/network alias** (here `menagerai`), **not** a pinned per-deploy container name — a fixed `container_name` forces stop-then-start and breaks zero-downtime, dropping ForwardAuth (→ 5xx on every gated app) mid-redeploy. Drop the fixed name and enable Coolify's zero-downtime deploy. Confirm the exact alias Coolify exposes for the service.

**Port `3001` is the dedicated internal-only verify port.** `/gateway/verify` returns the target app's `X-Menagerai-Proxy-Secret` as a response header on allow, so it must never be reachable from the internet. The portal serves verify on `3001`, which **no FQDN/domain routes to** (Coolify publishes only the app port, `3000`) — so do **not** add a domain or port mapping for `3001`; leaving it unpublished is what keeps it internal. With `GATEWAY_PUBLIC=false`, the public app on `3000` stops serving verify entirely, so the only way to reach it is from inside the Docker network — exactly this middleware.

> **Multi-domain / CORS:** ForwardAuth is a server-side Traefik→portal sub-request the browser never sees, so CORS does not apply — pointing `menagerai-auth` at one canonical internal alias is fine for apps served on any portal domain. Verify recognizes the user from the forwarded `Cookie` + `X-Forwarded-Host` (host-independent session lookup), so the verify host is irrelevant to identity.

> Fallback only if no internal alias is reachable: the public `https://portal.example.com/gateway/verify`. This re-exposes the secret-harvest surface and is **not** recommended — and it requires `GATEWAY_PUBLIC=true`.

### Migrate an existing deployment (zero-downtime: +3001 → switch → −3000)

If verify is currently served publicly on `3000` and the middleware targets it, migrate without an outage — never remove a serving path before the replacement is in use:

1. **+3001 (additive):** deploy the current Menagerai image **without** setting `GATEWAY_PUBLIC` (defaults true). The container now listens on `3000` (public, still serving verify) **and** `3001` (internal). The middleware still targets `:3000` → no change, no outage.
2. **Switch:** edit this `address` to `http://menagerai:3001/gateway/verify`. Traefik hot-reloads the dynamic config (no app restart). Verify a gated app still returns 200/302 (tail it under load with `GATEWAY_LOG=1`).
3. **−3000:** set `GATEWAY_PUBLIC=false` on Menagerai and redeploy/restart. The public app now 404s `/gateway/verify`; only the unrouted `:3001` serves it. Reversible by flipping the env back.

### Recommended end-state: split the verifier into its own container

`/gateway/verify` is on the hot path of **every request to every managed app**, and it runs on Node's single event loop. In the all-in-one topology it shares that loop with the admin/portal UI — so a CPU-heavy admin action (e.g. the XLSX user import) can stall verification for the whole fleet. The image ships **two extra entrypoints** so you can run the verifier as its own process, fully isolated:

- `npm run start:web` → `dist/server-web.js` — the public portal/admin app only (port `3000`). It does **not** open the internal verify listener.
- `npm run start:gateway` → `dist/server-gateway.js` — the ForwardAuth verifier only (port `3001`). No admin/portal code shares its event loop.

Deploy them as **two Coolify services from the same image**:

| Service | Start command | Ports | Env |
|---|---|---|---|
| `menagerai-web` | `node dist/server-web.js` | `3000` (public FQDN) | `GATEWAY_PUBLIC=false` |
| `menagerai-verify` | `node dist/server-gateway.js` | `3001` (unpublished, internal only) | — |

Point the `menagerai-auth` middleware `address` at `http://menagerai-verify:3001/gateway/verify`. Both processes share the same store. The verifier is stateless (only short-lived in-process caches), so it can be scaled to N replicas behind the internal alias.

> **Store choice for split/multi-replica topologies.** With the SQLite backend, every process must reach the **same** database file — mount one shared volume across the web and verify services (fine on a single host; awkward across hosts). If you split across hosts or run many replicas, use the MongoDB backend (`MONGODB_CONN_STR`), which is networked. The all-in-one `node dist/server-all.js` on one host with a local SQLite file is the simplest topology.

> **Cache invalidation across replicas:** the app-registry / decision / user caches are per-process, evicted instantly within the process that made an admin change but not across other replicas — bounded by the 30 s (`DECISION_CACHE_TTL_MS` / `APP_CACHE_TTL_MS`) and 5 s (`USER_CACHE_TTL_MS`) TTLs. Running a **single** verify replica avoids the staleness window entirely; for multi-replica, a follow-up can add a MongoDB change-stream to broadcast eviction. The `start:web` app still hosts admin mutations, so its own caches evict immediately — only cross-replica verify caches lag.

> **`authResponseHeaders` must list all four** `X-Menagerai-*` headers — especially `X-Menagerai-Proxy-Secret`. These are the only response headers Traefik copies from the ForwardAuth reply onto the request it forwards to the app. Omit `X-Menagerai-Proxy-Secret` and the app receives no secret, rejects every authenticated call as 401, and a browser SPA can spin in a reload loop (see Troubleshooting). Referenced from a router as `menagerai-auth@file` (the `@file` suffix = "defined by the file provider").

## 5. 🧑 Wire demo and redeploy

On the existing demo Coolify app:

1. **FQDN** → `portal.example.com/apps/demo` (host WITH path → Coolify emits a `PathPrefix(/apps/demo)` router).
2. **Env**: `APP_BASE_PATH=/apps/demo`, `MENAGERAI_PROXY_SECRET=<from step 3>`. The secret must equal the value shown at `/admin/apps/demo` in Menagerai.
3. **Attach the middleware** — Coolify → the app → **Labels**. Turn **Readonly OFF** so the label block is editable, then add `menagerai-auth@file` to the **HTTPS** router's middleware chain, **as the first entry**:
   ```
   # before
   traefik.http.routers.https-<id>.middlewares=https-<id>-stripprefix,gzip
   # after  (menagerai-auth FIRST)
   traefik.http.routers.https-<id>.middlewares=menagerai-auth@file,https-<id>-stripprefix,gzip
   ```
Order matters: ForwardAuth reports the request URI *as it sees it in the chain* via `X-Forwarded-Uri`. It must run **before** any `stripprefix`, or the gateway sees `/api/...` (prefix gone) instead of `/apps/demo/api/...` and can't identify the app (→ 404). Use the exact router name from the `.rule=` line; append comma-separated if a `.middlewares=` already exists. 4. **Prefix stripping.** Coolify auto-adds a `stripprefix` middleware for a path-based FQDN. The demo app tolerates it (it routes at root and only re-adds the prefix for outbound links via `APP_BASE_PATH`), so you can leave it. Apps that expect the full path inbound (Next.js `basePath`, FastAPI `root_path`) will 404 with stripping — for those, remove the `…-stripprefix` entry from the chain so the app receives `/apps/<key>/...` intact. Either way, `menagerai-auth@file` stays first. 5. **No bypass**: remove any second public FQDN / exposed port — reachable only through the gateway. 6. **Redeploy** (labels apply on redeploy; confirm Readonly stayed off).

## 6. Verify end-to-end

```
[ ] Public, no login:  GET https://portal.example.com/apps/demo/api/public/<key>  → 200
[ ] Logged out, browser → /apps/demo → redirected to Logto, then back, then app
[ ] Spoof blocked:     curl -H 'X-Menagerai-User-Email: x' .../apps/demo/api/tree  → 401
                       (no proxy secret ⇒ demo rejects)
[ ] Superadmin sees Demo App on the launcher and can use it
[ ] Disable a test user in /admin → their /apps/demo access dies within ~30s
```

Tip: set `GATEWAY_LOG=1` on Menagerai and watch its container logs while you click through. Each gated request prints one line, e.g. `[gateway] GET /apps/demo/api/me (api) user=admin@example.com -> 200 allow (allow_role)`. Seeing these lines at all proves the ForwardAuth middleware is attached.

## 7. Troubleshooting

**Symptom → likely cause.** Most issues are gateway wiring, not code.

```text
SYMPTOM                                        LIKELY CAUSE / FIX
Endless redirect loop, "logged in", and        ForwardAuth not attached to the app
  NO lines in Menagerai logs                     router. Traefik never calls
                                                  /gateway/verify, so no identity is
                                                  injected: the (static) app shell
                                                  loads unauthenticated but its gated
                                                  API 401s and the SPA reloads forever.
                                                  → §5 step 3 (attach menagerai-auth@file).
Gateway logs show 404 not-a-app-path for a      menagerai-auth ordered AFTER stripprefix,
  /apps/<key>/... request                         so it sees the stripped path. Move
                                                  menagerai-auth FIRST in the chain (§5.3).
Page loads but every API call is 401            App not receiving X-Menagerai-Proxy-Secret:
  (gateway logs show 200 allow)                   authResponseHeaders missing it (§4),
                                                  or MENAGERAI_PROXY_SECRET != apps.proxy_secret
                                                  (re-copy from /admin/apps/<key>).
Browser redirected to /no-access?app=<key>      Authenticated but not granted. Give the
  (gateway logs: 403 forbidden)                   user a role granting the app, or a
                                                  per-user allow override.
Sign-in fails: "unexpected JWT alg ...          Logto signs ES384; set
  expected RS256, got ES384"                      LOGTO_ID_TOKEN_ALG=ES384 (default; §1).
Nothing works and labels look ignored           Server proxy is Caddy, not Traefik —
                                                  menagerai-auth@file/dynamic config don't
                                                  apply. Switch the proxy or rework (§4).
```

**Fast probes** (grab `menagerai_session` from the browser, then):

```text
# Identity reaching the app?  401 unauth = no/*wrong* proxy secret;
# 403 forbidden = role/grant; 200 = fine.
curl -i -H 'Cookie: menagerai_session=<value>' https://<host>/apps/<key>/api/me

# A public path needs NO auth at all:
curl -i https://<host>/apps/<key>/<public-path>          # → 200

# Watch decisions live:
#   set GATEWAY_LOG=1 on Menagerai, tail its container logs.
```

Also use the browser **DevTools → Network with "Preserve log" on** to see the full 302 chain and each hop's `Location`/status — the loop becomes obvious.
