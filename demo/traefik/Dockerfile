# The demo's internal Traefik, with its static + routing config baked in (no bind
# mount, no docker socket) so it deploys cleanly on Coolify. File provider only; it
# proxies to the compose services by name over the shared network. The baked static
# config also lets `traefik healthcheck` (the container HEALTHCHECK) find the ping
# endpoint.
FROM traefik:v3.1
COPY traefik.yml /etc/traefik/traefik.yml
COPY dynamic.yml /etc/traefik/dynamic/dynamic.yml
