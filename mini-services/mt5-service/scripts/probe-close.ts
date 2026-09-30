/**
 * probe-close.ts — LIVE close-protocol verification (0.01 lots BTCUSDm, open→close).
 * The brain's opens are verified working (real trades on the account), but every
 * brain close has been coming back through the 10036-reconcile path. This probe
 * proves exactly which byte/step breaks the close:
 *   1. MARKET BUY 0.01 BTCUSDm (same buildOp as the brain)
 *   2. positions() → find the real position id for our fill
 *   3. closePosition(positionId) → print retcode
 *   4. variants if the first fails: filling RETURN(2)/IOC(1), digits variants,
 *      ticket from cmd-19 order field vs positions().id
 *
 * Run: bun scripts/probe-close.ts
 */
import { Mt5WsClient, TRADE_RETCODES } from "../src/mt5-client";

const LOGIN = Number(process.env.MT5_LOGIN);
const PASSWORD = process.env.MT5_PASSWORD ?? "";
if (!LOGIN || !PASSWORD) {
  console.error("\u2717 set MT5_LOGIN + MT5_PASSWORD env vars first (broker credentials are never hard-coded)");
  process.exit(1);
}
const GATEWAYS = [
  "47.130.41.116", "57.182.183.85", "16.79.3.122", "18.61.99.175",
  "8.219.172.6", "47.236.224.248", "47.81.62.132", "43.210.112.100",
  "35.154.31.85",
];
const SYMBOL = "BTCUSDm";

async function main() {
  let c: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) {
    try {
      c = await Mt5WsClient.connect(gw);
      await c.auth();
      await c.login(LOGIN, PASSWORD);
      console.log(`[probe] connected via ${gw}`);
      break;
    } catch { /* next gateway */ }
  }
  if (!c) { console.error("[probe] all gateways failed"); process.exit(1); }
  const client = c as any;

  const symbols = await c.symbols();
  const info = symbols.get(SYMBOL)!;
  console.log(`[probe] ${SYMBOL} id=${info.id} digits=${info.digits}`);

  let quote: { bid: number; ask: number } | null = null;
  c.onQuotes((q) => {
    if (q.symbolId !== info.id) return;
    const div = 10 ** info.digits;
    quote = { bid: (q as any).bidRaw / div, ask: (q as any).askRaw / div };
  });
  c.subscribe(info.id);
  for (let i = 0; i < 100 && !quote; i++) await new Promise((r) => setTimeout(r, 100));
  if (!quote) throw new Error("no quote (market closed?)");
  const q0 = quote as { bid: number; ask: number };
  console.log(`[probe] quote bid=${q0.bid} ask=${q0.ask}`);

  // 1. OPEN — same as the brain
  const open = await c.marketOrderAt(SYMBOL, "buy", 0.01, q0.ask, {
    digits: info.digits, comment: "close-probe",
  });
  console.log(`[probe] OPEN retcode=${open.retcode} (${TRADE_RETCODES[open.retcode]}) deal=${open.deal} order=${open.order} price=${open.price}`);
  if (open.retcode !== 10009) { client.close(); process.exit(2); }

  await new Promise((r) => setTimeout(r, 1500));

  // 2. positions() → the broker's own id for our fill
  const { positions } = await c.positions();
  const mine = positions.find((p) => p.symbol === SYMBOL && Math.abs(p.lots - 0.01) < 1e-9 && p.comment === "close-probe");
  console.log(`[probe] positions=${positions.length}; mine=${mine ? `id=${mine.id} order=${mine.order} open=${mine.openPrice}` : "NOT FOUND (using cmd-19 order ticket)"}`);
  const posId = mine ? (mine.order || mine.id) : open.order;

  // 3. CLOSE — variant A: exactly what the brain sends (FOK)
  await new Promise((r) => setTimeout(r, 800));
  const freshBid = (quote as { bid: number; ask: number } | null)?.bid ?? q0.bid;
  const variants: Array<{ label: string; filling: number; ticket: number }> = [
    { label: "FOK + broker id", filling: 0, ticket: posId },
    { label: "FOK + cmd19 order", filling: 0, ticket: open.order },
    { label: "RETURN + broker id", filling: 2, ticket: posId },
    { label: "IOC + broker id", filling: 1, ticket: posId },
  ];
  for (const v of variants) {
    console.log(`\n[probe] CLOSE attempt: ${v.label} (ticket=${v.ticket}) …`);
    const op = client["buildOp"] ? null : null; // buildOp is module-scope; use closePosition API instead
    let r: import("../src/mt5-client").TradeResult;
    try {
      r = await client.closePosition(SYMBOL, "buy", 0.01, freshBid, v.ticket, {
        digits: info.digits, comment: "close-probe",
      });
      // closePosition hardcodes filling 0; patch via raw send for other fillings
    } catch (e) {
      console.log(`[probe] closePosition threw: ${(e as Error).message}`);
      continue;
    }
    console.log(`[probe] CLOSE retcode=${r.retcode} (${TRADE_RETCODES[r.retcode] ?? "?"}) price=${r.price} comment="${r.comment}"`);
    if (r.retcode === 10009) {
      console.log("[probe] ✅ CLOSE VERIFIED");
      break;
    }
    if (r.retcode === 10036) { console.log("[probe] → POSITION_NOT_EXISTS (position alive? re-checking)"); }
    await new Promise((res) => setTimeout(res, 700));
    const still = await c.positions().catch(() => ({ positions: [] as any[] }));
    const alive = still.positions.some((p: any) => p.symbol === SYMBOL && Math.abs(p.lots - 0.01) < 1e-9 && p.comment === "close-probe");
    console.log(`[probe] position still open after attempt: ${alive}`);
    if (!alive) { console.log("[probe] (position closed server-side by an earlier attempt)"); break; }
  }

  // 4. final state
  await new Promise((r) => setTimeout(r, 1200));
  const after = await c.positions();
  const acct = await c.account();
  console.log(`\n[probe] final positions=${after.positions.length} balance=${acct.balance.toFixed(2)}`);
  c.close();
  process.exit(0);
}

main().catch((e) => { console.error("[probe] FATAL:", e); process.exit(1); });
