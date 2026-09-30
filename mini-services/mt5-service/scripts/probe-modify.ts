/**
 * probe-modify.ts — find the working SLTP-modify encoding for this server.
 * The brain's modifies have ALWAYS silently failed (10036) — breakeven, trail,
 * partial-protect: none ever executed. CLOSE (action 3) works with @228.
 *
 * Self-contained: opens ONE probe position (0.01 BTCUSDm, far SL/TP), runs a
 * modify matrix that only TIGHTENS the SL (never loosens, never closes), then
 * closes the probe via the verified close path.
 *
 * Matrix (all action 6 unless noted):
 *   A. order@84=ticket too        B. price=0          C. volume=0
 *   D. filling FOK(0)             E. type=opposite     F. @228=0, @84=ticket
 *   H. combo (order+pos, price0, vol0, FOK)
 *
 * Run: bun scripts/probe-modify.ts
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
const SYM = "BTCUSDm";

// same layout as mt5-client buildOp (replicated for variant control)
const OP_SIZE = 248;
const LOTS_RAW = 100_000_000;
function buildRawOp(o: {
  action: number; symbol: string; volumeRaw: number; digits: number;
  type: number; filling: number; price: number; sl: number; tp: number;
  order?: number; position?: number;
}): Buffer {
  const op = Buffer.alloc(OP_SIZE);
  op.writeUInt32LE(0, 0);
  op.writeUInt32LE(o.action, 4);
  Buffer.from(o.symbol, "utf16le").copy(op, 8);
  op.writeBigUInt64LE(BigInt(Math.max(0, Math.round(o.volumeRaw))), 72);
  op.writeUInt32LE(o.digits, 80);
  op.writeBigUInt64LE(BigInt(o.order ?? 0), 84);
  op.writeUInt32LE(o.type, 92);
  op.writeUInt32LE(o.filling, 96);
  op.writeUInt32LE(0, 100);
  op.writeUInt32LE(2, 104);
  op.writeUInt32LE(0, 108);
  op.writeDoubleLE(o.price, 112);
  op.writeDoubleLE(0, 120);
  op.writeDoubleLE(o.sl, 128);
  op.writeDoubleLE(o.tp, 136);
  op.writeUInt32LE(0, 144);
  op.writeDoubleLE(0, 148);
  op.writeDoubleLE(0, 156);
  op.writeBigUInt64LE(BigInt(o.position ?? 0), 228);
  op.writeBigUInt64LE(0n, 236);
  op.writeUInt32LE(0, 244);
  return op;
}

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

  const symbols = await c.symbols();
  const info = symbols.get(SYM)!;
  const digits = info.digits;
  const div = 10 ** digits;
  let quote: { bid: number; ask: number } | null = null;
  c.onQuotes((q) => {
    if (q.symbolId !== info.id) return;
    quote = { bid: (q as unknown as { bidRaw: number }).bidRaw / div, ask: (q as unknown as { askRaw: number }).askRaw / div };
  });
  c.subscribe(info.id);
  for (let i = 0; i < 100 && !quote; i++) await new Promise((r) => setTimeout(r, 100));
  if (!quote) { console.log("[probe] no quote — market closed?"); c.close(); process.exit(0); }
  const q0 = quote as unknown as { bid: number; ask: number } | null;
  console.log(`[probe] ${SYM} bid=${q0!.bid} ask=${q0!.ask}`);

  // 1. open probe position with a FAR SL/TP (survives the whole matrix)
  const spread = q0!.ask - q0!.bid;
  const slD = spread * 40 + 20;
  const open = await c.marketOrderAt(SYM, "buy", 0.01, q0!.ask, {
    sl: Number((q0!.ask - slD).toFixed(digits)),
    tp: Number((q0!.ask + slD * 2).toFixed(digits)),
    digits, comment: "probe-mod",
  });
  console.log(`[probe] OPEN retcode=${open.retcode} order=${open.order} price=${open.price}`);
  if (open.retcode !== 10009) { c.close(); process.exit(2); }
  await new Promise((r) => setTimeout(r, 1200));

  const { positions } = await c.positions();
  let p = positions.find((x) => (x.order || x.id) === open.order) ?? null;
  if (!p) {
    // cmd-4 list can lag a second behind the fill — synthesize from the open
    // result (diag2 proved: position id == the cmd-19 open order ticket).
    console.log("[probe] position not in cmd-4 list yet — synthesizing from open result");
    p = { id: open.order, order: 0, symbol: SYM, side: "buy", openTime: Date.now(), openPrice: open.price,
          sl: Number((open.price - slD).toFixed(digits)), tp: Number((open.price + slD * 2).toFixed(digits)),
          lots: 0.01, profit: 0, swap: 0, comment: "probe-mod", magic: 0 } as typeof positions[0];
  }
  const ticket = p.order || p.id;
  console.log(`[probe] position id=${p.id} order@8=${p.order} ticket=${ticket} sl=${p.sl}`);

  // 2. target SL: valid side of the market + tighter than current
  const q1 = quote as unknown as { bid: number; ask: number } | null;
  const curBid = q1?.bid ?? p.openPrice;
  const targetSl = Number((curBid - spread * 2 - 1).toFixed(digits)); // buy → SL below bid, well inside current SL
  console.log(`[probe] target SL ${targetSl} (cur ${p.sl}, bid ${curBid})`);

  const sendTradeAndWait = (c as unknown as { sendTradeAndWait: (op: Buffer, t?: number, l?: string) => Promise<{ retcode: number; comment: string; order: number }> }).sendTradeAndWait.bind(c);
  const variants: Array<{ label: string; build: () => Buffer }> = [
    { label: "A: order@84=ticket", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: Math.round(0.01 * LOTS_RAW), digits, type: 0, filling: 2, price: p.openPrice, sl: targetSl, tp: p.tp, order: ticket, position: ticket }) },
    { label: "B: price=0", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: Math.round(0.01 * LOTS_RAW), digits, type: 0, filling: 2, price: 0, sl: targetSl, tp: p.tp, position: ticket }) },
    { label: "C: volume=0", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: 0, digits, type: 0, filling: 2, price: p.openPrice, sl: targetSl, tp: p.tp, position: ticket }) },
    { label: "D: filling FOK", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: Math.round(0.01 * LOTS_RAW), digits, type: 0, filling: 0, price: p.openPrice, sl: targetSl, tp: p.tp, position: ticket }) },
    { label: "E: type=opposite", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: Math.round(0.01 * LOTS_RAW), digits, type: 1, filling: 2, price: p.openPrice, sl: targetSl, tp: p.tp, position: ticket }) },
    { label: "F: @228=0, @84=ticket", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: Math.round(0.01 * LOTS_RAW), digits, type: 0, filling: 2, price: p.openPrice, sl: targetSl, tp: p.tp, order: ticket, position: 0 }) },
    { label: "H: combo (order+pos, price0, vol0, FOK)", build: () => buildRawOp({ action: 6, symbol: SYM, volumeRaw: 0, digits, type: 0, filling: 0, price: 0, sl: targetSl, tp: p.tp, order: ticket, position: ticket }) },
  ];

  let worked = "";
  for (const v of variants) {
    console.log(`\n[probe] MODIFY variant ${v.label} …`);
    try {
      const r = await sendTradeAndWait(v.build(), 12000, `matrix:${v.label}`);
      console.log(`  → retcode=${r.retcode} (${TRADE_RETCODES[r.retcode] ?? "?"}) comment="${r.comment}"`);
      if (r.retcode === 10009) {
        worked = v.label;
        const { positions: after } = await c.positions();
        const mine = after.find((x) => (x.order || x.id) === ticket);
        console.log(`  ✅ WORKS — broker SL now ${mine?.sl} (target ${targetSl})`);
        break;
      }
    } catch (e) {
      console.log(`  → threw: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!worked) console.log(`\n[probe] ⚠️ NO variant worked — modify needs a different encoding (maybe a different action id?)`);

  // 3. close the probe position via the verified close path
  const q2 = quote as unknown as { bid: number; ask: number } | null;
  const px = q2?.bid ?? p.openPrice;
  const rc = await c.closePosition(SYM, "buy", 0.01, px, ticket, { digits, comment: "probe-mod-close" });
  console.log(`\n[probe] CLOSE probe: retcode=${rc.retcode} (${TRADE_RETCODES[rc.retcode] ?? "?"}) price=${rc.price}`);

  c.close();
  process.exit(0);
}

main().catch((e) => { console.error("[probe] fatal:", e); process.exit(1); });
