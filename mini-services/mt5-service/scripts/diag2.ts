/**
 * diag2.ts — READ-ONLY + ONE NON-DESTRUCTIVE MODIFY diagnostic.
 *
 * Goal: find the TRUE ticket that cmd-19 @228 (trade_position) expects for
 * close/modify, using the opening DEAL's `order` field (positionId match).
 * The brain's closes/modifies on adopted positions have been failing with
 * 10036 — this probe pins the correct ticket mapping.
 *
 * Steps:
 *   1. positions() — dump id/order for every open position
 *   2. deals() — dump recent deals; find each position's OPENING deal
 *      (positionId === pos.id, entry "in") and read its `order` (= the
 *      opening ORDER ticket — what @228 should reference)
 *   3. On the OLDEST position: try modify → breakeven (non-destructive,
 *      risk-reducing) with that ticket. Report retcode. Try pos.id as
 *      fallback if it differs.
 *
 * Run: bun scripts/diag2.ts
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
  let c: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) {
    try {
      c = await Mt5WsClient.connect(gw);
      await c.auth();
      await c.login(LOGIN, PASSWORD);
      console.log(`[diag2] connected via ${gw}`);
      break;
    } catch { console.log(`[diag2] ${gw} failed`); }
  }
  if (!c) { console.error("[diag2] all gateways failed"); process.exit(1); }

  const acct = await c.account();
  console.log(`\n[ACCOUNT] balance=${acct.balance.toFixed(2)} ${acct.currency}`);

  const { positions } = await c.positions();
  console.log(`\n[POSITIONS] ${positions.length} open`);
  const earliest = positions.reduce((a, p) => Math.min(a, p.openTime), Infinity);
  for (const p of positions) {
    console.log(
      `  · ${p.symbol} ${p.side.toUpperCase()} ${p.lots} @ ${p.openPrice} sl=${p.sl} tp=${p.tp} ` +
      `profit=${p.profit.toFixed(2)} id=${p.id} order@8=${p.order} magic=${p.magic} openTime=${p.openTime}`,
    );
  }

  // deals since earliest open (need the OPENING deal of each position)
  const fromSec = Math.max(0, Math.floor(earliest / 1000) - 30);
  const deals = await c.deals(fromSec, 0);
  console.log(`\n[DEALS] ${deals.length} since ${new Date(earliest).toISOString()}`);
  const ins = deals.filter((d) => d.entry === "in");
  const outs = deals.filter((d) => d.entry === "out");
  console.log(`  in=${ins.length} out=${outs.length} other=${deals.length - ins.length - outs.length}`);
  for (const d of deals.slice(-30)) {
    console.log(
      `  · ${new Date(d.time).toISOString().slice(11, 19)} ${d.symbol} ${d.side} ${d.entry} ` +
      `px=${d.price} vol=${d.volume} profit=${d.profit.toFixed(2)} deal=${d.deal} order=${d.order} posId=${d.positionId} "${d.comment}"`,
    );
  }

  // ── map each position → its opening deal ──
  console.log(`\n[TICKET MAP] position.id vs opening-deal.order`);
  const map: { pos: typeof positions[0]; openDealOrder: number | null }[] = [];
  for (const p of positions) {
    const openDeal = deals.find(
      (d) => d.positionId === p.id && d.entry === "in" &&
        Math.abs(d.volume - p.lots) < 1e-9 && Math.abs(d.price - p.openPrice) < 1e-9,
    );
    const openDealOrder = openDeal?.order ?? null;
    map.push({ pos: p, openDealOrder });
    console.log(
      `  · ${p.symbol} ${p.side} @${p.openPrice} → posId=${p.id} posOrder@8=${p.order} ` +
      `openDeal.order=${openDealOrder} ${openDeal ? "(OPENING DEAL FOUND)" : "(no opening deal — maybe older than window)"}`,
    );
  }

  // ── live test: modify → breakeven on the OLDEST position, using the
  //    opening-deal order ticket (fall back to pos.id). NON-DESTRUCTIVE:
  //    moving SL toward entry only REDUCES risk. ──
  const target = [...positions].sort((a, b) => a.openTime - b.openTime)[0];
  if (!target) { console.log("\n[MODIFY-TEST] no positions — nothing to test"); c.close(); return; }
  const openDeal = deals.find(
    (d) => d.positionId === target.id && d.entry === "in" &&
      Math.abs(d.volume - target.lots) < 1e-9 && Math.abs(d.price - target.openPrice) < 1e-9,
  );
  const cand = openDeal?.order ?? target.id;
  const be = target.side === "buy" ? target.openPrice + 1e-5 : target.openPrice - 1e-5;
  console.log(
    `\n[MODIFY-TEST] ${target.symbol} ${target.side} @${target.openPrice} → SL breakeven ${be.toFixed(5)} ` +
    `using ticket=${cand} (posId=${target.id} openDealOrder=${openDeal?.order ?? "n/a"})`,
  );
  const digits = (target.symbol.includes("JPY") ? 3 : target.symbol.match(/XAU|BTC|USTEC|USOIL|US500/) ? 2 : 5) as number;
  const r = await c.modifyPosition(
    target.symbol, target.side, target.lots, target.openPrice, cand,
    Number(be.toFixed(digits)), target.tp, { digits },
  );
  console.log(`[MODIFY-TEST] retcode=${r.retcode} (${r.comment}) order=${r.order}`);
  if (r.retcode !== 10009 && cand !== target.id) {
    console.log(`[MODIFY-TEST] retry with pos.id=${target.id}`);
    const r2 = await c.modifyPosition(
      target.symbol, target.side, target.lots, target.openPrice, target.id,
      Number(be.toFixed(digits)), target.tp, { digits },
    );
    console.log(`[MODIFY-TEST] retry retcode=${r2.retcode} (${r2.comment})`);
  }

  c.close();
  process.exit(0);
}

main().catch((e) => { console.error("[diag2] fatal:", e); process.exit(1); });
