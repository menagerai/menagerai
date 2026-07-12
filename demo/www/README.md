# Menagerai landing site (`demo/www`)

The project's public one-page landing site. It is **intentionally separate from the
demo `docker-compose.yml`** and deployed on its own, so the marketing site stays up
even while the demo stack is being redeployed (Coolify issues a brief `compose down`
on any compose change, which would otherwise take the site down too).

One zero-dependency `node:http` server serving one static HTML page + `/healthz`.
Two links are configurable via env; everything else is static.

## Env

| Var | Default | Meaning |
|---|---|---|
| `DEMO_URL` | `https://demo.menager.ai` | "Try the live demo" button target |
| `GITHUB_URL` | `https://github.com/menagerai/menagerai` | GitHub links |
| `PORT` | `3000` | listen port |

## Run locally

```sh
DEMO_URL=http://demo.localhost node demo/www/server.js   # → http://localhost:3000
# or containerized:
docker build -t menagerai-www demo/www && docker run -p 3000:3000 menagerai-www
```

## Deploy on Coolify (standalone)

New resource → **Dockerfile** build pack → this repo, **base directory** `demo/www`.
Set the domain to your root + `www.` (e.g. `menager.ai,www.menager.ai`), and set
`DEMO_URL` to your demo host (`https://demo.menager.ai`). The demo itself is a
separate resource (see [`../README.md`](../README.md)) on `demo.menager.ai`.
