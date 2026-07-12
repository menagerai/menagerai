# One shared image for all three demo mock apps. Pick which app with the APP build
# arg (pulse | wiki | desk); each is a zero-dependency node:http server + one HTML
# file. No npm install, no lockfile.
FROM node:20-alpine
WORKDIR /app
ARG APP=pulse
COPY ${APP}/server.js ${APP}/index.html ./
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)})"
CMD ["node", "server.js"]
