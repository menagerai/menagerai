<div align="center">

# Menagerai

**The open-source portal for your vibe-coded apps — one login, per-app access control, and usage analytics for every app you deploy.**

You shipped fifteen AI-generated internal apps. Menagerai puts them all behind one
login, with per-app permissions and usage visibility — on your own infrastructure.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

> **🚧 Early access.** The engine behind Menagerai runs in production internally today.
> We're preparing the public codebase — hardening the docs and building the one-command
> quickstart. **Star or watch** to follow the launch. Issues and discussions are open.

## What it is

The "vibe-coding" era made it trivial to ship internal apps — Lovable, Bolt, Replit,
v0, or plain `docker compose up`. It did nothing to answer the questions that follow:

- Who is allowed to open each app?
- How do people sign in **once** instead of per app?
- Is anyone actually *using* the thing we built?

Menagerai is the governance layer that answers all three. It is **not** another auth
tool — the incumbents own "authentication." Menagerai owns the portal, the per-app
authorization, and the usage analytics, and it delegates authentication to the
OIDC-certified identity provider you already trust.

## The four capabilities

No other open-source project combines all four. That is the whole point.

| | Menagerai | Auth gateways<br>(Authelia, authentik…) | Dashboards<br>(Homarr, Homepage) | PaaS<br>(Coolify, Dokploy) |
|---|:---:|:---:|:---:|:---:|
| **App launcher portal** — one home for every app | ✅ | ❌ | ✅ | ❌ |
| **SSO enforcement on arbitrary deployed apps** | ✅ | ⚠️ own UI only | ❌ links only | ❌ |
| **Per-app RBAC managed in a UI** | ✅ | ⚠️ config files | ❌ | ❌ |
| **Per-user / per-app usage analytics** | ✅ | ❌ | ❌ | ❌ |

The **usage analytics** — a GitHub-style activity heatmap, power users, most-used
apps — is the standout: it answers the manager's question ("is anyone using what we
vibe-coded?") that pure-auth tools structurally cannot.

## How it works

```text
Your IdP proves identity.        (bring your own OIDC — Logto, authentik, Zitadel, Keycloak, Entra…)
Menagerai decides authorization. (default-deny RBAC, managed in a UI)
Your apps enforce access.        (a ForwardAuth gateway injects trusted identity headers)
```

- **Single sign-on** across every app behind the gateway, backed by your OIDC provider.
- **Default-deny authorization**: status → user-deny → user-allow → role-allow.
- **A ForwardAuth gateway** (Traefik today; nginx/Caddy planned) that authenticates and
  authorizes every request to a protected app and injects trusted identity headers.
- **An admin UI** for users, roles, apps, access rules, an audit log, and the usage
  dashboard.
- **Works with the stack you already run** — bring your own OIDC provider and PaaS.

## Design & architecture

The system is documented in depth. These design docs are being published alongside the
code and double as the "how to onboard a vibe-coded app in 10 minutes" guide.

## What this is *not*

Scope discipline keeps an access-control plane trustworthy:

- **Not an identity provider.** We never store credentials — authentication is delegated
  to a certified OIDC IdP. That is a security feature, not a gap.
- **Not multi-tenant.** One deployment = one organization. For self-hosted white-label
  that is the honest, simple architecture.
- **Not a PaaS.** Menagerai governs the apps you deploy; it does not deploy them.

## Roadmap

- **Now** — license, hygiene, and public-repo preparation.
- **Next** — generic first-run setup and a one-command `docker compose up` quickstart
  with a bundled IdP and demo app.
- **Then** — Coolify one-click template, live demo instance, nginx/Caddy adapters,
  and bring-your-own-IdP recipes. (Storage runs on a bundled **SQLite** file by
  default, with **MongoDB** as a pluggable alternative.)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and our
[Code of Conduct](./CODE_OF_CONDUCT.md). To report a vulnerability, follow
[SECURITY.md](./SECURITY.md) (please do not open a public issue).

## License

Menagerai is licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](./LICENSE). The AGPL keeps the project and its network-hosted derivatives open.
For commercial licensing enquiries, open a discussion.
