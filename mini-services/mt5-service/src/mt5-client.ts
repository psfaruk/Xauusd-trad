/**
 * MT5 WebSocket protocol client — Exness-MT5Trial6 direct connection.
 *
 * Speaks the MT5 web-terminal binary protocol over wss://<gateway>:443/terminal
 * (AES-256-CBC framed). This is the same protocol the official Exness web
 * terminal uses — no MetaTrader terminal/PC required.
 *
 * Reverse-engineering reference:
 *   https://github.com/leon-git-21/MT5-Client-Reverse-Engineer
 * Framing per WS binary message:
 *   [payload_len:u32 LE][version:u32 LE = 1][AES-256-CBC ciphertext]
 * Plaintext command:   [rnd:u8][rnd:u8][cmd_id:u16 LE][payload]
 * Plaintext response:  [tag:u16 LE][cmd_id:u16 LE][res_code:u8][body]
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { gunzipSync, inflateSync, inflateRawSync } from "node:zlib";

// ── Static web-terminal AUTH key (public, embedded in every MT5 web bundle) ──
const STATIC_KEY = Buffer.from(
  "02de02a1a65cc794684fcbea1ecb0fd74ae657e43662c11eee885d2fd64f4964",
  "hex",
);
const ZERO_IV = Buffer.alloc(16);

export const TF_CODE: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30,
  H1: 16385, H4: 16388, D1: 16408, W1: 32769, MN1: 49153,
};

export const CMD = {
  AUTH: 0, ACCOUNT: 3, POSITIONS: 4, DEALS: 5, SUBSCRIBE: 7, QUOTES: 8,
  CANDLES: 11, TRADE: 12, TRADE_EVENT: 19, LOGIN: 28, SYMBOLS_GZ: 34,
  HEARTBEAT: 51,
} as const;

export interface Mt5Candle {
  time: number; // unix seconds, broker server time
  open: number; high: number; low: number; close: number;
  tickVolume: number; spread: number;
}
export interface LiveQuote { symbolId: number; timeSec: number; bidRaw: number; askRaw: number; }
export interface SymbolInfo { id: number; digits: number; name: string; }
export interface AccountInfo {
  login: number; balance: number; equity: number;
  currency: string; group: string; server: string;
}

// ── trading types ──
export type TradeSide = "buy" | "sell";

export interface TradeResult {
  retcode: number;      // 10009 = TRADE_ACCEPTED (final success)
  deal: number;         // deal ticket
  order: number;        // order ticket — USE THIS as position id for close/modify
  volumeRaw: number;    // executed volume (raw units)
  price: number;        // execution price
  comment: string;
}

export interface Mt5Position {
  id: number;           // position id
  order: number;        // order ticket (== id on Exness)
  symbol: string;
  side: TradeSide;
  openTime: number;     // epoch ms
  openPrice: number;
  sl: number;
  tp: number;
  lots: number;
  profit: number;
  swap: number;
  comment: string;
  magic: number;
}

/** A PENDING (limit/stop) order — cmd-4's trailing section.
 *  Layout VERIFIED LIVE 2026-09-30 (probe-p5): place → parse → cancel. */
export interface Mt5Order {
  ticket: number;       // order ticket
  symbol: string;
  orderType: number;    // 0=BUY 1=SELL 2=BUY_LIMIT 3=SELL_LIMIT 4=BUY_STOP 5=SELL_STOP (6/7 stop-limit)
  timeSetup: number;    // epoch ms
  timeExpiration: number; // epoch sec (0 = GTC)
  price: number;        // limit/stop price
  priceTrigger: number; // stop-limit trigger
  priceCurrent: number; // current market
  sl: number;
  tp: number;
  lots: number;         // remaining volume (lots)
  lotsInitial: number;
  state: number;        // 1=placed/active, 2=canceled, 4=filled, 5=rejected
  positionId: number;   // linked position once filled
  comment: string;
}
export const ORDER_TYPE_NAMES: Record<number, string> = {
  0: "BUY", 1: "SELL", 2: "BUY LIMIT", 3: "SELL LIMIT", 4: "BUY STOP", 5: "SELL STOP",
  6: "BUY STOP-LIMIT", 7: "SELL STOP-LIMIT",
};

export interface Mt5Deal {
  deal: number;
  order: number;
  positionId: number;
  symbol: string;
  side: TradeSide;
  entry: "in" | "out" | "inout" | "outby";
  time: number;         // epoch ms
  price: number;
  volume: number;       // lots
  profit: number;
  commission: number;
  swap: number;
  comment: string;
}

export const TRADE_RETCODES: Record<number, string> = {
  0: "SUCCESS", 10002: "ACK (processing)", 10009: "ACCEPTED",
  10013: "INVALID_PARAMETERS", 10014: "INVALID_VOLUME", 10015: "INVALID_PRICE",
  10016: "INVALID_STOPS", 10017: "TRADE_DISABLED", 10018: "MARKET_CLOSED",
  10019: "NO_MONEY", 10023: "NO_RESULT", 10030: "INVALID_TRADE_ACTION",
  10036: "POSITION_NOT_EXISTS",
};
const MT5_DEBUG = !!process.env.MT5_DEBUG;

