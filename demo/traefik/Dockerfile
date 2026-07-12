# The demo's internal Traefik, with its routing config baked in (no bind mount, no
# docker socket) so it deploys cleanly on Coolify. File provider only; it proxies to
# the compose services by name over the shared network.
FROM traefik:v3.1
COPY dynamic.yml /etc/traefik/dynamic/dynamic.yml
