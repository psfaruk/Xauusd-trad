/**
 * backtest-engine.ts — BACKTEST 2 (v10 verification): replay REAL recorded
 * XAUUSDm ticks through the PRODUCTION monitor() + syncPositions() code path
 * and prove the exit engine behaves exactly as the user's rules demand:
 *
 *   S1) $-TARGET: profit reaches +$0.50 → the brain banks it (close, exitKind
 *       TP, pnl ≥ $0.45) — and on the way up the AUTO-BREAKEVEN fired
 *       (SL → entry+lock) and every SL move only ever TIGHTENED.
 *   S2) REVERSAL AFTER BE: rally triggers BE, price then reverses hard → the
 *       broker-side SL fires at/above entry → the trade settles as "SL" with
 *       pnl ≥ 0 — a winner can never round-trip into a loss.
 *   S3) USTEC_x100m DOLLAR MATH (the 100× bug): a 26.11-pt adverse move on
 *       0.01 lots must read ≈ −$26.11 (the old code showed −$0.26).
 *
 * The mock broker fills instantly at the scripted quote and fires SLs when
 * price crosses them — exactly like the real one. Runs with cwd=/tmp so the
 * live service's trader-state.json is NEVER touched.
 *
 * Run: cd /tmp && bun /home/z/my-project/mini-services/mt5-service/scripts/backtest-engine.ts
 */
import fs from "node:fs";
import { AiTrader } from "../src/trader";
import type { TraderHost, TraderPosition } from "../src/trader";
import type { Mt5Position, Mt5Deal, TradeResult, TradeSide, AccountInfo } from "../src/mt5-client";

// ── the mock broker + host ─────────────────────────────────────────────────
class MockHost implements TraderHost {
  connected = true;
  source = "mt5" as const;
  quote: { bid: number; ask: number; mid: number } | null = null;
  positionsList: Mt5Position[] = [];
  dealsList: Mt5Deal[] = [];
  fills: { kind: "close" | "modify" | "sl-fire"; sl?: number; price: number }[] = [];
  digitsMap = new Map([["XAUUSDm", 2], ["USTEC_x100m", 2]]);

  getQuote() { return this.quote; }
  digits(s: string) { return this.digitsMap.get(s) ?? 2; }
  async getCandles() { return []; }
  getTicks() { return []; }
  getOrCreateTracker(): never { throw new Error("no trackers in backtest"); }
  async marketRead() { return null; }
  recycleSession() { /* never needed */ }
  async pendingOrder(): Promise<never> { throw new Error("no pendings in backtest"); }
  async cancelOrder(): Promise<never> { throw new Error("no pendings in backtest"); }
  async account(): Promise<AccountInfo> {
    return { login: 12345678, balance: 500.6, equity: 500.6, currency: "USD", group: "bot", server: "Exness-MT5Trial6" };
  }
  accountMeta() { return { login: 12345678, server: "Exness-MT5Trial6" }; }
  async positions() { return { positions: this.positionsList, pendingOrders: 0, orders: [] as never[] }; }
  async marketOrderAt(): Promise<never> { throw new Error("no entries in this backtest"); }
  async closePosition(symbol: string, side: TradeSide, lots: number, price: number, ticket: number): Promise<TradeResult> {
    // honest broker: closing a ticket that no longer exists → 10036
    if (!this.positionsList.some((p) => p.id === ticket)) {
      return { retcode: 10036, deal: 0, order: ticket, volumeRaw: 0, price, comment: "POSITION_NOT_EXISTS" };
    }
    this.positionsList = this.positionsList.filter((p) => p.id !== ticket);
    this.fills.push({ kind: "close", price });
    return { retcode: 10009, deal: 1, order: ticket, volumeRaw: lots * 100, price, comment: "" };
  }
  async modifyPosition(symbol: string, side: TradeSide, lots: number, price: number, ticket: number, sl: number, tp: number): Promise<TradeResult> {
    const bp = this.positionsList.find((p) => p.id === ticket);
    if (bp) { bp.sl = sl; bp.tp = tp; }
    this.fills.push({ kind: "modify", sl, price });
    return { retcode: 10009, deal: 2, order: ticket, volumeRaw: lots * 100, price, comment: "" };
  }
  async deals(): Promise<Mt5Deal[]> { return this.dealsList; }

