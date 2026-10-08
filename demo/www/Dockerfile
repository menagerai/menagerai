# Standalone landing site — a single zero-dependency node:http server + one HTML
# file. Build context is this folder. Deploy on its own (Coolify: Dockerfile build
# pack, base directory demo/www) so its uptime is independent of the demo compose.
FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY server.js index.html logo.png favicon.png ./
ENV PORT=3000
EXPOSE 3000
# Health checks are owned by Coolify or the per-service Compose definition.
CMD ["node", "server.js"]