// ── trading helpers ──
const OP_SIZE = 248;
const AP_SIZE = 128;
const PP_SIZE = 4 + OP_SIZE + AP_SIZE; // 380
const POS_SIZE = 344;
const DEAL_SIZE = 356;
const ORDER_SIZE = 356;
const LOTS_RAW = 100_000_000; // 0.01 lots = 1,000,000 raw (verified vs P/L math)

function buildOp(opts: {
  action: number;          // 3=market, 5=pending, 6=modify-deal, 7=modify-order, 8=cancel
  symbol: string;
  volumeRaw: number;
  digits: number;
  type: number;            // 0=buy, 1=sell (2..7 pending variants)
  filling: number;         // 0=FOK, 1=IOC, 2=RETURN
  price: number;
  sl: number;
  tp: number;
  order?: number;          // order ticket (cancel/modify-order)
  position?: number;       // position/order ticket (close/modify-deal)
  comment?: string;
  deviation?: number;      // v12: max slippage in POINTS (0 = broker default)
}): Buffer {
  const op = Buffer.alloc(OP_SIZE);
  op.writeUInt32LE(0, 0);                                         // action_id = 0 (ALWAYS for new orders — non-zero → 10013)
  op.writeUInt32LE(opts.action, 4);                               // trade_action
  Buffer.from(opts.symbol, "utf16le").copy(op, 8);                // symbol (64B)
  op.writeBigUInt64LE(BigInt(Math.max(0, Math.round(opts.volumeRaw))), 72); // volume
  op.writeUInt32LE(opts.digits, 80);                              // digits
  op.writeBigUInt64LE(BigInt(opts.order ?? 0), 84);               // trade_order
  op.writeUInt32LE(opts.type, 92);                                // trade_type
  op.writeUInt32LE(opts.filling, 96);                             // type_filling
  op.writeUInt32LE(0, 100);                                       // type_time GTC
  op.writeUInt32LE(2, 104);                                       // type_flags = new order
  op.writeUInt32LE(0, 108);                                       // type_reason
  op.writeDoubleLE(opts.price, 112);                              // price_order
  op.writeDoubleLE(0, 120);                                       // price_trigger
  op.writeDoubleLE(opts.sl, 128);                                 // SL
  op.writeDoubleLE(opts.tp, 136);                                 // TP
  op.writeUInt32LE(Math.max(0, Math.min(1000, Math.round(opts.deviation ?? 0))), 144); // deviation (v12)
  op.writeDoubleLE(0, 148);                                       // price_top
  op.writeDoubleLE(0, 156);                                       // price_bottom
  if (opts.comment) Buffer.from(opts.comment.slice(0, 31), "utf16le").copy(op, 164); // comment 64B
  op.writeBigUInt64LE(BigInt(opts.position ?? 0), 228);           // trade_position
  op.writeBigUInt64LE(0n, 236);                                   // position_by
  op.writeUInt32LE(0, 244);                                       // expiration
  return op;
}

interface PendingTrade {
  resolve: (r: TradeResult) => void;
  timer: ReturnType<typeof setTimeout>;
  op: Buffer;               // the request Op — used to match OUR event among account-wide pushes
  label: string;            // human tag for debug logs
}

// ── crypto ──
function aesEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const pad = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(pad, pad)]);
  return createCipheriv("aes-256-cbc", key, ZERO_IV).update(padded);
}
function aesDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const dec = createDecipheriv("aes-256-cbc", key, ZERO_IV);
  const pt = Buffer.concat([dec.update(ciphertext), dec.final()]);
  const p = pt[pt.length - 1];
  if (p >= 1 && p <= 16 && pt.subarray(pt.length - p).every((b) => b === p)) {
    return pt.subarray(0, pt.length - p);
  }
  return pt;
}

// ── framing ──
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
interface Mt5Response { tag: number; cmdId: number; resCode: number; body: Buffer; }
function parseResponse(plain: Buffer): Mt5Response | null {
  if (plain.length < 5) return null;
  return {
    tag: plain.readUInt16LE(0),
    cmdId: plain.readUInt16LE(2),
    resCode: plain[4],
    body: plain.subarray(5),
  };
}
function utf16(buf: Buffer): string {
  const s = buf.toString("utf16le");
  const nul = s.indexOf("\u0000");
  return nul >= 0 ? s.slice(0, nul) : s;
}

