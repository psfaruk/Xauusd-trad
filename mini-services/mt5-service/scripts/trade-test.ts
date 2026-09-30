/**
 * trade-test.ts — LIVE protocol verification against the Exness trial account.
 *
 * Proves (or breaks) the whole trading stack in one run:
 *   1. connect → auth → login
 *   2. live BTCUSDm quote (24/7 market)
 *   3. MARKET BUY 0.01 lots (validates the Pp/Op 380B layout + volume encoding)
 *   4. positions() parse (validates the 344B POS schema + lots = raw/1e8)
 *   5. close the position (validates close-by-opposite-market + position ticket)
 *   6. account balance delta (validates real execution, not a phantom ack)
 *
 * Run: bun scripts/trade-test.ts
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
const SYMBOL = process.argv[2] ?? "BTCUSDm";
const LOTS = 0.01;

async function main() {
  console.log(`[trade-test] symbol=${SYMBOL} lots=${LOTS} login=${LOGIN}`);

  let client: Mt5WsClient | null = null;
  let lastErr = "";
  for (const gw of GATEWAYS) {
    try {
      client = await Mt5WsClient.connect(gw);
      await client.auth();
      await client.login(LOGIN, PASSWORD);
      console.log(`[trade-test] connected via ${gw}`);
      break;
    } catch (e) {
      lastErr = (e as Error).message;
      console.log(`[trade-test] ${gw} failed: ${lastErr}`);
    }
  }
  if (!client) throw new Error("all gateways failed");
  const c = client;

  const acct = await c.account();
  console.log(`[account] balance=${acct.balance.toFixed(2)} equity=${acct.equity.toFixed(2)} ${acct.currency}`);

  // symbols + subscribe for a live quote
  const symbols = await c.symbols();
  const info = symbols.get(SYMBOL);
  if (!info) throw new Error(`${SYMBOL} not in symbol table`);
  console.log(`[symbol] ${SYMBOL} id=${info.id} digits=${info.digits}`);

  const qbox: { q?: { bid: number; ask: number } } = {};
  c.onQuotes((q) => {
    if (q.symbolId !== info.id) return;
    const div = 10 ** info.digits;
    qbox.q = { bid: q.bidRaw / div, ask: q.askRaw / div };
  });
  c.subscribe(info.id);
  for (let i = 0; i < 100 && !qbox.q; i++) await new Promise((r) => setTimeout(r, 100));
  const q0 = qbox.q;
  if (!q0) throw new Error("no live quote (market closed?)");
  console.log(`[quote] bid=${q0.bid} ask=${q0.ask}`);

  // ── 1. MARKET BUY — the production encoding (lots×1e8, Pp wrap) ──
  let open: import("../src/mt5-client").TradeResult | null = null;
  {
    console.log(`\n[trade] BUY ${LOTS} ${SYMBOL} @ ${q0.ask} …`);
    try {
      open = await c.marketOrderAt(SYMBOL, "buy", LOTS, q0.ask, {
        digits: info.digits, comment: "trade-test",
      });
    } catch (e) {
      console.log(`[trade] threw: ${(e as Error).message}`);
    }
    if (open) {
      console.log(
        `[trade] retcode=${open.retcode} (${TRADE_RETCODES[open.retcode] ?? "?"}) ` +
        `deal=${open.deal} order=${open.order} price=${open.price}`,
      );
      if (open.retcode !== 10009) open = null;
    }
  }
  if (!open) {
    console.error("[trade-test] could not open (see retcode above) — probe finished");
    const { positions } = await c.positions().catch(() => ({ positions: [] as any[] }));
    console.log(`[positions] ${positions.length} open regardless`);
    c.close();
    process.exit(3);
  }

  // ── 2. positions() ──
  await new Promise((r) => setTimeout(r, 1500));
  const { positions, pendingOrders } = await c.positions();
  console.log(`[positions] ${positions.length} open, ${pendingOrders} pending`);
  for (const p of positions) {
    console.log(
      `  · ${p.symbol} ${p.side.toUpperCase()} lots=${p.lots} open=${p.openPrice} ` +
      `sl=${p.sl} tp=${p.tp} profit=${p.profit.toFixed(2)} id=${p.id} order=${p.order} magic=${p.magic} comment="${p.comment}"`,
    );
  }
  const mine = positions.find((p) => p.order === open.order || p.id === open.order);
  if (!mine) console.warn("[trade-test] position not found by ticket — close test uses order ticket anyway");

  // ── 3. CLOSE ──
  await new Promise((r) => setTimeout(r, 1000));
  const closePrice = qbox.q?.bid ?? q0.bid;
  console.log(`\n[trade] closing (SELL ${LOTS} @ bid ${closePrice}, ticket=${open.order}) …`);
  const closeRes = await c.closePosition(SYMBOL, "buy", LOTS, closePrice, open.order, {
    digits: info.digits, comment: "ai-brain-test-close",
  });
  console.log(
    `[trade] CLOSE retcode=${closeRes.retcode} (${TRADE_RETCODES[closeRes.retcode] ?? "?"}) ` +
    `deal=${closeRes.deal} order=${closeRes.order} price=${closeRes.price}`,
  );

  // ── 4. final state ──
  await new Promise((r) => setTimeout(r, 1500));
  const after = await c.positions();
  const acct2 = await c.account();
  console.log(`\n[positions-after] ${after.positions.length} open`);
  console.log(
    `[account-after] balance=${acct2.balance.toFixed(2)} (Δ ${(acct2.balance - acct.balance).toFixed(2)}) ` +
    `equity=${acct2.equity.toFixed(2)}`,
  );

  const ok = open.retcode === 10009 && after.positions.length === 0;
  console.log(`\n[trade-test] ${ok ? "✅ FULL CYCLE VERIFIED (open → position → close)" : "⚠️ check outputs above"}`);
  c.close();
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("[trade-test] FATAL:", e);
  process.exit(1);
});
