# Menagerai demo

A throwaway, self-resetting public demo of the portal — **the whole stack in one deployment**: the portal + three mock apps, wired through the real ForwardAuth gateway using the **host platform's own Traefik** (Coolify's — no nested proxy). It is not a simulation: every request to a mock app really passes `Traefik → portal /gateway/verify → identity headers → app`, and each app validates its per-app proxy secret before trusting the forwarded identity.

Sign-in is a **persona picker** (no Logto, no passwords). The database wipes back to a fixed seed `DEMO_LIMIT_MINS` minutes after the first sign-in, so visitors can't durably break anything.

> **Domain layout.** This compose is the **demo**, meant for `demo.<your-domain>`. The project's public landing site is a **separate**, standalone deployable in [`www/`](./www) (root + `www.` of your domain) — kept out of this compose on purpose so the site stays up when the demo stack redeploys.

## Personas

Each persona's app launcher looks different — that's the point: it shows every branch of the access model at a glance.

| Persona (sign in as) | Roles | Overrides | Sees | Demonstrates |
|---|---|---|---|---|
| **Ada** (superadmin) | system_admin, analyst, editor, support | — | Pulse, Wiki, Desk + admin panel | superadmin + multi-role |
| **Bo** | analyst | — | Pulse only | one role grant; default-deny elsewhere |
| **Cam** | editor | allow **desk** | Wiki, Desk | per-user allow override |
| **Dee** | support | deny **wiki** | Desk only | per-user deny beating a role grant |

Apps: **Pulse Analytics** (`pulse`), **Aviary Wiki** (`wiki`), **Perch Desk** (`desk`). Their UI is fake; the identity card at the top of each is the real payload — it echoes the `X-Menagerai-*` headers the gateway injected.

## Run locally (one command)

Locally there is no platform Traefik, so add the override (a throwaway Traefik + the portal's `/` router that Coolify otherwise generates from the FQDN):

```sh
cp demo/.env.example demo/.env      # set DEMO_SECRET (>=16 chars)
docker compose -f demo/docker-compose.yml -f demo/docker-compose.override.yml up --build
# open http://localhost  → pick a persona
```

Everything is in-container and ephemeral — nothing is persisted on purpose.

## Deploy on Coolify (one resource, one domain)

Coolify's own Traefik serves the whole stack from the labels in `demo/docker-compose.yml`. Point DNS for `demo.<your-domain>` at Coolify first.

1. **New resource → Docker Compose**, pointed at this repo, compose path `demo/docker-compose.yml`.
2. **Domains — set ONE:** give the **`portal`** service the domain `https://demo.<your-domain>`. Leave **`pulse` / `wiki` / `desk` blank** — they are reached only at `/apps/<key>` through the gateway, never on their own URL. (The portal's FQDN issues the TLS cert and routes `/`; the app label routers share that host under `/apps/*`.)
3. **Turn ON "Connect To Predefined Network"** for the resource, so Coolify's Traefik reads the app routers' labels and can reach the portal for ForwardAuth.
4. Environment: `DEMO_SECRET` = a random string (≥16 chars; `openssl rand -hex 24`); `PORTAL_BASE_URL` = `https://demo.<your-domain>`; `COOKIE_SECURE=true` (you're on https); `DEMO_LIMIT_MINS` = reset window (default 10).
5. Deploy. No per-app domains, no secret copying — the apps derive their proxy secret from `DEMO_SECRET`, the same way the portal does.

**Per-service URL, at a glance:**

| Service | Coolify domain |
|---|---|
| `portal` | `https://demo.<your-domain>` |
| `pulse` / `wiki` / `desk` | *(blank — routed at `/apps/<key>` by labels)* |

> If a mock app loads over HTTP instead of HTTPS, add `traefik.http.routers.<key>.tls=true` to that service's labels (some Coolify setups don't default the label routers to the TLS entrypoint). If ForwardAuth can't reach `portal` by name, set `GATEWAY_PUBLIC=true` and point the middleware `address` at `https://demo.<your-domain>/gateway/verify` instead.

## How the reset works

- The timer is **armed by the first sign-in** after each reset, then fires after `DEMO_LIMIT_MINS`. An idle demo (nobody signs in) never churns.
- On reset every collection is wiped and reseeded to the personas/apps above; live sessions die, so everyone lands back on the picker. The banner counts down and auto-reloads.
- A container restart also comes up freshly seeded (the in-memory timer resets).

`GET /demo/status` → `{ "demoMode": true, "resetAt": <epoch-ms|null> }`.

## Notes

- Requires the default `server-all` entrypoint (the reset timer lives in that one process). The split `server-web`/`server-gateway` topology is not for demo mode.
- Visitors signed in as **Ada** have full admin power (create users, regenerate secrets, delete personas). That's intentional — the reset bounds any damage to `DEMO_LIMIT_MINS`, and the seed's deterministic secrets self-heal on reset.
- Changing personas/apps: edit `src/demo/seed.ts` (the seed) — the apps and the access matrix live there.

## Deploying a mock app standalone (advanced)

The apps also run as independent services if you'd rather wire them the production way (separate Coolify apps, per DEPLOY.md §5). Build one with the shared Dockerfile and set the secret explicitly instead of deriving it:

```sh
docker build -f demo/apps/Dockerfile --build-arg APP=pulse -t demo-pulse demo/apps
docker run -e MENAGERAI_PROXY_SECRET=<the app's secret from /admin/apps/pulse> \
           -e APP_BASE_PATH=/apps/pulse -p 3000:3000 demo-pulse
```

`DEV_TRUST=1` injects a fake identity so an app renders without any gateway.
