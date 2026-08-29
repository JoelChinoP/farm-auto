FROM node:24-bookworm-slim AS base

WORKDIR /app

FROM base AS dependencies

# better-sqlite3 compiles a native module during npm ci.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner

ENV NODE_ENV=production \
  PORT=3000 \
  HOSTNAME=0.0.0.0 \
  ADB_PATH=/usr/bin/adb \
  CONTROL_PANEL_DB_PATH=/app/data/control-panel.sqlite

# The container uses the host ADB server; GenFarmer itself remains on the host.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends adb ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir /app/data \
  && chown nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/automations ./automations
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Next's output tracer skips playwright-core's browsers.json (read dynamically,
# not via require/import), so the standalone node_modules copy is incomplete.
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules/playwright-core ./node_modules/playwright-core

USER nextjs

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
