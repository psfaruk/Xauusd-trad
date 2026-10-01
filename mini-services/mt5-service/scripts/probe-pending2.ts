/**
 * probe-pending2.ts — try PENDING order placement variants until one is
 * accepted (10009), then dump the cmd-4 order record + cancel it.
 * Variants: type buy-limit/buy-stop × filling FOK/RETURN × price_trigger.
 */
import { createCipheriv } from "node:crypto";
import { Mt5WsClient } from "../src/mt5-client";

const ZERO_IV = Buffer.alloc(16);
function aesEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const pad = 16 - (plaintext.length % 16);
  return createCipheriv("aes-256-cbc", key, ZERO_IV).update(Buffer.concat([plaintext, Buffer.alloc(pad, pad)]));
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

const LOGIN = Number(process.env.MT5_LOGIN);
const PASSWORD = process.env.MT5_PASSWORD ?? "";
if (!LOGIN || !PASSWORD) { console.error("\u2717 set MT5_LOGIN + MT5_PASSWORD env vars first"); process.exit(1); }
let c: Mt5WsClient | null = null;
for (const gw of ["47.130.41.116", "57.182.183.85", "16.79.3.122"]) {
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
  const to = setTimeout(() => { if (!done) { done = true; res({ timeout: true }); } }, 8000);
  any.tradeEventHandler = (ev) => { if (!done) { done = true; clearTimeout(to); res(ev); } };
  any.ws.send(frame(aesEncrypt(any.sessionKey, buildCommand(12, op))));
});

const candles = await any.candles("XAUUSDm", 1, Math.floor(Date.now() / 1000) - 180, Math.floor(Date.now() / 1000) + 60);
const mid = candles[candles.length - 1]?.close ?? 4200;

function mkOp(v: { type: number; filling: number; price: number; trigger: number; flags: number; action: number; vol?: number }) {
  const op = Buffer.alloc(472);
  op.writeUInt32LE(0, 0);
  op.writeUInt32LE(v.action, 4);
  Buffer.from("XAUUSDm", "utf16le").copy(op, 8);
  op.writeBigUInt64LE(BigInt(Math.round((v.vol ?? 0.01) * 100000)), 72);
  op.writeUInt32LE(2, 80);
  op.writeBigUInt64LE(0n, 84);
  op.writeUInt32LE(v.type, 92);
  op.writeUInt32LE(v.filling, 96);
  op.writeUInt32LE(0, 100);
  op.writeUInt32LE(v.flags, 104);
  op.writeDoubleLE(v.price, 112);
  op.writeDoubleLE(v.trigger, 120);
  op.writeDoubleLE(0, 128);
  op.writeDoubleLE(0, 136);
  Buffer.from("probe-p2", "utf16le").copy(op, 164);
  return op;
}

const variants = [
  { name: "buy-limit filling=RETURN trig=0", type: 2, filling: 2, price: mid - 60, trigger: 0, flags: 2, action: 5 },
  { name: "buy-limit filling=FOK trig=price", type: 2, filling: 0, price: mid - 60, trigger: mid - 60, flags: 2, action: 5 },
  { name: "buy-stop  filling=FOK trig=0", type: 4, filling: 0, price: mid + 60, trigger: 0, flags: 2, action: 5 },
  { name: "buy-limit action=2 (TP-style?)", type: 2, filling: 2, price: mid - 60, trigger: 0, flags: 2, action: 2 },
  { name: "buy-limit flags=0", type: 2, filling: 2, price: mid - 60, trigger: 0, flags: 0, action: 5 },
];
console.log("market ≈", mid.toFixed(2));
let okTicket = 0;
for (const v of variants) {
  const ev = await sendTrade(mkOp(v));
  console.log(`[try] ${v.name} → retcode=${ev.retcode} order=${ev.order}`);
  if (ev.retcode === 10009 && ev.order) { okTicket = ev.order; break; }
  await new Promise((r) => setTimeout(r, 800));
}