  /** the broker marks every open position's profit from the live quote
   *  every tick — like the real one does (profit is the broker's own field) */
  markPositions() {
    if (!this.quote) return;
    for (const bp of this.positionsList) {
      const dir = bp.side === "buy" ? 1 : -1;
      const cm = bp.symbol.includes("x100") ? 100 : bp.symbol.startsWith("XAUUSD") ? 100 : 1;
      const mark = bp.side === "buy" ? this.quote.bid : this.quote.ask;
      bp.profit = (mark - bp.openPrice) * dir * bp.lots * cm;
    }
  }

  /** the broker fires the SL the moment price crosses it (like the real one) */
  fireStops() {
    if (!this.quote) return;
    for (const bp of [...this.positionsList]) {
      if (bp.sl <= 0) continue;
      const hit = bp.side === "buy" ? this.quote.bid <= bp.sl : this.quote.ask >= bp.sl;
      if (!hit) continue;
      const dir = bp.side === "buy" ? 1 : -1;
      const profit = (bp.sl - bp.openPrice) * dir * bp.lots * (bp.symbol.startsWith("USTEC") && bp.symbol.includes("x100") ? 100 : bp.symbol.startsWith("XAUUSD") ? 100 : 1);
      this.positionsList = this.positionsList.filter((p) => p.id !== bp.id);
      this.dealsList.push({
        deal: Date.now(), order: bp.id, positionId: bp.id, symbol: bp.symbol, side: bp.side === "buy" ? "sell" : "buy",
        entry: "out", time: Date.now(), price: bp.sl, volume: bp.lots, profit, commission: 0, swap: 0, comment: "sl",
      } as Mt5Deal);
      this.fills.push({ kind: "sl-fire", sl: bp.sl, price: bp.sl });
    }
  }
}

// ── recorded tick loading + window scan ────────────────────────────────────
type Tick = { t: number; p: number };
function loadTicks(): Tick[] {
  const raw = JSON.parse(fs.readFileSync("/home/z/my-project/mini-services/mt5-service/data/ticks-XAUUSDm.json", "utf8"));
  return (raw.ticks as Tick[]).filter((x) => x.p > 1000); // sanitize zero-glitches
}
/** find a real window: dip in [dipMin,dipMax] from start, then rise ≥ riseMin
 *  from the low — validated so the P/L path crosses the BE band ($0.30..$0.50)
 *  gradually (BE must fire BEFORE the $-target close) */
function scanDipRise(ticks: Tick[], dipMin: number, dipMax: number, riseMin: number): { from: number; to: number } | null {
  for (let i = 0; i + 800 < ticks.length; i += 25) {
    const win = ticks.slice(i, i + 800);
    let lo = Infinity, jLo = 0;
    win.forEach((x, j) => { if (x.p < lo) { lo = x.p; jLo = j; } });
    const dip = win[0].p - lo;
    if (dip < dipMin || dip > dipMax) continue;
    let hi = -Infinity, jHi = jLo;
    for (let j = jLo; j < win.length; j++) if (win[j].p > hi) { hi = win[j].p; jHi = j; }
    if (hi - lo < riseMin || jHi - jLo < 40) continue;
    // BE-band validator: ≥ 2 ticks with pnl in [0.31, 0.49] (entry = p0+0.10,
    // mark = p−0.10 → pnl = p − p0 − 0.20)
    const p0 = win[0].p;
    let band = 0;
    for (let j = jLo; j <= jHi; j++) {
      const pnl = win[j].p - p0 - 0.20;
      if (pnl >= 0.31 && pnl <= 0.49) band++;
    }
    if (band < 2) continue;
    return { from: i, to: i + jHi };
  }
  return null;
}
/** find a real window: rise in [riseMin,riseMax] from start (BE fires, the
 *  $-target does NOT), then fall ≥ fallMin from the high */
