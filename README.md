<div align="center">

# Ménagerai — Taming your wild, vibe-coded apps 

<img src="public/menagerie_icon_1024.png" alt="Menagerai logo" width="384" />

**The open-source portal for your vibe-coded apps — one login, per-app access control, and usage analytics for every app you deploy.**

You shipped fifteen AI-generated internal apps. Menagerai puts them all behind one login, with per-app permissions and usage visibility — on your own infrastructure.

[![CI](https://github.com/menagerai/menagerai/actions/workflows/ci.yml/badge.svg)](https://github.com/menagerai/menagerai/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

## What it is

The "vibe-coding" era made it trivial to ship internal apps — Lovable, Bolt, Replit, v0, or plain `docker compose up`. It did nothing to answer the questions that follow:

- Who is allowed to open each app?
- How do people sign in **once** instead of per app?
- Is anyone actually *using* the thing we built?

Menagerai is the governance layer that answers all three. It is **not** another auth tool — the incumbents own "authentication." Menagerai owns the portal, the per-app authorization, and the usage analytics, and it delegates authentication to the OIDC-certified identity provider you already trust.

## The four capabilities

No other open-source project combines all four. That is the whole point.

| | Menagerai | Auth gateways<br>(Authelia, authentik…) | Dashboards<br>(Homarr, Homepage) | PaaS<br>(Coolify, Dokploy) |
|---|:---:|:---:|:---:|:---:|
| **App launcher portal** — one home for every app | ✅ | ❌ | ✅ | ❌ |
| **SSO enforcement on arbitrary deployed apps** | ✅ | ⚠️ own UI only | ❌ links only | ❌ |
| **Per-app RBAC managed in a UI** | ✅ | ⚠️ config files | ❌ | ❌ |
| **Per-user / per-app usage analytics** | ✅ | ❌ | ❌ | ❌ |

The **usage analytics** — a GitHub-style activity heatmap, power users, most-used apps — is the standout: it answers the manager's question ("is anyone using what we vibe-coded?") that pure-auth tools structurally cannot.

## How it works

```text
Your IdP proves identity.        (bring your own OIDC provider — Logto supported today)
Menagerai decides authorization. (default-deny RBAC, managed in a UI)
Your apps enforce access.        (a ForwardAuth gateway injects trusted identity headers)
```

- **Single sign-on** across every app behind the gateway, backed by your OIDC provider.
- **Default-deny authorization**: status → user-deny → user-allow → role-allow.
- **A ForwardAuth gateway** (Traefik today; more gateways over time) that authenticates and authorizes every request to a protected app and injects trusted identity headers.
- **An admin UI** for users, roles, apps, access rules, an audit log, and the usage
  dashboard.
- **Works with the stack you already run** — bring your own OIDC provider and PaaS.

<p align="center">
  <img src="public/top_apps.png" alt="Usage analytics — most-used apps and active users" width="640" />
</p>

## Quickstart

**We strongly recommend [Coolify](https://github.com/coollabsio/coolify)** （open source) to self-host both the Menagerai platform and the vibe-coded apps you put behind it. This documentation is written with Coolify in mind; compatibility with other hosting platforms is untested and therefore not guaranteed.

Menagerai delegates authentication to **[Logto](https://github.com/logto-io/logto)** (cloud or self-hosted, open source), so you bring a Logto tenant and hand Menagerai six values. The app boots either way — if anything is missing or unreachable it serves a **configuration screen naming exactly what to fix**, so there is nothing to guess.

**1. In your Logto console, create two apps and one user:**

- A **Traditional Web** (OIDC) app for the portal → copy its **App ID** and **App secret**, and set its **Redirect URI** to `https://YOUR-PORTAL/callback`.
- A **Machine-to-Machine** app → copy its **App ID** and **App secret**, grant it the **Logto Management API access** role, and note the Management API **resource** URL (e.g. `https://your-tenant.logto.app/api`). This lets Menagerai create Logto accounts for users you add in the portal — no manual Logto steps afterward.
- Ensure your admin email exists as a **user** in Logto (or enable self-registration).

**2. Configure Menagerai:**

```bash
cp .env.example .env
```

Fill in the required values:

```ini
PORTAL_BASE_URL=https://YOUR-PORTAL          # or http://localhost:3000 for local
SUPERADMIN_EMAIL=you@yourcompany.com         # must also exist in Logto
LOGTO_ENDPOINT=https://your-tenant.logto.app
LOGTO_APP_ID=...
LOGTO_APP_SECRET=...
LOGTO_M2M_APP_ID=...
LOGTO_M2M_APP_SECRET=...
LOGTO_MANAGEMENT_API_RESOURCE=https://your-tenant.logto.app/api
```

(For a local `http://localhost` run, also set `COOKIE_SECURE=false`.)

**3. Run it:**

```bash
docker compose up -d --build
```

Open `PORTAL_BASE_URL` and sign in as `SUPERADMIN_EMAIL`. On the first valid startup Menagerai seeds your superadmin and a demo app, and your first sign-in claims the admin. Add further users right in the portal — with the Management API configured they are provisioned into Logto automatically.

> Seeing a **"Configuration required"** screen? It lists each setting that is unset or that Logto rejected (missing var, bad URL, wrong M2M role…). Fix your `.env`, then run `docker compose up -d` again — settings are read only at startup.

**Deploying for real?** See the [**Deployment & Bootstrap Runbook**](./DEPLOY.md) for the full production setup on Coolify — not just deploying Menagerai itself, but also **how to bring your own apps under its gateway** (per-app access control, trusted identity headers, and end-to-end verification).

## Design & architecture

The system is documented in depth. These design docs are being published alongside the code and double as the "how to onboard a vibe-coded app in 10 minutes" guide.

## What this is *not*

Scope discipline keeps an access-control plane trustworthy:

- **Not an identity provider.** We never store credentials — authentication is delegated to a certified OIDC IdP. That is a security feature, not a gap.
- **Not multi-tenant.** One deployment = one organization. For self-hosted white-label that is the honest, simple architecture.
- **Not a PaaS.** Menagerai governs the apps you deploy; it does not deploy them.

## Roadmap

- **Now** — one-command `docker compose up` quickstart, env-validated startup with a self-explaining config screen, and a seeded demo app (all in this repo).
- **Next** — a Coolify one-click template and a hosted live demo instance.
- **Then** — broader provider support (more gateways, identity providers, and database options over time) behind the existing pluggable abstractions. Storage runs on a bundled **SQLite** file by default, with **MongoDB** as a pluggable alternative today.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](./SECURITY.md) (please do not open a public issue).

## License

Menagerai is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE). The AGPL keeps the project and its network-hosted derivatives open. For commercial licensing enquiries, open a discussion.
