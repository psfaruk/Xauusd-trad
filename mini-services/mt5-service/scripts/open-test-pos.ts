/**
 * open-test-pos.ts — open ONE tiny manual position (default 0.01 XAUUSDm)
 * and DISCONNECT, so the running service adopts it (copilot mode) and the
 * app's SL/TP edit + BE button can be verified end-to-end against the broker.
 *
 * The position is NOT closed by this script — close it from the app (or it
 * will be adopted and can be closed there).
 *
 * Run: bun scripts/open-test-pos.ts [symbol]
 */
import { Mt5WsClient } from "../src/mt5-client";

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
const SYMBOL = process.argv[2] ?? "XAUUSDm";

async function main() {
  let client: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) {
    try {
      client = await Mt5WsClient.connect(gw);
      await client.auth();
      await client.login(LOGIN, PASSWORD);
      console.log(`[open-test] connected via ${gw}`);
      break;
    } catch (e) {
      console.log(`[open-test] ${gw} failed: ${(e as Error).message}`);
    }
  }
  if (!client) throw new Error("all gateways failed");
  const c = client;

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
  const until = Date.now() + 6000;
  while (!qbox.q && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  const quote = qbox.q;
  if (!quote) throw new Error("no live quote");
  console.log(`[quote] bid=${quote.bid} ask=${quote.ask}`);

  // MARKET BUY 0.01 — no SL/TP: exactly like a position the user opens by
  // hand in MT5 (the app should adopt + protect it)
  const r = await c.marketOrderAt(SYMBOL, "buy", 0.01, quote.ask, {
    sl: 0, tp: 0, digits: info.digits, comment: "copilot-test",
  });
  console.log(`[order] retcode=${r.retcode} order=${r.order} price=${r.price} comment=${r.comment}`);
  if (r.retcode !== 10009) process.exit(1);

  const acct = await c.account();
  console.log(`[account] balance=${acct.balance.toFixed(2)} equity=${acct.equity.toFixed(2)}`);
  console.log(`[done] position #${r.order} open — the app will adopt it within ~4s`);
  c.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
