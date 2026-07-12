# Standalone landing site — a single zero-dependency node:http server + one HTML
# file. Build context is this folder. Deploy on its own (Coolify: Dockerfile build
# pack, base directory demo/www) so its uptime is independent of the demo compose.
FROM node:20-alpine
WORKDIR /app
COPY server.js index.html logo.png favicon.png ./
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)})"
CMD ["node", "server.js"]