function scanRiseFall(ticks: Tick[], riseMin: number, riseMax: number, fallMin: number): { from: number; to: number } | null {
  for (let i = 0; i + 1200 < ticks.length; i += 25) {
    const win = ticks.slice(i, i + 1200);
    const p0 = win[0].p;
    let hi = -Infinity, jHi = 0;
    win.forEach((x, j) => { if (x.p > hi) { hi = x.p; jHi = j; } });
    const rise = hi - p0;
    if (rise < riseMin || rise > riseMax || jHi < 40) continue;
    let lo = Infinity, jLo = jHi;
    for (let j = jHi; j < win.length; j++) if (win[j].p < lo) { lo = win[j].p; jLo = j; }
    if (hi - lo < fallMin || jLo - jHi < 40) continue;
    // BE-band validator on the way up
    let band = 0;
    for (let j = 0; j <= jHi; j++) {
      const pnl = win[j].p - p0 - 0.20;
      if (pnl >= 0.31 && pnl <= 0.49) band++;
    }
    if (band < 2) continue;
    return { from: i, to: i + jLo };
  }
  return null;
}

// ── scenario runner ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
}
const HALF_SPREAD = 0.10;

async function runScenario(
  name: string,
  path: Tick[],
  inject: { symbol: string; side: TradeSide; lots: number; sl: number; tp: number },
  assert: (ctx: {
    journal: { action: string; reason: string; exitKind?: string; pnl?: number }[];
    fills: { kind: string; sl?: number; price: number }[];
    positions: Map<number, TraderPosition>;
    host: MockHost;
  }) => void,
) {
  console.log(`\n── ${name} (${path.length} real ticks) ──`);
  // isolate state: a fresh brain per scenario (no journal/memory bleed-over)
  for (const f of ["/tmp/data/trader-state.json", "/tmp/data/trader-state.json.lock"]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ok */ }
  }
  const host = new MockHost();
  const trader = new AiTrader(host as unknown as TraderHost);
  // the constructor's hot-reload guard stops the PREVIOUS scenario's trader —
  // whose stop() re-saves its state after our rmSync. Wipe the loaded state
  // in-memory so every scenario starts from a clean brain.
  const t = trader as unknown as {
    positions: Map<number, TraderPosition>;
    journal: { action: string; reason: string; exitKind?: string; pnl?: number }[];
    nextReviewAt: Map<number, number>;
    brain: unknown[];
    mem: unknown[];
    lessons: unknown[];
    edges: Map<string, unknown>;
    settled: Map<number, number>;
    today: { trades: number; wins: number; losses: number; pnl: number; winPct: number };
    tick(): Promise<void>;
    syncPositions(): Promise<void>;
  };
  t.journal = []; t.brain = []; t.mem = []; t.lessons = [];
  t.edges.clear(); t.settled.clear(); t.positions.clear();
  t.today = { trades: 0, wins: 0, losses: 0, pnl: 0, winPct: 0 };
  trader.updateConfig({ enabled: false, tpUsd: 0.5, beUsd: 0 }); // AUTO BE = 60% × $0.50 = $0.30
  const entry = path[0].p + (inject.side === "buy" ? HALF_SPREAD : -HALF_SPREAD);
  const ticket = 900001;
  const pos: TraderPosition = {
    ticket, symbol: inject.symbol, side: inject.side, lots: inject.lots, lots0: inject.lots,
    entry, sl: inject.sl, tp: inject.tp, openedAt: Date.now() - 120_000, // past the 30s anti-phantom gate
    reason: "backtest injection", price: entry, pnl: 0, pnlR: 0,
    slDist: Math.abs(entry - inject.sl), peakR: 0, beMoved: false, partialDone: false,
    adopted: false, bankedPnl: 0,
  };
  t.positions.set(ticket, pos);
  t.nextReviewAt.set(ticket, Date.now() + 3_600_000); // no LLM review in backtest
  host.positionsList.push({
    id: ticket, order: ticket, symbol: inject.symbol, side: inject.side,
    openTime: pos.openedAt, openPrice: entry, sl: inject.sl, tp: inject.tp,
    lots: inject.lots, profit: 0, swap: 0, comment: "", magic: 0,
  });
  host.dealsList.push({
    deal: 1, order: ticket, positionId: ticket, symbol: inject.symbol, side: inject.side,
    entry: "in", time: pos.openedAt, price: entry, volume: inject.lots, profit: 0, commission: 0, swap: 0, comment: "",
  } as Mt5Deal);

  for (const tk of path) {
    host.quote = { bid: tk.p - HALF_SPREAD, ask: tk.p + HALF_SPREAD, mid: tk.p };
    host.markPositions();                // the broker marks its own P/L field
    host.fireStops();                    // the broker's own SL firing
    await t.tick();                      // the REAL monitor beat
    await t.syncPositions();             // the REAL 1s broker sync
  }
  assert({ journal: t.journal, fills: host.fills, positions: t.positions, host });
}

