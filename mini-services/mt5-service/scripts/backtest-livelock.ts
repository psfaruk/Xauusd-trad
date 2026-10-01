/**
 * backtest-livelock.ts — BACKTEST 3 (v10.3 verification): prove the three
 * recycle-livelock armors on the PRODUCTION syncPositions()/closeManaged()
 * code path:
 *
 *   T1) STORM BREAKER + COUNTER HYGIENE — a permanently-wedged broker
 *       (empty cmd-4 list while we track a position) used to recycle the
 *       session every ~15 s forever (the Sep-30 storm: 79 recycles). Now:
 *       exactly 4 recycles per 4-minute window, then back-off; the empty
 *       counter resets with each recycle so the escape stays armed.
 *   T2) TOMBSTONE SELF-HEAL — a WRONG tombstone (live position falsely
 *       settled during a wedged session) used to make every broker list
 *       look "stale" → infinite recycle loop that no recycle could ever
 *       fix. Now: the 2nd listing deals-verifies the ticket, un-settles
 *       it, and the 3rd sync ADOPTS the live position — ZERO recycles.
 *   T3) CLOSE RETRY ON DISCONNECT — a close that lands inside a recycle
 *       window threw "mt5 not connected" and error-journaled (8× in the
 *       Sep-30 storm). Now: it waits ≤6 s for the session and retries
 *       once — the position closes and settles cleanly.
 *
 * Run: cd /tmp && bun /home/z/my-project/mini-services/mt5-service/scripts/backtest-livelock.ts
 */
import fs from "node:fs";
import { AiTrader } from "../src/trader";
import type { TraderHost, TraderPosition } from "../src/trader";
import type { Mt5Position, Mt5Deal, TradeResult, TradeSide, AccountInfo } from "../src/mt5-client";

// v14 STATE-ISOLATION (the 13-B incident): the trader resolves its state
// file from process.cwd()/data/trader-state.json — running this script from
// the service directory made loadState() read the LIVE state. Force an
// isolated cwd BEFORE any AiTrader is constructed.
if (!process.cwd().startsWith("/tmp")) {
  process.chdir("/tmp");
}

// ── mock broker/host ───────────────────────────────────────────────────────
class MockHost implements TraderHost {
  connected = true;
  source = "mt5" as const;
  quote = { bid: 4200.0, ask: 4200.2, mid: 4200.1 };
  positionsList: Mt5Position[] = [];
  dealsList: Mt5Deal[] = [];
  recycleCalls = 0;
  closeThrows = false;

  getQuote() { return this.quote; }
  digits() { return 2; }
  async getCandles() { return []; }
  getTicks() { return []; }
  getOrCreateTracker(): never { throw new Error("no trackers"); }
  async marketRead() { return null; }
  recycleSession() { this.recycleCalls++; }
  brokerNowSec() { return Math.floor(Date.now() / 1000); }
  async pendingOrder(): Promise<never> { throw new Error("no pendings in backtest"); }
  async cancelOrder(): Promise<never> { throw new Error("no pendings in backtest"); }
  async account(): Promise<AccountInfo> {
    return { login: 12345678, balance: 500, equity: 500, currency: "USD", group: "bot", server: "Exness-MT5Trial6" };
  }
  accountMeta() { return { login: 12345678, server: "Exness-MT5Trial6" }; }
  async positions() { return { positions: this.positionsList, pendingOrders: 0, orders: [] as never[] }; }
  async marketOrderAt(): Promise<never> { throw new Error("no entries in this backtest"); }
  async closePosition(symbol: string, side: TradeSide, lots: number, price: number, ticket: number): Promise<TradeResult> {
    if (this.closeThrows) throw new Error("mt5 not connected");
    if (!this.positionsList.some((p) => p.id === ticket)) {
      return { retcode: 10036, deal: 0, order: ticket, volumeRaw: 0, price, comment: "POSITION_NOT_EXISTS" };
    }
    this.positionsList = this.positionsList.filter((p) => p.id !== ticket);
    return { retcode: 10009, deal: 1, order: ticket, volumeRaw: lots * 100, price, comment: "" };
  }
  async modifyPosition() { return { retcode: 10009, deal: 2, order: 0, volumeRaw: 0, price: 0, comment: "" }; }
  async deals(): Promise<Mt5Deal[]> { return this.dealsList; }
}

// ── helpers ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} — ${name}${ok ? "" : detail ? ` (${detail})` : ""}`);
  if (ok) pass++; else fail++;
}

function mkTrader(host: MockHost) {
  const trader = new AiTrader(host as unknown as TraderHost);
  const t = trader as unknown as {
    positions: Map<number, TraderPosition>;
    journal: { action: string; reason: string; exitKind?: string; pnl?: number }[];
    settled: Map<number, number>;
    thoughts: unknown[];
    emptySyncs: number;
    syncPositions(): Promise<void>;
    closeManaged(p: TraderPosition, reason: string, exitKind?: string): Promise<{ ok: boolean; error?: string }>;
  };
  t.journal = []; t.thoughts = []; t.settled.clear(); t.positions.clear();
  trader.updateConfig({ enabled: false });
  return { trader, t };
}