// whatever happened — dump cmd-4 trailing orders
await new Promise((r) => setTimeout(r, 1500));
const r4 = await any.request(4);
const b = r4.body;
const posCount = b.readUInt32LE(0);
let off = 4 + posCount * 344;
const ordCount = off + 4 <= b.length ? b.readUInt32LE(off) : 0;
off += 4;
console.log(`\n[cmd4] positions=${posCount} orders=${ordCount}`);
for (let i = 0; i < Math.min(ordCount, 2); i++) {
  const o = b.subarray(off + i * 356, off + (i + 1) * 356);
  console.log(`\n=== ORDER ${i} ===`);
  console.log("id@0 =", o.readBigInt64LE(0).toString(), " i64@8 =", o.readBigInt64LE(8).toString(), " i64@16 =", o.readBigInt64LE(16).toString(), " i64@72 =", o.readBigInt64LE(72).toString());
  console.log("time@80 =", new Date(o.readUInt32LE(80) * 1000).toISOString(), "+ms", o.readInt32LE(340));
  console.log("symbol@88 =", JSON.stringify(utf16(o.subarray(88, 152))));
  console.log("u32@152 =", o.readUInt32LE(152), "u32@156 =", o.readUInt32LE(156));
  console.log("price@160 =", o.readDoubleLE(160), "vol@192 =", Number(o.readBigUInt64LE(192)) / 100000);
  console.log("@200 =", o.readDoubleLE(200), "@208 =", o.readDoubleLE(208), "@216 =", o.readDoubleLE(216), "@224 =", o.readDoubleLE(224), "@232 =", o.readDoubleLE(232), "@240 =", o.readDoubleLE(240));
  console.log("posid@248 =", o.readBigInt64LE(248).toString(), "comment@256 =", JSON.stringify(utf16(o.subarray(256, 320))));
  console.log("f64@128 =", o.readDoubleLE(128), "f64@136 =", o.readDoubleLE(136));
  console.log("u32@320/324/328/332 =", o.readUInt32LE(320), o.readUInt32LE(324), o.readUInt32LE(328), o.readUInt32LE(332));
}
console.log("\nfirst position record for layout reference:");
if (posCount > 0) {
  const p0 = b.subarray(4, 4 + 344);
  console.log("pos id@0 =", p0.readBigInt64LE(0).toString(), "order@8 =", p0.readBigInt64LE(8).toString(), "openTime@16 =", new Date(p0.readUInt32LE(16) * 1000).toISOString());
  console.log("symbol@24 =", JSON.stringify(utf16(p0.subarray(24, 88))), "side@88 =", p0.readUInt32LE(88), "open@92 =", p0.readDoubleLE(92), "sl@108 =", p0.readDoubleLE(108), "tp@116 =", p0.readDoubleLE(116));
}

// cleanup: cancel any pending that exists
if (ordCount > 0) {
  const ticket = Number(b.readBigInt64LE(off));
  console.log("\n[cleanup] cancelling order", ticket);
  const cop = Buffer.alloc(472);
  cop.writeUInt32LE(0, 0);
  cop.writeUInt32LE(8, 4);
  Buffer.from("XAUUSDm", "utf16le").copy(cop, 8);
  cop.writeBigUInt64LE(BigInt(0.01 * 100000), 72);
  cop.writeUInt32LE(2, 80);
  cop.writeBigUInt64LE(BigInt(ticket), 84);
  cop.writeUInt32LE(2, 92);
  cop.writeUInt32LE(2, 96);
  cop.writeUInt32LE(0, 100);
  cop.writeUInt32LE(2, 104);
  const ev = await sendTrade(cop);
  console.log("[cancel event]", JSON.stringify(ev));
  await new Promise((r) => setTimeout(r, 1200));
  const r4b = await any.request(4);
  const pc = r4b.body.readUInt32LE(0);
  const offb = 4 + pc * 344;
  const oc = offb + 4 <= r4b.body.length ? r4b.body.readUInt32LE(offb) : 0;
  console.log(`[after cancel] positions=${pc} orders=${oc}`);
}

c.close();
process.exit(0);
