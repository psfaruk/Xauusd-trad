#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# AURUM Terminal — Railway boot script (single container, 3 processes)
#   :3030  mt5-service socket.io  (live MT5 ticks)
#   :3031  mt5-service REST       (candles/quotes/status/trader)
#   :3000  Next.js (standalone)   (UI + analysis engine + SQLite)
#   :$PORT Caddy gateway          (public port — routes by XTransformPort)
#
# Supervisor semantics: if ANY process dies, the container exits with
# code 1 → Railway's ON_FAILURE restart policy brings it back fresh.
# ══════════════════════════════════════════════════════════════════
set -e

export PORT="${PORT:-80}"
export MT5_SERVICE_URL="${MT5_SERVICE_URL:-http://127.0.0.1:3031}"
export NODE_ENV=production

echo "┌──────────────────────────────────────────────────────"
echo "│ AURUM Terminal — Railway boot"
echo "│ PORT(gateway)=${PORT}  next=:3000  mt5-io=:3030  mt5-rest=:3031"
echo "└──────────────────────────────────────────────────────"

# ── credential check (never hard-coded; SIM mode when missing) ──
if [ -z "${MT5_LOGIN:-}" ] || [ -z "${MT5_PASSWORD:-}" ]; then
  echo "⚠️  MT5_LOGIN / MT5_PASSWORD not set → mt5-service runs in SIM mode."
  echo "   Add them in Railway → Variables for LIVE broker data."
else
  echo "✓ MT5 credentials present (login ${MT5_LOGIN})"
fi

# ── persistent database (Railway volume mounted at /data, optional) ──
if [ -d /data ]; then
  export DATABASE_URL="file:/data/aurum.db"
  if [ ! -f /data/aurum.db ]; then
    echo "[start] seeding fresh database on volume"
    cp /app/db/custom.db /data/aurum.db
  fi
  # mt5-service state (trader journal, tick caches) persists on the volume too
  mkdir -p /data/mt5-data
  if [ -d /app/mini-services/mt5-service/data ] && [ ! -L /app/mini-services/mt5-service/data ]; then
    cp -rn /app/mini-services/mt5-service/data/. /data/mt5-data/ 2>/dev/null || true
    rm -rf /app/mini-services/mt5-service/data
  fi
  ln -sfn /data/mt5-data /app/mini-services/mt5-service/data
  echo "[start] volume mounted → DATABASE_URL=${DATABASE_URL}, mt5-state=/data/mt5-data"
else
  export DATABASE_URL="file:/app/db/custom.db"
  echo "[start] no volume mounted — using in-image database (data resets on redeploy)"
fi

PIDS=()

echo "[start] mt5-service…"
cd /app/mini-services/mt5-service
bun index.ts &
PIDS+=($!)

echo "[start] next.js…"
cd /app
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production DATABASE_URL="$DATABASE_URL" \
  MT5_SERVICE_URL="$MT5_SERVICE_URL" bun server.js &
PIDS+=($!)

echo "[start] caddy gateway on :${PORT}…"
caddy run --config /app/Caddyfile.railway --adapter caddyfile &
PIDS+=($!)

# ── bounded readiness probes (diagnostics only; healthcheck is Railway's) ──
(
  for i in $(seq 1 60); do
    sleep 2
    REST=0; NEXT=0
    curl -sf -m 2 http://127.0.0.1:3031/health >/dev/null 2>&1 && REST=1
    curl -sf -m 2 http://127.0.0.1:3000/ >/dev/null 2>&1 && NEXT=1
    if [ "$REST" = 1 ] && [ "$NEXT" = 1 ]; then
      echo "[ready] mt5-service REST ✓ + Next.js ✓ (after $((i*2))s)"
      exit 0
    fi
    [ $((i % 15)) = 0 ] && echo "[boot] still waiting… rest=$REST next=$NEXT ($((i*2))s)"
  done
  echo "[boot] readiness wait timed out — container stays up, Railway healthcheck decides"
) &

# ── supervisor: first child that dies takes the container down ──
trap 'kill "${PIDS[@]}" 2>/dev/null; exit 1' SIGTERM SIGINT
wait -n
echo "⚠️  a process exited (code $?) — shutting container down for a fresh restart"
kill "${PIDS[@]}" 2>/dev/null || true
exit 1