const brokerPos = (id: number, symbol = "XAUUSDm"): Mt5Position => ({
  id, order: id, symbol, side: "buy",
  openTime: Date.now() - 300_000, openPrice: 4200, sl: 4190, tp: 4210,
  lots: 0.01, profit: 0, swap: 0, comment: "", magic: 0,
});
const trackedPos = (ticket: number, symbol = "XAUUSDm"): TraderPosition => ({
  ticket, symbol, side: "buy", lots: 0.01, lots0: 0.01,
  entry: 4200, sl: 4190, tp: 4210, openedAt: Date.now() - 300_000,
  reason: "backtest injection", price: 4200, pnl: 0, pnlR: 0,
  slDist: 10, peakR: 0, beMoved: false, partialDone: false,
  adopted: false, bankedPnl: 0,
});

// ══ T1 — storm breaker + counter hygiene (empty-list wedge) ═══════════════
async function t1() {
  console.log("\n══ T1 — STORM BREAKER: 80 syncs of a permanently-wedged broker ══");
  for (const f of ["/tmp/data/trader-state.json", "/tmp/data/trader-state.json.lock"]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ok */ }
  }
  const host = new MockHost();
  const { trader, t } = mkTrader(host);
  t.positions.set(111, trackedPos(111));      // tracked but NEVER listed (wedged list)
  host.dealsList = [];                        // no closing proof — position stays watched
  for (let i = 1; i <= 80; i++) {
    await t.syncPositions();
    if (i === 16) {
      // the recycle at sync #15 reset the counter; sync #16 added 1 back.
      // Without the reset it would read 16 (and the === 15 escape could
      // never re-fire — the carried-counter livelock).
      check("counter hygiene — emptySyncs restarted at 1 after the 1st recycle", t.emptySyncs === 1, `emptySyncs=${t.emptySyncs}`);
    }
  }
  check("exactly 4 recycles (15/30/45/60th sync) — the 5th is storm-suppressed", host.recycleCalls === 4, `recycles=${host.recycleCalls}`);
  const stormNote = t.journal.some((j) => j.reason.includes("session-recycle storm"));
  check("storm back-off journaled once", stormNote);
  check("the tracked position was never falsely settled (no closing deal)", !t.settled.has(111) && t.positions.has(111));
}

// ══ T2 — tombstone self-heal (wrong tombstone on a LIVE position) ═════════
async function t2() {
  console.log("\n══ T2 — TOMBSTONE SELF-HEAL: live position listed under a wrong tombstone ══");
  const host = new MockHost();
  const { t } = mkTrader(host);
  t.settled.set(777, Date.now() - 60_000);    // WRONG tombstone (falsely settled)
  host.positionsList = [brokerPos(777)];      // broker lists the LIVE position
  host.dealsList = [{                          // deals: opened, NEVER closed
    deal: 1, order: 777, positionId: 777, symbol: "XAUUSDm", side: "buy",
    entry: "in", time: Date.now() - 300_000, price: 4200, volume: 0.01,
    profit: 0, commission: 0, swap: 0, comment: "",
  } as unknown as Mt5Deal];
  await t.syncPositions();                     // 1st listing: stale hit only
  check("1st listing — no recycle yet", host.recycleCalls === 0);
  await t.syncPositions();                     // 2nd listing: deals-verify → HEAL
  check("2nd listing — tombstone HEALED (un-settled)", !t.settled.has(777));
  const healNote = t.journal.some((j) => j.reason.includes("tombstone #777 was WRONG"));
  check("heal journaled", healNote);
  await t.syncPositions();                     // 3rd listing: normal adoption
  check("3rd listing — live position ADOPTED again", t.positions.has(777));
  check("ZERO recycles for the whole livelock scenario", host.recycleCalls === 0, `recycles=${host.recycleCalls}`);
}

// ══ T3 — close retry inside a recycle window ══════════════════════════════
async function t3() {
  console.log("\n══ T3 — CLOSE RETRY: 'mt5 not connected' during a recycle window ══");
  const host = new MockHost();
  const { t } = mkTrader(host);
  const p = trackedPos(555);
  t.positions.set(555, p);
  host.positionsList = [brokerPos(555)];
  // simulate the recycle window: disconnect now, session back in ~100 ms
  host.connected = false;
  host.closeThrows = true;
  setTimeout(() => { host.connected = true; host.closeThrows = false; }, 100);
  const r = await t.closeManaged(p, "test close");
  check("close retried through the window and succeeded", r.ok === true, `err=${r.error}`);
  check("position settled cleanly (no 'close threw' error journal)", !t.journal.some((j) => j.reason.includes("close threw")));
  check("settle journaled with the original reason", t.journal.some((j) => j.reason.includes("test close")));
  check("broker no longer lists the position", host.positionsList.length === 0);
}

// ── run ────────────────────────────────────────────────────────────────────
await t1();
await t2();
await t3();
console.log(`\n${fail === 0 ? "🎉" : "💥"} ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
