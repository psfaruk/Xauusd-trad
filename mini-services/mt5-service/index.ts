/**
 * mt5-service — market data microservice (2 ports, 1 process).
 *
 *   :3030  socket.io  (path "/" — connect with io("/?XTransformPort=3030"))
 *          events: "tick" · "bar" · "status" · "snapshot" · "flow"
 *          client messages: "sub" {symbol, tf} · "unsub" {symbol, tf}
 *                          "flowsub" {symbol, tf} · "flowunsub" {symbol, tf}
 *
 *   :3031  REST
 *          GET /health
 *          GET /api/status        → connection + account + latency
 *          GET /api/symbols       → watchlist quotes
 *          GET /api/candles?symbol=XAUUSDm&tf=M15&limit=500
 *          GET /api/quote?symbol=XAUUSDm
 *          GET /api/flow?symbol=XAUUSDm&tf=M1   → running-candle order-flow snapshot
 *          GET /api/ticks?symbol=XAUUSDm&sec=180 → recent tick path (area chart)
 *          GET /api/trader                     → AI trader state
 *          POST /api/trader/config             → update rules (frontend-managed)
 *          POST /api/trader/close {ticket}     → manual close
 *          POST /api/trader/modify {ticket, sl?, tp?, be?}
 *                                                → customize SL/TP of an open
 *                                                  position (be:true = SL→entry)
 *          POST /api/trader/close-all          → close everything
 *          GET /api/ai-chart?symbol&tf          → LIVE AI chart read: S/R levels,
 *                                                 trend, tick value-area (POC),
 *                                                 flow bias + active trade zones
 *                                                 (the brain "sees" the chart)
 *          GET  /api/mt5-account                 → MT5 connection + configured
 *                                                 account (masked login) — PRIVATE
 *          POST /api/mt5-connect {login,password,server}
 *                                               → live-test + adopt Exness
 *                                                 credentials from the app's
 *                                                 Settings → MT5 Account form
 *                                                 (stored AES-encrypted on disk)
 *          POST /api/mt5-disconnect {forget?}    → drop the broker session
 *                                                 (forget:true wipes the saved
 *                                                 credentials file)
 *
 * Run: bun run dev   (auto-restart on change)
 */

import { createServer } from "node:http";
import { buildMarketRead } from "./src/market-read";
import { Server } from "socket.io";
import { Mt5Manager } from "./src/manager";
import { AiTrader, type TraderConfig } from "./src/trader";
import { authorizeTradingReq, authorizeHandshake, rateLimit, clientIp } from "./src/auth";
import { loadCredentials, saveCredentials, clearCredentials, maskLogin } from "./src/credentials";

const IO_PORT = 3030;
const REST_PORT = 3031;
const manager = new Mt5Manager();

// ═════════════════════ REST (:3031) ═════════════════════
// v12 SECURITY: no more Access-Control-Allow-Origin:* — the app talks to this
// service SAME-ORIGIN through the gateway (/?XTransformPort=3031), so cross-
// origin browser calls are now refused by the browser itself.
function json(res: any, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(s);
}

/** v12: trading + private endpoints require the shared key (server proxy) or
 *  the owner's session cookie; POSTs are rate-limited per IP (brute-force and
 *  spam armor — the audit's Critical #1). */
