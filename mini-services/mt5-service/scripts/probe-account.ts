/**
 * probe-account.ts — direct fresh ACCOUNT/POSITIONS/DEALS probe, independent
 * of the running service session. Answers: is the service's balance stale
 * (wedged cmd-3) or is the account genuinely at the number it reports?
 *
 * Run: bun scripts/probe-account.ts
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

async function main() {
  let client: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) {
    try {
      client = await Mt5WsClient.connect(gw);
      await client.auth();
      await client.login(LOGIN, PASSWORD);
      console.log(`[probe] connected via ${gw}`);
      break;
    } catch (e) {
      console.log(`[probe] ${gw} failed: ${(e as Error).message}`);
    }
  }
  if (!client) throw new Error("all gateways failed");
  const c = client;

  // 3 fresh account reads, 1.5s apart — prove the number is LIVE not cached
  for (let i = 0; i < 3; i++) {
    const a = await c.account();
    console.log(`[account ${i}] login=${a.login} balance=${a.balance.toFixed(2)} equity=${a.equity.toFixed(2)} ${a.currency} group=${a.group}`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  const { positions } = await c.positions();
  console.log(`[positions] ${positions.length} open`);
  for (const p of positions) {
    console.log(`  #${p.order || p.id} ${p.symbol} ${p.side} ${p.lots} @ ${p.openPrice} sl=${p.sl} tp=${p.tp} profit=${p.profit}`);
  }

  // deals last 24h — balance reconstruction + the user's manual activity
  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 3600;
  const deals = await c.deals(dayAgo, 0);
  console.log(`[deals] ${deals.length} in the last 24h`);
  let pnl = 0;
  const byPos = new Map<number, { inVol: number; outVol: number; profit: number }>();
  for (const d of deals) {
    const e = byPos.get(d.positionId) ?? { inVol: 0, outVol: 0, profit: 0 };
    if (d.entry === "in") e.inVol += d.volume; else e.outVol += d.volume;
    e.profit += d.profit;
    byPos.set(d.positionId, e);
    pnl += d.profit;
    console.log(`  ${new Date(d.time * 1000).toISOString().slice(11, 19)} pos#${d.positionId} ${d.entry} ${d.volume} ${d.symbol} @${d.price} profit=${d.profit.toFixed(2)} ${d.comment ?? ""}`);
  }
  console.log(`[deals 24h] total deal profit = ${pnl.toFixed(2)}`);
  const openFromDeals = [...byPos.entries()].filter(([, v]) => v.inVol - v.outVol > 1e-9);
  console.log(`[deals 24h] positions with net open volume: ${openFromDeals.map(([k, v]) => `#${k} (${(v.inVol - v.outVol).toFixed(2)} lots)`).join(", ") || "none"}`);

  c.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
