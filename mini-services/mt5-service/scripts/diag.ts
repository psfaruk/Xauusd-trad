/**
 * diag.ts — READ-ONLY live diagnostic (places NO trades).
 *
 * Dumps:
 *   1. account (balance/equity — are there orphan positions?)
 *   2. positions() parsed + RAW body (verify count header & 344B record size)
 *   3. deals() with toSec=0 vs toSec=now (verify the range semantics)
 *
 * Run: bun scripts/diag.ts
 */
import { Mt5WsClient, CMD } from "../src/mt5-client";

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
  let c: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) {
    try {
      c = await Mt5WsClient.connect(gw);
      await c.auth();
      await c.login(LOGIN, PASSWORD);
      console.log(`[diag] connected via ${gw}`);
      break;
    } catch { console.log(`[diag] ${gw} failed`); }
  }
  if (!c) { console.error("[diag] all gateways failed"); process.exit(1); }

  const acct = await c.account();
  console.log(`\n[ACCOUNT] balance=${acct.balance.toFixed(2)} equity=${acct.equity.toFixed(2)} ${acct.currency} group=${acct.group}`);

  // ── parsed positions ──
  const { positions, pendingOrders } = await c.positions();
  console.log(`\n[POSITIONS] parsed=${positions.length} pendingOrders=${pendingOrders}`);
  for (const p of positions) {
    console.log(
      `  · ${p.symbol} ${p.side.toUpperCase()} lots=${p.lots} open=${p.openPrice} sl=${p.sl} tp=${p.tp} ` +
      `profit=${p.profit.toFixed(2)} id=${p.id} order=${p.order} magic=${p.magic} comment="${p.comment}"`,
    );
  }

  // ── RAW positions body ──
  const anyC = c as any;
  try {
    const raw = await anyC.request(CMD.POSITIONS, undefined, undefined, 15000);
    const b: Buffer = raw.body;
    console.log(`\n[POSITIONS-RAW] bodyLen=${b.length}`);
    if (b.length >= 4) {
      const cnt = b.readUInt32LE(0);
      const rest = b.length - 4;
      console.log(`  countField=${cnt} · bodyLen-4=${rest} · /344=${(rest / 344).toFixed(2)} · /356=${(rest / 356).toFixed(2)}`);
      console.log(`  first 48B hex: ${b.subarray(0, 48).toString("hex").match(/../g)?.join(" ")}`);
      if (cnt > 0) {
        console.log(`  record0 first 96B hex:`);
        for (let row = 0; row < 6; row++) {
          const off = 4 + row * 16;
          console.log(`    +${String(off).padStart(3)} ${b.subarray(off, off + 16).toString("hex").match(/../g)?.join(" ")}`);
        }
      }
    }
  } catch (e) { console.log(`[POSITIONS-RAW] threw: ${(e as Error).message}`); }

  // ── deals: toSec semantics ──
  const now = Math.floor(Date.now() / 1000);
  for (const [label, from, to] of [
    ["to=0 (current code)", now - 86400, 0],
    ["to=now", now - 86400, now],
  ] as [string, number, number][]) {
    try {
      const deals = await c.deals(from, to);
      console.log(`\n[DEALS ${label}] n=${deals.length}`);
      for (const d of deals.slice(-30)) {
        console.log(
          `  ${new Date(d.time).toISOString()} ${d.symbol} ${d.side} ${d.entry} vol=${d.volume} ` +
          `price=${d.price} profit=${d.profit.toFixed(2)} posId=${d.positionId} order=${d.order} "${d.comment}"`,
        );
      }
    } catch (e) { console.log(`[DEALS ${label}] threw: ${(e as Error).message}`); }
  }

  c.close();
  process.exit(0);
}

main().catch((e) => { console.error("[diag] FATAL:", e); process.exit(1); });