async function main() {
  console.log("══ BACKTEST 2: the exit engine over REAL XAUUSDm ticks ══");
  const ticks = loadTicks();
  console.log(`loaded ${ticks.length} sanitized ticks (real recording)`);

  // ── S1a: SYNTHETIC steady rally → the $0.50 rule banks the win at TP ──
  // (deterministic: wiggle ±0.03 « trail-give 0.15 → the trail can never fire
  //  first; the monitor's `pnl ≥ tpUsd` close is the only possible exit)
  const p1a: Tick[] = Array.from({ length: 140 }, (_, i) => ({
    t: Date.now() - 140_000 + i * 1000,
    p: 4134.00 + (i / 139) * 1.6 + (i % 2 === 0 ? 0.03 : -0.03),
  }));
  const entry1a = p1a[0].p + HALF_SPREAD;
  await runScenario(
    "S1a) $0.50 target — steady rally, the brain banks +$0.50 at TP",
    p1a,
    { symbol: "XAUUSDm", side: "buy", lots: 0.01, sl: entry1a - 2.0, tp: entry1a + 1.2 },
    ({ journal, fills, positions }) => {
      const be = journal.find((j) => j.reason.includes("SL → breakeven"));
      check("AUTO-BREAKEVEN fired on the way up (≥$0.30 profit)", !!be, be?.reason ?? "no BE journal");
      const close = journal.find((j) => j.action === "close");
      check("position CLOSED (target reached)", !!close && positions.size === 0, close ? `${close.exitKind} ${close.pnl?.toFixed(2)}` : "still open");
      check("exit classified as TP", close?.exitKind === "TP", `exitKind=${close?.exitKind}`);
      check("banked ≥ $0.45 (the $0.50 rule)", (close?.pnl ?? 0) >= 0.45, `pnl=$${close?.pnl?.toFixed(2)}`);
      const slMoves = fills.filter((f) => f.kind === "modify").map((f) => f.sl ?? 0);
      const monotonic = slMoves.every((sl, i) => i === 0 || sl >= slMoves[i - 1] - 1e-9);
      check(`SL only ever TIGHTENED (${slMoves.length} moves)`, monotonic, slMoves.map((x) => x.toFixed(2)).slice(0, 6).join(" → "));
      check("no SL was fired (broker stop untouched)", !fills.some((f) => f.kind === "sl-fire"), "");
    },
  );

  // ── S1b: REAL dip→rally window — v11 contract: TP if it reaches $0.50,
  //         else the BE-trail banks a positive exit. A round-trip to a loss
  //         is impossible in both branches. (Recording-dependent window —
  //         the assertions describe the DESIGNED behavior, not one path.) ──
  const w1 = scanDipRise(ticks, 0.18, 0.80, 0.95);
  if (!w1) { console.log("❌ no dip-rise window found"); process.exit(1); }
  const p1 = ticks.slice(w1.from, w1.to + 1);
  const entry1 = p1[0].p + HALF_SPREAD;
  await runScenario(
    "S1b) real dip→rally — TP at $0.50 OR the profit-lock trail banks positive",
    p1,
    { symbol: "XAUUSDm", side: "buy", lots: 0.01, sl: entry1 - 2.0, tp: entry1 + 1.2 },
    ({ journal, fills, positions }) => {
      const be = journal.find((j) => j.reason.includes("SL → breakeven"));
      check("AUTO-BREAKEVEN fired on the way up (≥$0.30 profit)", !!be, be?.reason ?? "no BE journal");
      const close = journal.find((j) => j.action === "close");
      check("position settled", !!close && positions.size === 0, close ? `${close.exitKind} ${close.pnl?.toFixed(2)}` : "still open");
      const tpBanked = close?.exitKind === "TP" && (close.pnl ?? 0) >= 0.45;
      const trailBanked = close?.exitKind === "SL" && (close.pnl ?? 0) >= 0.05;
      check(
        "TP banked ≥$0.45 OR trail-banked positive (the winner never round-trips)",
        tpBanked || trailBanked,
        `exitKind=${close?.exitKind} pnl=$${close?.pnl?.toFixed(2)}`,
      );
      check("final P/L ≥ $0 (BE lock did its job)", (close?.pnl ?? -1) >= 0, `pnl=$${close?.pnl?.toFixed(2)}`);
      const slMoves = fills.filter((f) => f.kind === "modify").map((f) => f.sl ?? 0);
      const monotonic = slMoves.every((sl, i) => i === 0 || sl >= slMoves[i - 1] - 1e-9);
      check(`SL only ever TIGHTENED (${slMoves.length} moves)`, monotonic, slMoves.map((x) => x.toFixed(2)).slice(0, 6).join(" → "));
    },
  );

  // ── S2: rally (BE fires, TP NOT reached) → hard reversal → SL protects ──
  const w2 = scanRiseFall(ticks, 0.52, 0.68, 1.35);
  if (!w2) { console.log("❌ no rise-fall window found"); process.exit(1); }
  const p2 = ticks.slice(w2.from, w2.to + 1);
  const entry2 = p2[0].p + HALF_SPREAD;
  {
    const peak = Math.max(...p2.map((x) => x.p));
    const trough = Math.min(...p2.map((x) => x.p));
    console.log(`  [S2 window] from=${w2.from} to=${w2.to} p0=${p2[0].p.toFixed(2)} peak=${peak.toFixed(2)} (rise ${(peak - p2[0].p).toFixed(2)}) trough=${trough.toFixed(2)} → max pnl ≈ ${(peak - p2[0].p - 0.20).toFixed(2)}`);
  }
  await runScenario(
    "S2) reversal after breakeven — the winner can never round-trip to a loss",
    p2,
    { symbol: "XAUUSDm", side: "buy", lots: 0.01, sl: entry2 - 3.0, tp: entry2 + 5.0 },
    ({ journal, positions }) => {
      const be = journal.find((j) => j.reason.includes("SL → breakeven"));
      check("AUTO-BREAKEVEN fired during the rally", !!be, be?.reason ?? "no BE journal");
      const close = journal.find((j) => j.action === "close");
      check("position settled after the reversal", !!close && positions.size === 0, close ? `${close.exitKind} ${close.pnl?.toFixed(2)}` : "still open");
      check("exit classified as SL (the protected stop)", close?.exitKind === "SL", `exitKind=${close?.exitKind}`);
      check("final P/L ≥ $0 — the BE lock did its job", (close?.pnl ?? -1) >= 0, `pnl=$${close?.pnl?.toFixed(2)}`);
    },
  );

  // ── S3: the USTEC 100× bug — dollars, not cents ──
  // synthetic 51-tick path from the REAL incident: entry 30512.01 → −26.11 pts
  const p3: Tick[] = Array.from({ length: 51 }, (_, i) => ({
    t: Date.now() - 60_000 + i * 1000,
    p: 30512.01 + (i / 50) * -26.11,
  }));
  await runScenario(
    "S3) USTEC_x100m dollar math — the 100× bug regression",
    p3,
    { symbol: "USTEC_x100m", side: "buy", lots: 0.01, sl: 30512.01 - 260, tp: 30512.01 + 260 },
    ({ positions }) => {
      const p = [...positions.values()][0];
      const pnl = p?.pnl ?? 0;
      check("0.01 lots × −26.11 pts reads ≈ −$26.11 (old code: −$0.26)", Math.abs(pnl - -26.11) < 0.6, `pnl=$${pnl.toFixed(2)}`);
      check("still open (mark-to-market, no forced cut)", positions.size === 1, "");
    },
  );

  console.log(`\n══ BACKTEST 2 RESULT: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