export class Mt5WsClient {
  private ws: WebSocket;
  private sessionKey: Buffer | null = null;
  private waiters = new Map<number, Array<(r: Mt5Response) => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private consecFails = 0; // consecutive protocol failures → force reconnect
  private consecFailsByCmd = new Map<number, number>(); // v11: per-cmdId wedge counters
  private quoteHandler: ((q: LiveQuote) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  // trading: cmd-19 trade events matched FIFO (trades are serialized)
  private pendingTrades: PendingTrade[] = [];
  private tradeEventHandler: ((ev: { kind: "trade" | "pos_update" | "acct_update"; retcode?: number; order?: number; positionId?: number; symbol?: string; side?: TradeSide; volume?: number; price?: number; profit?: number }) => void) | null = null;
  closed = false;
  readonly host: string;
  lastRecvAt = Date.now();

  private constructor(ws: WebSocket, host: string) {
    this.ws = ws;
    this.host = host;
  }

  static async connect(host: string, timeoutMs = 8000): Promise<Mt5WsClient> {
    const url = `wss://${host}:443/terminal`;
    // v12 SECURITY (the audit's Critical #4): we used to dial the gateway by
    // IP with rejectUnauthorized:false — a MITM on the path could harvest the
    // MT5 login/password and silently rewrite trades. The gateways present a
    // *.exwebterm.com certificate, so we now send an SNI inside that domain
    // and VERIFY the chain. Escape hatch (only if a gateway ever serves a
    // mismatched cert): MT5_TLS_INSECURE=1 re-enables the old behaviour and
    // logs a loud warning.
    const insecure = process.env.MT5_TLS_INSECURE === "1";
    if (insecure) {
      console.warn("[mt5-client] ⚠ MT5_TLS_INSECURE=1 — certificate verification DISABLED (emergency mode)");
    }
    const ws = new WebSocket(url, {
      headers: {
        Origin: `https://${host}:443`,
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      ...(insecure
        ? { tls: { rejectUnauthorized: false } }
        : { servername: "mt5.exwebterm.com", tls: { rejectUnauthorized: true } }),
    } as any) as WebSocket;
    ws.binaryType = "arraybuffer";

    const client = await new Promise<Mt5WsClient>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`WS connect timeout (${url})`)),
        timeoutMs,
      );
      ws.onopen = () => { clearTimeout(t); resolve(new Mt5WsClient(ws, host)); };
      ws.onerror = () => { clearTimeout(t); reject(new Error(`WS connect failed (${url})`)); };
    });

    ws.onmessage = (ev: MessageEvent) => {
      client.lastRecvAt = Date.now();
      if (!(ev.data instanceof ArrayBuffer)) return;
      const raw = Buffer.from(ev.data);
      if (raw.length <= 8) return;
      const key = client.sessionKey ?? STATIC_KEY;
      let plain: Buffer;
      try { plain = aesDecrypt(key, raw.subarray(8)); } catch { return; }
      const resp = parseResponse(plain);
      if (!resp) return;
      if (resp.cmdId === CMD.QUOTES) { client.emitQuotes(resp.body); return; }
      // ── trading pushes ──
      if (resp.cmdId === CMD.TRADE_EVENT) { client.handleTradeEvent(resp.body); return; }
      if (resp.cmdId === 22 || resp.cmdId === 14) {
        client.tradeEventHandler?.({ kind: resp.cmdId === 22 ? "pos_update" : "acct_update" });
        return;
      }
      const q = client.waiters.get(resp.cmdId);
      if (q && q.length) {
        q.shift()!(resp);
        if (!q.length) client.waiters.delete(resp.cmdId);
      }
    };
    ws.onclose = () => {
      if (!client.closed) {
        client.closed = true;
        client.onCloseCb?.();
      }
    };
    ws.onerror = () => {
      if (!client.closed) {
        client.closed = true;
        try { ws.close(); } catch {}
        client.onCloseCb?.();
      }
    };
    return client;
  }

  get isOpen() { return !this.closed && this.ws.readyState === WebSocket.OPEN; }
  onClose(cb: () => void) { this.onCloseCb = cb; }
  onQuotes(h: (q: LiveQuote) => void) { this.quoteHandler = h; }
  onTradeEvent(h: (ev: { kind: "trade" | "pos_update" | "acct_update"; retcode?: number; order?: number; positionId?: number; symbol?: string; side?: TradeSide; volume?: number; price?: number; profit?: number }) => void) { this.tradeEventHandler = h; }

  /** cmd 19 push — 380B: [seq u32][Op 248B][Ap 128B].
   *
   *  CRITICAL (Sep-29 incident, root cause): cmd-19 pushes are ACCOUNT-WIDE —
   *  they fire for trades from OTHER connections on the same login AND for
   *  server-side SL/TP closes. Matching them to pending requests FIFO stole
   *  foreign results (a failed modify's 10036 answered an unrelated open;
   *  a server-side close's 10009 "confirmed" a close that never executed →
   *  phantom settles → re-adopt churn).
   *
   *  FIX: the event carries an Op echo of the request that produced it. Match
   *  the event to the pending request by IDENTITY (action, symbol, volume,
   *  type, position ticket). Unmatched non-ACK events are FOREIGN — they go
   *  to the handler only and never resolve anything. */
  private handleTradeEvent(body: Buffer) {
    try {
      if (body.length < PP_SIZE) return;
      const apOff = 4 + OP_SIZE;                     // 252
      const retcode = body.readUInt32LE(apOff);
      const order = Number(body.readBigInt64LE(apOff + 12));
      const result: TradeResult = {
        retcode,
        deal: Number(body.readBigInt64LE(apOff + 4)),
        order,
        volumeRaw: Number(body.readBigInt64LE(apOff + 20)),
        price: body.readDoubleLE(apOff + 28),
        comment: utf16(body.subarray(apOff + 64, apOff + 128)),
      };
      // Op echo sits right after the 4-byte seq
      const opEcho = body.subarray(4, 4 + OP_SIZE);
      const ev = {
        action: opEcho.readUInt32LE(4),
        symbol: utf16(opEcho.subarray(8, 72)),
        volumeRaw: Number(opEcho.readBigUInt64LE(72)),
        type: opEcho.readUInt32LE(92),
        position: Number(opEcho.readBigUInt64LE(228)),
        sl: opEcho.readDoubleLE(128),
        tp: opEcho.readDoubleLE(136),
      };
      if (MT5_DEBUG) {
        // rate-limited: a stuck foreign source can push the same dead-position
        // event dozens of times per second — one line per 10s per retcode
        const nowMs = Date.now();
        const dbgKey = (globalThis as unknown as { __mt5DbgAt?: number; __mt5DbgRc?: number });
        const sameRc = dbgKey.__mt5DbgRc === retcode;
        if (!sameRc || nowMs - (dbgKey.__mt5DbgAt ?? 0) > 10_000) {
          dbgKey.__mt5DbgAt = nowMs;
          dbgKey.__mt5DbgRc = retcode;
          console.log(
            `[mt5] cmd19 rc=${retcode} ${TRADE_RETCODES[retcode] ?? "?"} echo{sym=${ev.symbol} act=${ev.action} type=${ev.type} vol=${ev.volumeRaw / 1e8} pos=${ev.position} order=${order} price=${result.price}` +
            ` sl=${ev.sl} tp=${ev.tp}} pend=${this.pendingTrades.length}${this.pendingTrades.length ? ` head=${this.pendingTrades[0].label}` : ""}`,
          );
        }
      }
      if (retcode === 10002) return; // ACK — not a result

 // resolve only the pending request whose Op IDENTITY matches this event
      let matched = -1;
      for (let i = 0; i < this.pendingTrades.length; i++) {
        const p = this.pendingTrades[i];
        const req = p.op;
        const same =
          req.readUInt32LE(4) === ev.action &&
          utf16(req.subarray(8, 72)) === ev.symbol &&
          Number(req.readBigUInt64LE(72)) === ev.volumeRaw &&
          req.readUInt32LE(92) === ev.type &&
          Number(req.readBigUInt64LE(228)) === ev.position;
        if (same) { matched = i; break; }
      }
      if (matched >= 0) {
        const pend = this.pendingTrades.splice(matched, 1)[0];
        clearTimeout(pend.timer);
        if (MT5_DEBUG) console.log(`[mt5] cmd19 → resolved "${pend.label}" (identity match)`);
        pend.resolve(result);
      } else if (this.pendingTrades.length && MT5_DEBUG) {
        console.log(`[mt5] cmd19 FOREIGN (no identity match) — pending kept: ${this.pendingTrades.map((t) => t.label).join(",")}`);
      }
      this.tradeEventHandler?.({
        kind: "trade", retcode, order,
        positionId: order,
      });
    } catch { /* never die on a malformed trade event */ }
  }

  private emitQuotes(body: Buffer) {
    const n = Math.floor(body.length / 50);
    for (let i = 0; i < n; i++) {
      const off = i * 50;
      if (off + 50 > body.length) break;
      this.quoteHandler?.({
        symbolId: body.readUInt32LE(off),
        timeSec: body.readInt32LE(off + 4),
        bidRaw: body.readDoubleLE(off + 12),
        askRaw: body.readDoubleLE(off + 20),
      });
    }
  }

  private send(cmdId: number, payload: Buffer, key?: Buffer) {
    const k = key ?? this.sessionKey;
    if (!k) throw new Error("no session key");
    this.ws.send(frame(aesEncrypt(k, buildCommand(cmdId, payload))));
  }

  /** Serialize requests that share a cmd_id (responses are matched FIFO). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private async request(
    cmdId: number,
    payload: Buffer = Buffer.alloc(0),
    key?: Buffer,
    timeoutMs = 15000,
  ): Promise<Mt5Response> {
    // ── v10.3 ── never queue work on a session the manager has already put
    //    down (recycle/wedge escape) — it would just time out 15 s later and
    //    inflate the failure counter of a dead object.
    if (this.closed) throw new Error("mt5 not connected (session closed)");
    if (!this.waiters.has(cmdId)) this.waiters.set(cmdId, []);
    const queue = this.waiters.get(cmdId)!;
    let waiter!: (r: Mt5Response) => void;
    const p = new Promise<Mt5Response>((resolve) => {
      waiter = resolve;
      queue.push(waiter);
    });
    this.send(cmdId, payload, key);
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      // ── DEAD-WAITER HYGIENE (the Sep 28 stale-candle root cause) ──
      // Responses are matched to requests POSITIONALLY (FIFO per cmdId).
      // A timed-out request used to leave its resolve callback in the queue,
      // so every later response was delivered to the PREVIOUS (dead) waiter
      // and each request received the WRONG window's data — the candle cache
      // kept being replaced with 30-minute-old bars. Remove OUR waiter so a
      // late response finds an empty queue (dropped harmlessly) and the next
      // request matches its own response again.
      const idx = queue.indexOf(waiter);
      if (idx >= 0) queue.splice(idx, 1);
      if (!queue.length) this.waiters.delete(cmdId);
      // ── v10.3 DEAD-SESSION SILENCE ── a closed client is the manager's
      // business now (it owns reconnection). The Sep-30 storm logs showed a
      // dying session's leftover timers climbing "6,7,8,9 consecutive
      // request failures — forcing reconnect" on an already-dead socket,
      // each re-calling close() — pure noise that masked the real state.
      if (this.closed) {
        timeoutRej(new Error(`timeout waiting cmd ${cmdId} (session already closed)`));
        return;
      }
      // per-cmd failure count (v11) — only the SAME cmd's success resets it
      const cmdFails = (this.consecFailsByCmd.get(cmdId) ?? 0) + 1;
      this.consecFailsByCmd.set(cmdId, cmdFails);
      if (cmdFails >= 2) {
        // this command's waiter chain is wedged beyond repair (other cmds may
        // still flow) — force a clean reconnect
        console.error(`[mt5-client] cmd ${cmdId} wedged (${cmdFails} consecutive timeouts) — forcing reconnect`);
        this.consecFailsByCmd.delete(cmdId);
        this.close();
      }
      if (++this.consecFails >= 3) {
        // session is wedged beyond repair — force a clean reconnect
        console.error(`[mt5-client] ${this.consecFails} consecutive request failures — forcing reconnect`);
        this.close();
      }
      timeoutRej(new Error(`timeout waiting cmd ${cmdId}`));
    }, timeoutMs);
    let timeoutRej!: (e: Error) => void;
    const t = new Promise<never>((_, rej) => { timeoutRej = rej; });
    try {
      const r = await Promise.race([p, t]);
      // ── v11 PER-CMD WEDGE COUNTERS ── a session can wedge for ONE command
      // (cmd-4 dies while quotes/deals/candles still flow — the Sep-30
      // livelock). A GLOBAL counter kept getting reset by healthy requests on
      // OTHER cmd ids, so the wedged command never accumulated failures and
      // the client never reconnected. Count per cmdId: only success of the
      // SAME command resets its counter.
      this.consecFailsByCmd.delete(cmdId);
      this.consecFails = 0;
      return r;
    } finally {
      if (timer) clearTimeout(timer);
      const idx = queue.indexOf(waiter);
      if (idx >= 0) queue.splice(idx, 1);
      if (!queue.length) this.waiters.delete(cmdId);
    }
  }

  async auth(): Promise<Buffer> {
    const r = await this.request(CMD.AUTH, Buffer.alloc(64), STATIC_KEY);
    if (r.resCode !== 0) throw new Error(`AUTH failed: res_code=${r.resCode}`);
    this.sessionKey = Buffer.from(r.body.subarray(r.body.length - 32));
    return this.sessionKey;
  }

  async login(login: number, password: string): Promise<bigint> {
    const h = Buffer.alloc(912);
    Buffer.from(password, "utf16le").copy(h, 4);
    h.writeUInt32LE(this.host.length, 476);
    Buffer.from(this.host, "utf16le").copy(h, 480);
    h.writeBigUInt64LE(BigInt(login), 736);
    const r = await this.request(CMD.LOGIN, h);
    if (r.resCode !== 0) {
      throw new Error(
        `LOGIN failed: res_code=${r.resCode} body=${r.body.toString("hex").slice(0, 96)}`,
      );
    }
    return r.body.length >= 168 ? r.body.readBigUInt64LE(160) : 0n;
  }

  async account(): Promise<AccountInfo> {
    const r = await this.request(CMD.ACCOUNT);
    const b = r.body;
    return {
      login: 0,
      balance: b.readDoubleLE(9),
      equity: b.length >= 25 ? b.readDoubleLE(17) : b.readDoubleLE(9),
      currency: utf16(b.subarray(25, 25 + 64)),
      group: utf16(b.subarray(97, 97 + 256)),
      server: utf16(b.subarray(355, 355 + 128)),
    };
  }

  async symbols(): Promise<Map<string, SymbolInfo>> {
    const r = await this.request(CMD.SYMBOLS_GZ, undefined, undefined, 20000);
    let decompressed: Buffer;
    const blob = r.body.subarray(4);
    try { decompressed = gunzipSync(blob); }
    catch { try { decompressed = inflateSync(blob); } catch { decompressed = inflateRawSync(blob); } }
    const count = decompressed.readUInt32LE(0);
    const map = new Map<string, SymbolInfo>();
    let off = 4;
    const REC = 526;
    for (let i = 0; i < count && off + REC <= decompressed.length; i++, off += REC) {
      const name = utf16(decompressed.subarray(off, off + 64));
      const digits = decompressed.readUInt32LE(off + 192);
      const id = decompressed.readUInt32LE(off + 196);
      if (name) map.set(name, { id, digits, name });
    }
    return map;
  }

  /** A response was parsed but failed request-level validation — count it
   *  toward the reconnect circuit breaker (wrong-window data is worse than
   *  no data: it once froze the chart for 30 minutes). */
  noteProtocolError(what: string) {
    if (++this.consecFails >= 3) {
      console.error(`[mt5-client] ${this.consecFails} consecutive protocol errors (${what}) — forcing reconnect`);
      this.close();
    }
  }

  async candles(
    symbol: string, tf: number, fromSec: number, toSec: number,
  ): Promise<Mt5Candle[]> {
    return this.run(async () => {
      const pl = Buffer.alloc(74);
      Buffer.from(symbol, "utf16le").copy(pl, 0);
      pl.writeUInt16LE(tf, 64);
      pl.writeInt32LE(fromSec, 66);
      pl.writeInt32LE(toSec, 70);
      const r = await this.request(CMD.CANDLES, pl, undefined, 25000);
      const out: Mt5Candle[] = [];
      for (let off = 0; off + 48 <= r.body.length; off += 48) {
        const b = r.body;
        out.push({
          time: b.readInt32LE(off),
          open: b.readDoubleLE(off + 4),
          high: b.readDoubleLE(off + 12),
          low: b.readDoubleLE(off + 20),
          close: b.readDoubleLE(off + 28),
          tickVolume: Number(b.readBigInt64LE(off + 36)),
          spread: b.readInt32LE(off + 44),
        });
      }
      // ── WINDOW VALIDATION (never return another request's data) ──
      // If the FIFO response matching ever mis-delivers, this is the wall
      // the wrong payload hits: every bar must belong to the window we asked
      // for (± one day of slack so wide backfill windows stay valid). A
      // mismatch throws instead of poisoning the candle cache with a
      // different request's bars.
      const slack = 86400;
      for (const b of out) {
        if (b.time < fromSec - slack || b.time > toSec + slack) {
          this.noteProtocolError(`candles window mismatch ${symbol} tf=${tf} bar@${b.time} ∉ [${fromSec},${toSec}]`);
          throw new Error(
            `candles response outside requested window (bar ${b.time}, window [${fromSec}, ${toSec}]) — possible response mismatch`,
          );
        }
      }
      return out;
    });
  }

  subscribe(...symbolIds: number[]) {
    const pl = Buffer.alloc(4 + 4 * symbolIds.length);
    pl.writeUInt32LE(symbolIds.length, 0);
    symbolIds.forEach((id, i) => pl.writeUInt32LE(id, 4 + 4 * i));
    this.send(CMD.SUBSCRIBE, pl);
  }

  heartbeat() { this.send(CMD.HEARTBEAT, Buffer.alloc(0)); }
  close() { this.closed = true; try { this.ws.close(); } catch {} }

  // ═════════════════════════════ trading ═════════════════════════════

  /** Send a trade request and wait for OUR cmd-19 event (identity-matched —
   *  see handleTradeEvent). Callers should serialize (the trader does). */
  private async sendTradeAndWait(op: Buffer, timeoutMs = 12000, label = ""): Promise<TradeResult> {
    let resolveFn: (r: TradeResult) => void = () => {};
    const p = new Promise<TradeResult>((resolve) => {
      resolveFn = resolve;
      const timer = setTimeout(() => {
        const idx = this.pendingTrades.findIndex((t) => t.resolve === resolveFn);
        if (idx >= 0) this.pendingTrades.splice(idx, 1);
        resolve({ retcode: -1, deal: 0, order: 0, volumeRaw: 0, price: 0, comment: "timeout" });
      }, timeoutMs);
      this.pendingTrades.push({ resolve: resolveFn, timer, op, label });
    });
    let imm: Mt5Response;
    try {
      imm = await this.request(CMD.TRADE, op, undefined, timeoutMs);
    } catch (e) {
      const idx = this.pendingTrades.findIndex((t) => t.resolve === resolveFn);
      if (idx >= 0) { const pend = this.pendingTrades.splice(idx, 1)[0]; clearTimeout(pend.timer); }
      throw e;
    }
    // immediate hard error (body[0:4] = retcode) → resolve now, don't wait for event
    if (imm.body.length >= 4) {
      const rc = imm.body.readUInt32LE(0);
      if (rc !== 0 && rc !== 10002 && rc !== 10009) {
        const idx = this.pendingTrades.findIndex((t) => t.resolve === resolveFn);
        if (idx >= 0) { const pend = this.pendingTrades.splice(idx, 1)[0]; clearTimeout(pend.timer); }
        return { retcode: rc, deal: 0, order: 0, volumeRaw: 0, price: 0, comment: TRADE_RETCODES[rc] ?? "error" };
      }
    }
    return p;
  }

  /** Market BUY/SELL with optional SL/TP (0 = none). Returns the final result —
   *  `order` is the ticket to use for close/modify. */
  async marketOrder(
    symbol: string, side: TradeSide, lots: number,
    opts?: { sl?: number; tp?: number; comment?: string; digits?: number },
  ): Promise<TradeResult> {
    const digits = opts?.digits ?? 2;
    // v12: FOK is rejected by Exness on fast markets (10030) — send IOC with a
    // 50-point deviation budget, then fall back FOK → RETURN if unsupported.
    return this.sendMarketWithFillLadder(symbol, side, lots, 0, opts, digits, "market");
  }

  /** Market order at an explicit price (ask for buy, bid for sell). */
  async marketOrderAt(
    symbol: string, side: TradeSide, lots: number, price: number,
    opts?: { sl?: number; tp?: number; comment?: string; digits?: number },
  ): Promise<TradeResult> {
    const digits = opts?.digits ?? 2;
    return this.sendMarketWithFillLadder(symbol, side, lots, price, opts, digits, `open:${symbol}:${side}:${lots}`);
  }

  /** v12 — market order / close with a FILLING-MODE LADDER:
   *  IOC(1) → FOK(0) → RETURN(2). A 10030 (unsupported filling) on one mode
   *  retries the next, so a "close failed, position burning" (the audit's
   *  High #9) can no longer happen because the broker disliked FOK. All
   *  attempts carry a 50-point deviation so gold's spread-widening doesn't
   *  reject our own exit. */
  private async sendMarketWithFillLadder(
    symbol: string, side: TradeSide, lots: number, price: number,
    opts: { sl?: number; tp?: number; comment?: string; position?: number } | undefined,
    digits: number, label: string,
  ): Promise<TradeResult> {
    const ladder: number[] = [1, 0, 2]; // IOC → FOK → RETURN
    let last: TradeResult = { retcode: -1, deal: 0, order: 0, volumeRaw: 0, price: 0, comment: "no attempt" };
    for (const filling of ladder) {
      const op = buildOp({
        action: 3, symbol,
        volumeRaw: Math.round(lots * LOTS_RAW),
        digits,
        type: side === "buy" ? 0 : 1,
        filling,
        price,
        sl: opts?.sl ?? 0,
        tp: opts?.tp ?? 0,
        comment: opts?.comment,
        deviation: 50,
        ...(opts?.position ? { position: opts.position } : {}),
      });
      last = await this.sendTradeAndWait(op, 12000, `${label}:fill${filling}`);
      if (last.retcode !== 10030) return last; // filled / real error → done
      // 10030 = this filling mode unsupported → try the next mode
    }
    return last;
  }

  /** Close an open position: MARKET order in the OPPOSITE direction with the
   *  position's order ticket (trade_action=3, NOT 10 — 10 returns 10030).
   *  v12: close rides the SAME filling ladder + deviation as opens — a close
   *  must never be stranded by an FOK rejection on a fast market. The
   *  position ticket rides EVERY ladder attempt (without it the broker would
   *  OPEN a hedge instead of closing — that must be impossible). */
  async closePosition(
    symbol: string, side: TradeSide, lots: number, price: number,
    positionTicket: number, opts?: { digits?: number; comment?: string },
  ): Promise<TradeResult> {
    const digits = opts?.digits ?? 2;
    const opposite: TradeSide = side === "buy" ? "sell" : "buy";
    return this.sendMarketWithFillLadder(
      symbol, opposite, lots, price,
      { comment: opts?.comment ?? "close", position: positionTicket },
      digits,
      `close:${symbol}#${positionTicket}:${lots}`,
    );
  }

  /** Modify SL/TP of an open position (trade_action=6).
   *  positionTicket = the position id (== opening order ticket).
   *  VERIFIED LIVE (Sep-29, probe-modify variant A): the server requires the
   *  ticket in BOTH @84 (trade_order) AND @228 (trade_position) — with @84=0
   *  every modify failed 10036 POSITION_NOT_EXISTS (breakeven/trail never ran). */
  async modifyPosition(
    symbol: string, side: TradeSide, lots: number, price: number,
    positionTicket: number, sl: number, tp: number,
    opts?: { digits?: number },
  ): Promise<TradeResult> {
    const op = buildOp({
      action: 6, symbol,
      volumeRaw: Math.round(lots * LOTS_RAW),
      digits: opts?.digits ?? 2,
      type: side === "buy" ? 0 : 1, // ORIGINAL direction for modify
      filling: 2, // RETURN
      price,
      sl, tp,
      order: positionTicket,
      position: positionTicket,
    });
    return this.sendTradeAndWait(op, 12000, `mod:${symbol}#${positionTicket}:${lots}`);
  }

  /** Positions + PENDING orders. cmd 4 → [posCount][positions×344][ordCount][orders×356].
   *  The trailing order records are the account's PENDING (limit/stop) orders
   *  — VERIFIED live: placed a buy-limit via cmd-12 action 5, appeared here,
   *  canceled via action 8. v11: they are PARSED (the user's pending orders
   *  must be mirrored in the app in real time). */
  async positions(): Promise<{ positions: Mt5Position[]; pendingOrders: number; orders: Mt5Order[] }> {
    // 2.5s timeout — a healthy cmd-4 answers in ~40-150ms (16× headroom);
    // the old 15s let a wedged waiter chain block the sync loop for 15s per
    // attempt (v11). With the per-cmd wedge counter at 2, a wedged cmd-4 is
    // detected and recycled within ~5s.
    const r = await this.request(CMD.POSITIONS, undefined, undefined, 2500);
    const b = r.body;
    const positions: Mt5Position[] = [];
    let off = 0;
    const posCount = b.length >= 4 ? b.readUInt32LE(0) : 0;
    off = 4;
    for (let i = 0; i < posCount && off + POS_SIZE <= b.length; i++, off += POS_SIZE) {
      positions.push({
        id: Number(b.readBigInt64LE(off)),
        order: Number(b.readBigInt64LE(off + 8)),
        openTime: b.readUInt32LE(off + 16) * 1000 + b.readInt32LE(off + 336),
        symbol: utf16(b.subarray(off + 24, off + 88)),
        side: b.readUInt32LE(off + 88) === 0 ? "buy" : "sell",
        openPrice: b.readDoubleLE(off + 92),
        sl: b.readDoubleLE(off + 108),
        tp: b.readDoubleLE(off + 116),
        lots: Number(b.readBigUInt64LE(off + 124)) / LOTS_RAW,
        profit: b.readDoubleLE(off + 132),
        swap: b.readDoubleLE(off + 164),
        comment: utf16(b.subarray(off + 188, off + 252)),
        magic: b.readUInt32LE(off + 268),
      });
    }
    // ── PENDING ORDERS (ORDER_SCHEMA, all offsets verified live) ──
    const orders: Mt5Order[] = [];
    if (off + 4 <= b.length) {
      const ordCount = Math.min(b.readUInt32LE(off), Math.floor((b.length - off - 4) / ORDER_SIZE));
      off += 4;
      for (let i = 0; i < ordCount && off + ORDER_SIZE <= b.length; i++, off += ORDER_SIZE) {
        const o = b.subarray(off, off + ORDER_SIZE);
        orders.push({
          ticket: Number(o.readBigInt64LE(0)),
          symbol: utf16(o.subarray(72, 136)),
          orderType: o.readUInt32LE(148),
          timeSetup: o.readUInt32LE(136) * 1000 + o.readInt32LE(348),
          timeExpiration: o.readUInt32LE(140),
          price: o.readDoubleLE(164),
          priceTrigger: o.readDoubleLE(172),
          priceCurrent: o.readDoubleLE(180),
          sl: o.readDoubleLE(188),
          tp: o.readDoubleLE(196),
          lotsInitial: Number(o.readBigInt64LE(204)) / LOTS_RAW,
          lots: Number(o.readBigInt64LE(212)) / LOTS_RAW,
          state: o.readUInt32LE(220),
          positionId: Number(o.readBigInt64LE(232)),
          comment: utf16(o.subarray(240, 304)),
        });
      }
      return { positions, pendingOrders: orders.length, orders };
    }
    return { positions, pendingOrders: 0, orders };
  }

  /** Place a PENDING order (limit/stop). VERIFIED LIVE 2026-09-30 (probe-p5):
   *  action=5, type 2..5, filling=RETURN(2), price_order=trigger price,
   *  volume raw = lots×10^8. Accepts 10009 + order ticket. */
  async pendingOrder(
    symbol: string, orderType: 2 | 3 | 4 | 5, lots: number, price: number,
    opts?: { sl?: number; tp?: number; digits?: number; comment?: string },
  ): Promise<TradeResult> {
    const op = buildOp({
      action: 5, symbol,
      volumeRaw: Math.round(lots * LOTS_RAW),
      digits: opts?.digits ?? 2,
      type: orderType,
      filling: 2, // RETURN — FOK is rejected for pendings (10030)
      price,
      sl: opts?.sl ?? 0,
      tp: opts?.tp ?? 0,
      comment: opts?.comment,
    });
    return this.sendTradeAndWait(op, 12000, `pending:${symbol}:${orderType}:${price}`);
  }

  /** Cancel a PENDING order (action 8). VERIFIED LIVE: needs the ORIGINAL
   *  order type + original price + ticket at trade_order (@84). */
  async cancelOrder(
    symbol: string, orderType: number, lots: number, price: number, ticket: number,
    opts?: { digits?: number },
  ): Promise<TradeResult> {
    const op = buildOp({
      action: 8, symbol,
      volumeRaw: Math.round(lots * LOTS_RAW),
      digits: opts?.digits ?? 2,
      type: orderType, // must MATCH the original (else 10023)
      filling: 2,
      price,
      sl: 0, tp: 0,
      order: ticket,
    });
    return this.sendTradeAndWait(op, 12000, `cancel:${symbol}#${ticket}`);
  }

  /** Deal history. cmd 5 → [dealCount][deals×356][ordCount][orders×356]. */
  async deals(fromSec = 0, toSec = 0): Promise<Mt5Deal[]> {
    const pl = Buffer.alloc(8);
    pl.writeUInt32LE(fromSec, 0);
    pl.writeUInt32LE(toSec, 4);
    const r = await this.request(CMD.DEALS, pl, undefined, 15000);
    const b = r.body;
    const deals: Mt5Deal[] = [];
    const count = b.length >= 4 ? b.readUInt32LE(0) : 0;
    let off = 4;
    for (let i = 0; i < count && off + DEAL_SIZE <= b.length; i++, off += DEAL_SIZE) {
      const entryCode = b.readUInt32LE(off + 156);
      deals.push({
        deal: Number(b.readBigInt64LE(off)),
        order: Number(b.readBigInt64LE(off + 72)),
        positionId: Number(b.readBigInt64LE(off + 248)),
        symbol: utf16(b.subarray(off + 88, off + 152)),
        side: b.readUInt32LE(off + 152) === 0 ? "buy" : "sell",
        entry: entryCode === 0 ? "in" : entryCode === 1 ? "out" : "inout",
        time: b.readUInt32LE(off + 80) * 1000 + b.readInt32LE(off + 340),
        price: b.readDoubleLE(off + 160),
        volume: Number(b.readBigUInt64LE(off + 192)) / LOTS_RAW,
        profit: b.readDoubleLE(off + 200),
        commission: b.readDoubleLE(off + 224),
        swap: b.readDoubleLE(off + 232),
        comment: utf16(b.subarray(off + 256, off + 320)),
      });
    }
    return deals;
  }
}
