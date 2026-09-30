# ══════════════════════════════════════════════════════════════════
# AURUM Terminal — single-image Railway deployment
# Runs 3 processes in one container:
#   :3030  mt5-service socket.io  (live MT5 ticks)
#   :3031  mt5-service REST       (candles/quotes/status/trader)
#   :3000  Next.js (standalone)   (UI + analysis engine + SQLite)
#   :$PORT Caddy gateway          (public port — routes by XTransformPort)
# ══════════════════════════════════════════════════════════════════

FROM oven/bun:1.2-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json bun.lock ./
RUN bun install

COPY . .
# Prisma client + a PRISTINE SQLite database generated from the schema
# (no database file ships in the repo/build-context — created here).
# DATABASE_URL is also exported for `next build`: PrismaClient resolves
# its datasource at import time, so the build would fail without it.
RUN bun run db:generate \
  && DATABASE_URL="file:/app/db/custom.db" bun run db:push \
  && DATABASE_URL="file:/app/db/custom.db" bunx next build

# ───────────────────────────── runtime ─────────────────────────────
FROM oven/bun:1.2-slim AS runner
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production

# caddy (gateway) + sqlite tools
# primary: official custom-build API · fallback: pinned GitHub release
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates sqlite3 bash xz-utils \
  && (curl -fsSL --retry 3 --max-time 120 \
        "https://caddyserver.com/api/download?os=linux&arch=amd64" \
        -o /usr/local/bin/caddy \
      || (curl -fsSL --retry 3 \
            "https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz" \
            | tar -xz -C /tmp caddy \
            && mv /tmp/caddy /usr/local/bin/caddy)) \
  && chmod +x /usr/local/bin/caddy \
  && caddy version \
  && rm -rf /var/lib/apt/lists/*

# Next.js standalone app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Prisma client (for the API routes) + schema + PRISTINE seeded SQLite database
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/db ./db

# mt5 data service (independent bun project)
COPY --from=builder /app/mini-services ./mini-services
RUN cd mini-services/mt5-service && bun install --production

# gateway + boot script
COPY Caddyfile.railway ./Caddyfile.railway
COPY start-railway.sh ./start-railway.sh
RUN chmod +x ./start-railway.sh

EXPOSE 80
CMD ["bash", "./start-railway.sh"]