function guardTrading(req: any, res: any): boolean {
  const rl = rateLimit(`trade:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) });
    res.end(JSON.stringify({ error: `rate limit — retry in ${rl.retryAfter}s` }));
    return false;
  }
  const auth = authorizeTradingReq(req);
  if (!auth.ok) {
    json(res, 401, { error: "unauthorized — trading API is locked (login or server key required)" });
    return false;
  }
  return true;
}

/** v15: read-only market data (status/symbols/quote/ticks/flow/ai-chart/
 *  candles) — SAME auth, but its OWN generous bucket. The v14 blanket
 *  guardTrading on these routes shared the 30/min `trade:` bucket with
 *  every trading call — yet a single /api/analysis poll fans out to ~6
 *  candle fetches every 15s (≈28 req/min from the Next.js server IP),
 *  so the app rate-limited ITSELF into 429 → fetchCandles [] → the
 *  intermittent "no candle data" 503s. 300/min is still 10× the app's
 *  need and starves anonymous scrapers (they hit auth regardless). */
function guardMarket(req: any, res: any): boolean {
  const rl = rateLimit(`market:${clientIp(req)}`, 300, 60_000);
  if (!rl.ok) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) });
    res.end(JSON.stringify({ error: `rate limit — retry in ${rl.retryAfter}s` }));
    return false;
  }
  const auth = authorizeTradingReq(req);
  if (!auth.ok) {
    json(res, 401, { error: "unauthorized — trading API is locked (login or server key required)" });
    return false;
  }
  return true;
}

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2592000,
};

const restServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${REST_PORT}`);
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    // ── AI trader (auto-trading brain) — PRIVATE (v12: full state = positions,
    //    tickets, journal; the audit's Critical #3 leak) ──
    if (url.pathname === "/api/trader") {
      if (!guardTrading(req, res)) return;
      return json(res, 200, trader.state());
    }
    if (req.method === "POST" && url.pathname === "/api/trader/config") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, (body) => {
        try {
          const patch = body as Partial<TraderConfig>;
          trader.updateConfig(patch);
          return json(res, 200, { ok: true, state: trader.state() });
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      });
    }
    if (req.method === "POST" && url.pathname === "/api/trader/close") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const ticket = Number((body as any)?.ticket);
        if (!Number.isFinite(ticket) || ticket <= 0) return json(res, 400, { error: "ticket required" });
        const r = await trader.manualClose(ticket);
        return json(res, r.ok ? 200 : 502, r);
      });
    }
    // ── v9: user-driven SL/TP customization for any open position (brain or
    //    manual/adopted) — {ticket, sl?, tp?} sets the levels, {ticket, be:true}
    //    moves the SL to entry (+small lock) in one click ──
    if (req.method === "POST" && url.pathname === "/api/trader/modify") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const b = body as any;
        const ticket = Number(b?.ticket);
        if (!Number.isFinite(ticket) || ticket <= 0) return json(res, 400, { error: "ticket required" });
        if (b?.be !== true && typeof b?.sl !== "number" && typeof b?.tp !== "number") {
          return json(res, 400, { error: "sl, tp or be required" });
        }
        const r = await trader.manualModify(ticket, {
          ...(b?.be === true ? { be: true } : {}),
          ...(typeof b?.sl === "number" ? { sl: b.sl } : {}),
          ...(typeof b?.tp === "number" ? { tp: b.tp } : {}),
        });
        return json(res, r.ok ? 200 : 400, r);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/trader/close-all") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async () => {
        const r = await trader.closeAll();
        return json(res, 200, r);
      });
    }
    // ── v11: app→MT5 manual trading — market order, pending place/cancel ──
    if (req.method === "POST" && url.pathname === "/api/trader/order") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const b = body as any;
        const symbol = String(b?.symbol ?? "");
        const side = b?.side === "buy" || b?.side === "sell" ? b.side : null;
        const lots = Number(b?.lots);
        if (!symbol || !side || !Number.isFinite(lots) || lots <= 0) {
          return json(res, 400, { error: "symbol, side (buy|sell), lots required" });
        }
        const r = await trader.manualMarketOrder(symbol, side, lots, {
          ...(typeof b?.sl === "number" && b.sl > 0 ? { sl: b.sl } : {}),
          ...(typeof b?.tp === "number" && b.tp > 0 ? { tp: b.tp } : {}),
        });
        return json(res, r.ok ? 200 : 400, r);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/trader/pending") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const b = body as any;
        const symbol = String(b?.symbol ?? "");
        const t = Number(b?.orderType);
        const lots = Number(b?.lots);
        const price = Number(b?.price);
        if (!symbol || ![2, 3, 4, 5].includes(t) || !Number.isFinite(lots) || lots <= 0 || !Number.isFinite(price) || price <= 0) {
          return json(res, 400, { error: "symbol, orderType (2=buy-limit 3=sell-limit 4=buy-stop 5=sell-stop), lots, price required" });
        }
        const r = await trader.placePending(symbol, t as 2 | 3 | 4 | 5, lots, price, {
          ...(typeof b?.sl === "number" && b.sl > 0 ? { sl: b.sl } : {}),
          ...(typeof b?.tp === "number" && b.tp > 0 ? { tp: b.tp } : {}),
        });
        return json(res, r.ok ? 200 : 400, r);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/trader/cancel-pending") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const ticket = Number((body as any)?.ticket);
        if (!Number.isFinite(ticket) || ticket <= 0) return json(res, 400, { error: "ticket required" });
        const r = await trader.cancelPending(ticket);
        return json(res, r.ok ? 200 : 400, r);
      });
    }
    // v11: closed-trades history (broker deals — brain AND manual) — PRIVATE
    // (v12: real money P/L history must not be public)
    if (url.pathname === "/api/history") {
      if (!guardTrading(req, res)) return;
      const hours = Math.min(72, Math.max(1, Number(url.searchParams.get("hours")) || 24));
      return json(res, 200, { hours, history: trader.state().recentHistory });
    }

    // ── v13: MT5 account setup from the app (Settings → MT5 Account) ──
    // All three are PRIVATE (session/key) — credentials must never be
    // settable by an anonymous visitor on a public deployment.
    if (url.pathname === "/api/mt5-account") {
      if (!guardTrading(req, res)) return;
      const stored = loadCredentials();
      const configured = manager.hasCredentials || !!stored;
      return json(res, 200, {
        configured,
        connected: manager.connected,
        source: manager.source,
        server: manager.serverName,
        loginMasked: configured ? maskLogin(manager.login || stored?.login) : null,
        // v14: `login` (full number) REMOVED — loginMasked is the only form
        // that leaves the service (the audit's connected-account leak).
        account: manager.connected && manager.account
          ? {
              balance: manager.account.balance,
              equity: manager.account.equity,
              currency: manager.account.currency,
            }
          : null,
        reason: manager.reason,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/mt5-connect") {
      // tighter limiter than guardTrading: credential stuffing armor
      const rl = rateLimit(`mt5conn:${clientIp(req)}`, 10, 60_000);
      if (!rl.ok) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) });
        return void res.end(JSON.stringify({ ok: false, error: `rate limit — retry in ${rl.retryAfter}s` }));
      }
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const b = body as any;
        const login = Number(String(b?.login ?? "").replace(/\s+/g, ""));
        const password = String(b?.password ?? "");
        const server = String(b?.server ?? "").trim();
        if (!Number.isFinite(login) || login < 10000 || login > 9999999999) {
          return json(res, 400, { ok: false, error: "invalid account login — enter your MT5 account number" });
        }
        if (!password || password.length > 128) {
          return json(res, 400, { ok: false, error: "password required" });
        }
        if (!/^[\w.-]{3,64}$/.test(server)) {
          return json(res, 400, { ok: false, error: "server required (e.g. Exness-MT5Trial6)" });
        }
        try {
          // 1) live-test on a throw-away socket (resolves the server's access
          //    IPs via the MetaQuotes directory exactly like an MT5 terminal)
          const { account, gateways } = await manager.testCredentials(login, password, server);
          // 2) adopt for the persistent session
          manager.applyCredentials({ login, password, server, gateways });
          // 3) persist (AES-encrypted, mode 600) so restarts auto-reconnect
          const saved = saveCredentials({ login, password, server, gateways });
          // 4) give the live session a moment to come up (UI updates via
          //    socket "status" events either way)
          const t0 = Date.now();
          while (!manager.connected && Date.now() - t0 < 12_000) {
            await new Promise((r) => setTimeout(r, 500));
          }
          console.log(`[mt5-connect] account ${maskLogin(login)} @ ${server} — ${manager.connected ? "live" : "still connecting"} (stored: ${saved ? "yes" : "NO — fs read-only?"})`);
          return json(res, 200, {
            ok: true,
            connected: manager.connected,
            server,
            account: {
              login,
              balance: account.balance,
              equity: account.equity,
              currency: account.currency,
            },
          });
        } catch (e) {
          const raw = (e as Error).message ?? "connect failed";
          const msg =
            /LOGIN failed/i.test(raw)
              ? "Login failed — check the account number, password and server"
              : /server .*not found|invalid server/i.test(raw)
                ? raw
                : /WS connect (failed|timeout)|gateway unreachable/i.test(raw)
                  ? "Exness gateway unreachable — try again in a moment"
                  : raw;
          console.log(`[mt5-connect] FAILED for ${maskLogin(login)} @ ${server}: ${msg}`);
          return json(res, 400, { ok: false, error: msg });
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/mt5-disconnect") {
      if (!guardTrading(req, res)) return;
      return readBody(req, res, async (body) => {
        const forget = (body as any)?.forget === true;
        if (forget) {
          clearCredentials();
          manager.disconnect("disconnected — credentials removed");
        } else {
          manager.disconnect("disconnected — reconnect from Settings → MT5 Account");
        }
        // the brain must not trade a dead session — it already pauses on
        // !connected, and the socket broadcast tells every UI instantly
        return json(res, 200, { ok: true, configured: !forget && (manager.hasCredentials || !!loadCredentials()) });
      });
    }

    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true, service: "mt5-service", source: manager.source,
        connected: manager.connected, uptime: Math.floor(process.uptime()),
      });
    }
    if (url.pathname === "/api/status") {
      // v12: account numbers are PRIVATE — anonymous callers get connection
      // health only (the owner's browser carries the session cookie and sees
      // balance/equity; the audit's Critical #3)
      // v14: guarded (market REST was an open door behind Caddy);
      // `login` REMOVED from the payload — masked login lives in
      // /api/mt5-account.loginMasked only (the audit's full-login leak).
      // v15: guardMarket — read-only, own bucket (was guardTrading).
      if (!guardMarket(req, res)) return;
      const priv = authorizeTradingReq(req).ok;
      return json(res, 200, {
        connected: manager.connected,
        source: manager.source,
        server: manager.serverName,
        account: priv && manager.account
          ? {
              balance: manager.account.balance,
              equity: manager.account.equity,
              currency: manager.account.currency,
            }
          : null,
        latencyMs: manager.latencyMs,
        serverTime: manager.nowSec() + manager.offsetSec,
        offsetSec: manager.offsetSec,
        reason: manager.reason,
        symbols: manager.watch.length,
      });
    }
    if (url.pathname === "/api/symbols") {
      // v14: market REST now requires the session/key (the audit's dual-door
      // finding) — the app's own browser reaches these through the Next.js
      // proxy which attaches x-trader-key server-side.
      // v15: guardMarket — read-only, own bucket (was guardTrading).
      if (!guardMarket(req, res)) return;
      return json(res, 200, { source: manager.source, list: manager.symbolList() });
    }
    if (url.pathname === "/api/quote") {
      if (!guardMarket(req, res)) return;
      const symbol = url.searchParams.get("symbol") ?? "XAUUSDm";
      const q = manager.getQuote(symbol);
      if (!q) return json(res, 404, { error: "no quote yet" });
      return json(res, 200, { symbol, ...q, spread: q.ask - q.bid });
    }
    if (url.pathname === "/api/ticks") {
      if (!guardMarket(req, res)) return;
      const symbol = url.searchParams.get("symbol") ?? "XAUUSDm";
      const sec = Number(url.searchParams.get("sec") ?? 180);
      const q = manager.getQuote(symbol);
      return json(res, 200, {
        symbol,
        digits: manager.digits(symbol),
        ticks: manager.getTicks(symbol, sec),
        live: q ? { bid: q.bid, ask: q.ask, mid: q.mid, ts: q.ts } : null,
      });
    }
    if (url.pathname === "/api/flow") {
      if (!guardMarket(req, res)) return;
      const symbol = url.searchParams.get("symbol") ?? "XAUUSDm";
      const tf = url.searchParams.get("tf") ?? "M1";
      // peek-only: returns data if a tracker exists (a socket flowsub creates it)
      try {
        const payload = manager.getFlowSnapshot(symbol, tf);
        return json(res, 200, payload ?? { waiting: true, symbol, tf });
      } catch (e) {
        return json(res, 200, { waiting: true, symbol, tf, error: (e as Error).message });
      }
    }
    // ── AI live chart analysis — what the brain "sees" when it looks at the chart ──
    if (url.pathname === "/api/ai-chart") {
      if (!guardMarket(req, res)) return;
      const symbol = url.searchParams.get("symbol") ?? "XAUUSDm";
      const tf = url.searchParams.get("tf") ?? "M15";
      manager.getCandles(symbol, tf, 260).then(
        (bars) => {
          const q = manager.getQuote(symbol);
          const price = q?.mid ?? bars[bars.length - 1]?.c ?? 0;
          const digits = manager.digits(symbol);

          // ATR(14) on this tf — the yardstick for everything below
          let atr = 0;
          if (bars.length > 15) {
            const trs: number[] = [];
            for (let i = 1; i < bars.length; i++) {
              const b = bars[i], p = bars[i - 1];
              trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
            }
            atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
          }

          // ── S/R: fractal swings (k=2) clustered within 0.35 ATR ──
          const levels: { price: number; kind: "support" | "resistance"; touches: number; ageMin: number }[] = [];
          if (atr > 0 && bars.length > 8) {
            const k = 2;
            const tol = atr * 0.35;
            const swings: { price: number; t: number }[] = [];
            for (let i = k; i < bars.length - k; i++) {
              let isHigh = true, isLow = true;
              for (let j = 1; j <= k; j++) {
                if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
                if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
              }
              if (isHigh) swings.push({ price: bars[i].h, t: bars[i].t });
              if (isLow) swings.push({ price: bars[i].l, t: bars[i].t });
            }
            const sorted = [...swings].sort((a, b) => a.price - b.price);
            const clusters: { price: number; touches: number; lastT: number }[] = [];
            for (const s of sorted) {
              const last = clusters[clusters.length - 1];
              if (last && Math.abs(s.price - last.price) <= tol) {
                last.price = (last.price * last.touches + s.price) / (last.touches + 1);
                last.touches++;
                last.lastT = Math.max(last.lastT, s.t);
              } else clusters.push({ price: s.price, touches: 1, lastT: s.t });
            }
            const nowSec = Math.floor(Date.now() / 1000);
            for (const c of clusters) {
              levels.push({
                price: Number(c.price.toFixed(digits + 1)),
                kind: c.price >= price ? "resistance" : "support",
                touches: c.touches,
                ageMin: Math.max(1, Math.round((nowSec - c.lastT) / 60)),
              });
            }
          }
          const resistances = levels.filter((l) => l.kind === "resistance").sort((a, b) => a.price - b.price).slice(0, 3);
          const supports = levels.filter((l) => l.kind === "support").sort((a, b) => b.price - a.price).slice(0, 3);

          // ── trend: linear-regression slope of last 60 closes (per-bar, in ATR) ──
          let trend: { dir: "up" | "down" | "flat"; slopeAtr: number } = { dir: "flat", slopeAtr: 0 };
          if (bars.length > 20 && atr > 0) {
            const closes = bars.slice(-60).map((b) => b.c);
            const n = closes.length;
            const meanX = (n - 1) / 2, meanY = closes.reduce((a, b) => a + b, 0) / n;
            let num = 0, den = 0;
            for (let i = 0; i < n; i++) {
              num += (i - meanX) * (closes[i] - meanY);
              den += (i - meanX) ** 2;
            }
            const slope = den ? num / den : 0;
            const slopeAtr = slope / atr;
            trend = { dir: slopeAtr > 0.08 ? "up" : slopeAtr < -0.08 ? "down" : "flat", slopeAtr: Number(slopeAtr.toFixed(3)) };
          }

          // ── tick value area (last 5 min of real tape) — POC / VAH / VAL ──
          let valueArea: { poc: number; vah: number; val: number; ticks: number } | null = null;
          const ticks = manager.getTicks(symbol, 300);
          if (ticks.length >= 30 && atr > 0) {
            const bucket = Math.max(atr / 12, 1e-9);
            const hist = new Map<number, number>();
            for (const t of ticks) {
              const b = Math.floor(t.p / bucket);
              hist.set(b, (hist.get(b) ?? 0) + 1);
            }
            let pocB = 0, pocN = -1;
            for (const [b, n] of hist) if (n > pocN) { pocN = n; pocB = b; }
            const total = ticks.length;
            let covered = hist.get(pocB) ?? 0;
            let lo = pocB, hi = pocB;
            while (covered < total * 0.7 && (hist.has(lo - 1) || hist.has(hi + 1))) {
              const dn = hist.get(lo - 1) ?? 0, up = hist.get(hi + 1) ?? 0;
              if (dn >= up) { lo--; covered += dn; } else { hi++; covered += up; }
            }
            valueArea = {
              poc: Number(((pocB + 0.5) * bucket).toFixed(digits + 1)),
              vah: Number(((hi + 1) * bucket).toFixed(digits + 1)),
              val: Number((lo * bucket).toFixed(digits + 1)),
              ticks: total,
            };
          }

          // ── live flow bias (if a tracker exists for M1) ──
          let bias: { state: string; strength: number; deltaPct: number } | null = null;
          try {
            const fp = manager.getFlowSnapshot(symbol, "M1");
            if (fp) bias = {
              state: fp.sig.state,
              strength: Number(fp.sig.strength.toFixed(2)),
              deltaPct: Number((fp.deltaPct ?? 0).toFixed(2)),
            };
          } catch { /* no tracker yet */ }

          // ── the brain's own open position on this symbol (zones to draw) ──
          let trade: { side: string; entry: number; sl: number; tp: number; pnlR: number; reason: string } | null = null;
          try {
            const st = trader.state();
            const pos = st.positions.find((p) => p.symbol === symbol);
            if (pos) trade = {
              side: pos.side, entry: pos.entry, sl: pos.sl, tp: pos.tp,
              pnlR: Number(pos.pnlR.toFixed(2)), reason: pos.reason,
            };
          } catch { /* trader state hiccup */ }

          json(res, 200, {
            symbol, tf, at: Date.now(), digits, price, atr: Number(atr.toFixed(digits + 1)),
            supports, resistances, trend, valueArea, bias, trade,
          });
        },
        (e) => json(res, 503, { error: (e as Error).message }),
      );
      return;
    }
    if (url.pathname === "/api/candles") {
      // v15: guardMarket — the analysis route fans out ~6 of these per 15s
      // poll; sharing the trading bucket made the app 429 itself.
      if (!guardMarket(req, res)) return;
      const symbol = url.searchParams.get("symbol") ?? "XAUUSDm";
      const tf = url.searchParams.get("tf") ?? "M15";
      const limit = Number(url.searchParams.get("limit") ?? 500);
      manager.getCandles(symbol, tf, limit).then(
        (bars) => {
          const info = manager.symbols.get(symbol);
          const now = manager.nowSec();
          const tfSec = TF_SEC[tf] ?? 60;
          const out = bars.map((b, i) => ({
            t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
            ...(i === bars.length - 1 && b.t + tfSec > now ? { f: 1 } : {}),
          }));
          json(res, 200, {
            symbol, tf, digits: info?.digits ?? 2,
            source: manager.source, bars: out,
          });
        },
        (e) => json(res, 503, { error: (e as Error).message }),
      );
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

// ═════════════════════ socket.io (:3030) ═════════════════════
const ioServer = createServer();
const io = new Server(ioServer, {
  // DO NOT change the path — the sandbox gateway routes by it
  path: "/",
  // v12 SECURITY: no cross-origin sockets — the app connects SAME-ORIGIN via
  // the gateway; a foreign origin now gets no CORS headers → browser blocks
  cors: { origin: false, methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── read a JSON POST body (trading endpoints) ──
function readBody(req: any, res: any, cb: (body: any) => void) {
  let raw = "";
  req.on("data", (chunk: string) => { raw += chunk; if (raw.length > 65536) req.destroy(); });
  req.on("end", () => {
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    Promise.resolve(cb(body)).catch((e) => {
      try { json(res, 500, { error: (e as Error).message }); } catch {}
    });
  });
}

// ── the AI trader (one brain per service) — created here, started after boot ──
const trader = new AiTrader({
  get connected() { return manager.connected; },
  get source() { return manager.source; },
  getQuote: (s) => manager.getQuote(s),
  digits: (s) => manager.digits(s),
  getCandles: (s, tf, limit) => manager.getCandles(s, tf, limit),
  getTicks: (s, sec) => manager.getTicks(s, sec),
  getOrCreateTracker: (s, tf) => manager.getOrCreateTracker(s, tf),
  marketRead: (s, tf, limit) => buildMarketRead(manager, s, tf ?? "M15", limit ?? 200),
  recycleSession: () => manager.forceReconnect(),
  account: () => manager.traderAccount(),
  accountMeta: () => ({ login: manager.login, server: manager.serverName }),
  positions: () => manager.traderPositions(),
  pendingOrder: (s, orderType, lots, price, opts) => manager.traderPendingOrder(s, orderType, lots, price, opts),
  cancelOrder: (s, orderType, lots, price, ticket, opts) => manager.traderCancelOrder(s, orderType, lots, price, ticket, opts),
  brokerNowSec: () => manager.nowSec() + manager.offsetSec,
  marketOrderAt: (s, side, lots, price, opts) => manager.traderMarketOrder(s, side, lots, price, opts),
  closePosition: (s, side, lots, price, ticket, opts) => manager.traderClose(s, side, lots, price, ticket, opts),
  modifyPosition: (s, side, lots, price, ticket, sl, tp, opts) => manager.traderModify(s, side, lots, price, ticket, sl, tp, opts),
  deals: (f, t) => manager.traderDeals(f, t),
  // v16 EVENT-FIRST: the trader mirrors account/positions/history the moment
  // the broker pushes cmd 14/19/22 — polls are backup only.
  onTradePush: (cb) => { manager.onTradePush = cb; },
});
trader.onState((s) => { try { io.to("trader").emit("trader", s); } catch {} });

manager.onTick = (t) => { try { io.emit("tick", t); } catch { /* never die on a client error */ } };
manager.onBar = (e) => { try { io.to(`${e.symbol}|${e.tf}`).emit("bar", e); } catch {} };
// v12: the periodic status broadcast is PRIVACY-AWARE — anonymous sockets get
// connection health without the account, the owner's sockets (session cookie
// in the handshake) see balance/equity too.
const privSockets = new Set<string>();
manager.onStatus = (s) => {
  try {
    const pub = { ...s, account: null };
    for (const [, sk] of io.sockets.sockets) {
      try { sk.emit("status", privSockets.has(sk.id) ? s : pub); } catch {}
    }
  } catch {}
};
manager.onFlow = (p) => { try { io.to(`flow|${p.s}|${p.tf}`).emit("flow", p); } catch {} };

io.on("connection", (socket) => {
  // v12: is this socket the LOGGED-IN OWNER? (session cookie rides the
  // same-origin handshake). Anonymous sockets still get market data, but
  // account numbers and the trading brain stay private.
  const socketPriv = authorizeHandshake(socket.handshake.headers);
  if (socketPriv) privSockets.add(socket.id);

  // per-socket held rooms — makes sub/flowsub IDEMPOTENT (a client that
  // re-emits after reconnect, or StrictMode double-mounts, must not inflate
  // the server refcounts, which previously leaked trackers forever)
  socket.data.heldBars = new Set<string>();
  socket.data.heldFlow = new Set<string>();

  socket.emit("status", {
    connected: manager.connected,
    source: manager.source,
    server: manager.serverName,
    account: socketPriv && manager.account
      ? {
          balance: manager.account.balance,
          equity: manager.account.equity,
          currency: manager.account.currency,
        }
      : null,
    latencyMs: manager.latencyMs,
    // v16.3: offsetSec MUST ride the initial emit too — the periodic
    // manager.onStatus broadcast carries it, but the FIRST status a socket
    // receives (the one the UI boots from) did not, so serverTime could not
    // be converted to true UTC until the next broadcast (session chip + clock
    // rendered broker wall-clock as "UTC" for up to 5s after load).
    serverTime: manager.nowSec() + manager.offsetSec,
    offsetSec: manager.offsetSec,
    reason: manager.reason,
  });
  socket.emit("snapshot", { source: manager.source, quotes: manager.symbolList() });

  // ── AI trader state stream — OWNER ONLY (v12: positions/journal/tickets
  //    are private; anonymous sockets are refused the room) ──
  socket.on("tradersub", () => {
    if (!socketPriv) {
      socket.emit("trader", { locked: true } as any);
      return;
    }
    socket.join("trader");
    try { socket.emit("trader", trader.state()); } catch {}
  });
  socket.on("traderunsub", () => { socket.leave("trader"); });

  socket.on("sub", (data: { symbol?: string; tf?: string }) => {
    const symbol = data?.symbol ?? "XAUUSDm";
    const tf = data?.tf ?? "M15";
    const room = `${symbol}|${tf}`;
    if (!socket.data.heldBars.has(room)) {
      socket.data.heldBars.add(room);
      manager.addSubscription(symbol, tf);
    }
    socket.join(room);
  });
  socket.on("unsub", (data: { symbol?: string; tf?: string }) => {
    if (data?.symbol && data?.tf) {
      const room = `${data.symbol}|${data.tf}`;
      if (socket.data.heldBars.delete(room)) manager.removeSubscription(data.symbol, data.tf);
      socket.leave(room);
    }
  });

  // ── running-candle order-flow (X-ray) subscriptions ──
  socket.on("flowsub", (data: { symbol?: string; tf?: string }) => {
    const symbol = data?.symbol ?? "XAUUSDm";
    const tf = data?.tf ?? "M1";
    const room = `flow|${symbol}|${tf}`;
    if (!socket.data.heldFlow.has(room)) {
      socket.data.heldFlow.add(room);
      try { manager.addFlowSub(symbol, tf); }
      catch (e) { console.error(`[flow] addFlowSub ${symbol}|${tf} failed:`, e); }
    }
    socket.join(room);
    // immediate snapshot so the UI paints before the next tick — a payload
    // bug must never kill the service (it did once; never again)
    try {
      const snap = manager.getFlowSnapshot(symbol, tf);
      if (snap) socket.emit("flow", snap);
    } catch (e) {
      console.error(`[flow] snapshot ${symbol}|${tf} failed:`, e);
    }
  });
  socket.on("flowunsub", (data: { symbol?: string; tf?: string }) => {
    if (data?.symbol && data?.tf) {
      const room = `flow|${data.symbol}|${data.tf}`;
      if (socket.data.heldFlow.delete(room)) manager.removeFlowSub(data.symbol, data.tf);
      socket.leave(room);
    }
  });

  // socket disconnects → release every room it held (exactly once each)
  socket.on("disconnect", () => {
    privSockets.delete(socket.id);
    for (const room of socket.data.heldBars ?? []) {
      const [symbol, tf] = room.split("|");
      if (symbol && tf) manager.removeSubscription(symbol, tf);
    }
    for (const room of socket.data.heldFlow ?? []) {
      const [, symbol, tf] = room.split("|");
      if (symbol && tf) manager.removeFlowSub(symbol, tf);
    }
    socket.data.heldBars?.clear();
    socket.data.heldFlow?.clear();
  });
});

// ═════════════════════ boot ═════════════════════
// Guard against split-brain duplicate instances: if either port is taken,
// die loudly instead of half-running (which starves clients of ticks/bars).
for (const srv of [ioServer, restServer]) {
  srv.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[mt5-service] FATAL server error: ${err.code} — ${err.message}`);
    if (err.code === "EADDRINUSE") {
      console.error("[mt5-service] Port already in use — another instance is running. Exiting.");
      process.exit(1);
    }
  });
}
let restUp = false;
// v12: bind BOTH services to localhost only — the gateway (Caddy) is the
// single public door; nothing else may reach these ports even if the
// container exposes them (the audit's "listen() → 0.0.0.0" finding).
const BIND_HOST = "127.0.0.1";
ioServer.listen(IO_PORT, BIND_HOST, () => {
  console.log(`[mt5-service] socket.io on ${BIND_HOST}:${IO_PORT} (path "/")`);
});
restServer.listen(REST_PORT, BIND_HOST, () => {
  restUp = true;
  console.log(`[mt5-service] REST on ${BIND_HOST}:${REST_PORT}`);
  manager.start();
  trader.start();
  // v13: auto-reconnect the stored MT5 account (Settings → MT5 Account) — a
  // 24/7 deployment must come back up logged in after ANY restart. In-app
  // credentials take precedence over MT5_LOGIN/MT5_PASSWORD env vars.
  const stored = loadCredentials();
  if (stored) {
    console.log(`[mt5-service] stored account ${maskLogin(stored.login)} @ ${stored.server} — auto-connecting`);
    manager.applyCredentials(stored);
  }
});
// safety: if REST never came up within 5s, exit (prevents a socket-only zombie)
setTimeout(() => {
  if (!restUp) {
    console.error("[mt5-service] FATAL: REST port never opened — exiting to avoid split-brain.");
    process.exit(1);
  }
}, 5000).unref?.();

process.on("SIGTERM", () => { trader.stop(); manager.stop(); process.exit(0); });
process.on("SIGINT", () => { trader.stop(); manager.stop(); process.exit(0); });

// ═══════════════════════ 24/7 survival armor ═══════════════════════
// The market feed must survive ANY single bug. A thrown error inside a
// socket handler or timer used to kill the whole service (twice — see
// mt5-service.log). Log, keep serving; the wedge detector + port watchdog
// handle true deadlocks, and EADDRINUSE still exits for split-brain.
process.on("uncaughtException", (err) => {
  console.error("[mt5-service] UNCAUGHT (survived):", (err as Error)?.stack ?? err);
});
process.on("unhandledRejection", (err) => {
  console.error("[mt5-service] UNHANDLED REJECTION (survived):", err);
});
