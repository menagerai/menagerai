# One shared image for all three demo mock apps. Pick which app with the APP build
# arg (pulse | wiki | desk); each is a zero-dependency node:http server + one HTML
# file. No npm install, no lockfile.
FROM node:20-alpine
WORKDIR /app
ARG APP=pulse
COPY ${APP}/server.js ${APP}/index.html ./
ENV PORT=3000
EXPOSE 3000
# Health checks are owned by Coolify or the per-service Compose definition.
CMD ["node", "server.js"]
