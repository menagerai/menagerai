# Menagerai landing site (`demo/www`)

The project's public one-page landing site. It is **intentionally separate from the demo `docker-compose.yml`** and deployed on its own, so the marketing site stays up even while the demo stack is being redeployed (Coolify issues a brief `compose down` on any compose change, which would otherwise take the site down too).

One zero-dependency `node:http` server serving one static HTML page + logo/favicon + a `/healthz` probe. **No configuration** — the two links (the live demo and the GitHub repo) are hardcoded in `index.html`; edit them there if you fork.

## Run locally

```sh
node demo/www/server.js                    # → http://localhost:3000
# or containerized:
docker build -t menagerai-www demo/www && docker run -p 3000:3000 menagerai-www
```

## Deploy on Coolify (standalone)

New resource → **Dockerfile** build pack → this repo, **base directory** `demo/www`. Set the domain to your root + `www.` (e.g. `menager.ai,www.menager.ai`). No env vars. The demo itself is a separate resource (see [`../README.md`](../README.md)) on `demo.menager.ai` — the demo link on the page points there.
