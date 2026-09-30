/**
 * probe-pending.ts — verify PENDING ORDER support in the webterminal protocol:
 *   1) place a buy-limit far from market (trade_action=5, type=2 BUY_LIMIT)
 *   2) dump cmd-4's trailing order records (field-by-field, deal-layout guess)
 *   3) cancel it (trade_action=8) and verify it's gone
 * Maps the ORDER record layout for the app's pending-orders mirror.
 *
 * Run: bun scripts/probe-pending.ts
 */
import { createCipheriv } from "node:crypto";
import { Mt5WsClient } from "../src/mt5-client";

const GATEWAYS = ["47.130.41.116", "57.182.183.85", "16.79.3.122"];
const ZERO_IV = Buffer.alloc(16);

function aesEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const pad = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(pad, pad)]);
  return createCipheriv("aes-256-cbc", key, ZERO_IV).update(padded);
}
function frame(encrypted: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32LE(encrypted.length, 0);
  hdr.writeUInt32LE(1, 4);
  return Buffer.concat([hdr, encrypted]);
}
function buildCommand(cmdId: number, payload: Buffer): Buffer {
  const cmd = Buffer.alloc(4 + payload.length);
  cmd[0] = (Math.random() * 256) | 0;
  cmd[1] = (Math.random() * 256) | 0;
  cmd.writeUInt16LE(cmdId, 2);
  payload.copy(cmd, 4);
  return cmd;
}
function utf16(b: Buffer) {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b.readUInt16LE(i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

async function main() {
  const LOGIN = Number(process.env.MT5_LOGIN);
  const PASSWORD = process.env.MT5_PASSWORD ?? "";
  if (!LOGIN || !PASSWORD) { console.error("\u2717 set MT5_LOGIN + MT5_PASSWORD env vars first"); process.exit(1); }
  let c: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) {
    try {
      c = await Mt5WsClient.connect(gw);
      await c.auth();
      await c.login(LOGIN, PASSWORD);
      console.log("[probe] connected via", gw);
      break;
    } catch { /* next */ }
  }
  if (!c) throw new Error("all gateways failed");
  const any = c as unknown as {
    ws: { send: (b: Buffer) => void };
    sessionKey: Buffer;
    request: (cmd: number, payload?: Buffer) => Promise<{ body: Buffer }>;
    tradeEventHandler: ((ev: unknown) => void) | null;
    candles: (s: string, tf: number, from: number, to: number) => Promise<{ close: number }[]>;
  };

  const sendTrade = (op: Buffer) => new Promise<any>((res) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; res({ timeout: true }); } }, 12000);
    any.tradeEventHandler = (ev) => { if (!done) { done = true; clearTimeout(to); res(ev); } };
    any.ws.send(frame(aesEncrypt(any.sessionKey, buildCommand(12, op))));
  });

  // market price for a far-away limit
  const candles = await any.candles("XAUUSDm", 1, Math.floor(Date.now() / 1000) - 180, Math.floor(Date.now() / 1000) + 60);
  const px = (candles[candles.length - 1]?.close ?? 4200) - 60;
  console.log("[place] buy-limit XAUUSDm 0.01 @", px.toFixed(2), "(~$60 below market)");

  const OP_SIZE = 472;
  const op = Buffer.alloc(OP_SIZE);
  op.writeUInt32LE(0, 0);                          // action_id
  op.writeUInt32LE(5, 4);                          // trade_action = 5 PENDING
  Buffer.from("XAUUSDm", "utf16le").copy(op, 8);
  op.writeBigUInt64LE(BigInt(0.01 * 100000), 72);  // volume
  op.writeUInt32LE(2, 80);                         // digits
  op.writeBigUInt64LE(0n, 84);                     // trade_order
  op.writeUInt32LE(2, 92);                         // type = BUY_LIMIT
  op.writeUInt32LE(2, 96);                         // filling RETURN
  op.writeUInt32LE(0, 100);                        // GTC
  op.writeUInt32LE(2, 104);                        // type_flags = new
  op.writeDoubleLE(px, 112);                       // price_order
  op.writeDoubleLE(0, 120);                        // price_trigger
  op.writeDoubleLE(0, 128);                        // sl
  op.writeDoubleLE(0, 136);                        // tp
  Buffer.from("probe-pending", "utf16le").copy(op, 164);
  console.log("[trade event]", JSON.stringify(await sendTrade(op)));

  // cmd-4 with the trailing orders
  await new Promise((r) => setTimeout(r, 1500));
  const r4 = await any.request(4);
  const b = r4.body;
  const posCount = b.readUInt32LE(0);
  let off = 4 + posCount * 344;
  const ordCount = off + 4 <= b.length ? b.readUInt32LE(off) : 0;
  off += 4;
  console.log(`[cmd4] positions=${posCount} orders=${ordCount}`);
  for (let i = 0; i < Math.min(ordCount, 2); i++) {
    const o = b.subarray(off + i * 356, off + (i + 1) * 356);
    console.log(`\n=== ORDER ${i} (356B) ===`);
    console.log("id@0        =", o.readBigInt64LE(0).toString());
    console.log("i64@8       =", o.readBigInt64LE(8).toString(), " @16 =", o.readBigInt64LE(16).toString());
    console.log("i64@72      =", o.readBigInt64LE(72).toString());
    console.log("time@80     =", new Date(o.readUInt32LE(80) * 1000).toISOString(), "+ms", o.readInt32LE(340));
    console.log("symbol@88   =", JSON.stringify(utf16(o.subarray(88, 152))));
    console.log("u32@152     =", o.readUInt32LE(152), " u32@156 =", o.readUInt32LE(156));
    console.log("price@160   =", o.readDoubleLE(160));
    console.log("vol@192     =", Number(o.readBigUInt64LE(192)) / 100000);
    console.log("price@200   =", o.readDoubleLE(200), " @208 =", o.readDoubleLE(208));
    console.log("@216 =", o.readDoubleLE(216), "@224 =", o.readDoubleLE(224), "@232 =", o.readDoubleLE(232), "@240 =", o.readDoubleLE(240));
    console.log("posid@248   =", o.readBigInt64LE(248).toString());
    console.log("comment@256 =", JSON.stringify(utf16(o.subarray(256, 320))));
    console.log("sl?@128     =", o.readDoubleLE(128), " tp?@136 =", o.readDoubleLE(136));
    console.log("u32@320/324/328/332 =", o.readUInt32LE(320), o.readUInt32LE(324), o.readUInt32LE(328), o.readUInt32LE(332));
  }

  // cancel
  if (ordCount > 0) {
    const ticket = Number(b.readBigInt64LE(off));
    console.log("\n[cancel] order ticket", ticket);
    const cop = Buffer.alloc(OP_SIZE);
    cop.writeUInt32LE(0, 0);
    cop.writeUInt32LE(8, 4);                       // trade_action = 8 CANCEL
    Buffer.from("XAUUSDm", "utf16le").copy(cop, 8);
    cop.writeBigUInt64LE(BigInt(0.01 * 100000), 72);
    cop.writeUInt32LE(2, 80);
    cop.writeBigUInt64LE(BigInt(ticket), 84);      // trade_order = ticket
    cop.writeUInt32LE(2, 92);
    cop.writeUInt32LE(2, 96);
    cop.writeUInt32LE(0, 100);
    cop.writeUInt32LE(2, 104);
    console.log("[cancel event]", JSON.stringify(await sendTrade(cop)));
    await new Promise((r) => setTimeout(r, 1500));
    const r4b = await any.request(4);
    const pc = r4b.body.readUInt32LE(0);
    const offb = 4 + pc * 344;
    const oc = offb + 4 <= r4b.body.length ? r4b.body.readUInt32LE(offb) : 0;
    console.log(`[after cancel] positions=${pc} orders=${oc}`);
  }

  c.close();
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
