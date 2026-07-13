FROM node:20-bookworm-slim AS build
WORKDIR /app
# Toolchain so better-sqlite3's native addon builds if no prebuilt binary matches
# the target arch (prebuilt covers common linux glibc x64/arm64).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm config set registry https://registry.npmjs.org/
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm config set registry https://registry.npmjs.org/
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 GATEWAY_PORT=3001
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY views ./views
COPY public ./public
COPY demo/public ./demo/public
COPY locales ./locales

EXPOSE 3000
# 3001 = internal-only /gateway/verify port; documentation only (not published).
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["sh", "-c", "exec node \"dist/${MENAGERAI_ENTRYPOINT:-server-all}.js\""]
