# Open Considerations and Operational Notes

A running register of decisions still to finalize and operational gotchas to
respect during build-out. Items graduate out of here into the relevant design
doc once settled.

## Coolify / Traefik ForwardAuth wiring

The mechanism for putting every app behind the Menagerai gateway (see
[`deployment-and-gateway.md`](deployment-and-gateway.md)) is a Traefik
**ForwardAuth middleware**, defined once and attached to each app's router.

### Define the middleware once (Traefik dynamic config)

Servers → server → Proxy → Dynamic Configurations → add `menagerai-auth.yaml`:

```yaml
http:
  middlewares:
    menagerai-auth:
      forwardAuth:
        address: 'http://<menagerai-service>:<port>/gateway/verify'
        trustForwardHeader: true
        authResponseHeaders:
          - X-Menagerai-User-Email
          - X-Menagerai-User-ID
          - X-Menagerai-Roles
          - X-Menagerai-Proxy-Secret
```

`X-Menagerai-Proxy-Secret` carries the target app's own per-app secret (same header
name for every app; Menagerai fills the per-app value at `/gateway/verify`). The
app validates it against its `MENAGERAI_PROXY_SECRET` env before trusting identity.

One shared middleware serves all apps: Traefik forwards the original request's
`Cookie` and `X-Forwarded-Uri`, so Menagerai reads the session cookie *and* sees
`/apps/<key>/...`, derives the app key, and runs `decide(user, key)`. No per-app
middleware needed.

### Attach it per app

In the app's Configuration → General → Network, uncheck **Readonly labels**,
find the auto-generated router label
`traefik.http.routers.https-0-XXXXXX.middlewares`, and append `menagerai-auth@file`.
That single label per app is the whole per-app step.

### Caveats (must respect)

```text
- Compose / template deployments override custom middleware labels.
  Apps deployed via Docker Compose or a Coolify template are known to drop or
  not-merge custom Traefik middleware labels (coolify#3754, #5563). Plain app
  deployments honor the label.
- VERIFY AFTER EVERY DEPLOY: curl the app path with no session cookie and
  confirm a 302/401 (not the app). A missing menagerai-auth@file = wide open.
- No bypass route: each app reachable ONLY via app2.example.com/apps/<key> through
  the middleware. No second public FQDN, no exposed host port. A second route to
  the same container skips the middleware entirely.
```

References:
- https://coolify.io/docs/knowledge-base/proxy/traefik/protect-services-with-authentik
- https://github.com/coollabsio/coolify/issues/3754
- https://github.com/coollabsio/coolify/issues/5563

## `/gateway/verify` contract (FINALIZED)

The ForwardAuth target is fully specified in
[`deployment-and-gateway.md`](deployment-and-gateway.md) §`/gateway/verify`:
inputs, browser-vs-API discrimination (`Sec-Fetch-Mode` → `Accept`), the
OK/UNAUTH/FORBIDDEN/NOT_FOUND response matrix, the `menagerai_session` cookie, and the
per-app `public_paths` allowlist. Decisions taken:

```text
- HTML vs API: navigations get 302/redirect, API calls get 401/403 JSON;
  ambiguous requests default to API-style.
- FORBIDDEN (browser): 302 → portal /no-access?app=<key>.
- Public paths: Menagerai-only per-app allowlist; NO Traefik-level bypass router.
```

Tunables now settled (defaults in `deployment-and-gateway.md`):

```text
- Sessions: server-side in the datastore (opaque cookie id), idle 8h sliding /
  absolute 7d; Logto SSO ~14d so re-login is silent. Sensitive deployments
  tighten to idle 30–60m / absolute 8–12h.
- Gateway decision cache: in-process LRU, key (session_id, app_key), 30s TTL,
  proactive eviction on disable/grant-change. App-side check cache stays 1–5m.
```

## Data store — SQLite primary, MongoDB pluggable (DECIDED)

Menagerai's datastore is **backend-pluggable** behind a thin collection interface
(`src/store/`). The app talks to a backend-agnostic `col` collections object;
nothing else in the app changes between backends. The document/collection model
is in [`rbac-and-data-model.md`](rbac-and-data-model.md) §Physical model.

```text
- SQLite is the primary/default backend — a single file at SQLITE_PATH
  (default ./data/menagerai.db; put it on a persistent volume). Zero external
  service; suits the single-container / single-host deployment. Implemented
  with better-sqlite3: each logical collection is a table (id TEXT PRIMARY
  KEY, doc TEXT) storing the document as JSON, with queried/indexed fields
  exposed as SQLite generated columns so real (unique) indexes back them. The
  app's Mongo-style queries/updates are interpreted over the JSON docs.
- MongoDB is a pluggable secondary backend — set MONGODB_CONN_STR (and
  optionally MONGODB_DB) to use it instead of SQLite. Best when web and verify
  run as split processes across hosts, or for many replicas, since it is
  networked.
```

Consequences carried forward from this decision (live constraints, not open):

```text
- No FK integrity — Menagerai enforces referential consistency in code:
  deleting a role pulls it from every user; deleting/renaming an app cascades
  to role grants and user overrides (or is blocked while referenced).
- Keys are immutable. An app key is also its URL path segment (/apps/<key>),
  so it must never change or be reused. Role keys likewise.
- No multi-document transactions are used by the app, so no MongoDB replica
  set is required. Writes are structured so no single operation must span
  multiple documents atomically.
- IDs remain Mongo ObjectId values in the app; the SQLite backend stores them
  as their hex string and rehydrates them. Sessions are keyed by an opaque
  string id (the cookie value), not an ObjectId.
- Session expiry: MongoDB uses a TTL index; SQLite has no TTL, so the store
  sweeps expired session rows periodically (plus the existing lazy expiry on
  read). Functionally equivalent.
- decide(user, app) is ~3 indexed reads (user, app, roles), cacheable for the
  short access-check TTL.
```
