# MT5 Direct-Protocol Cheat-Sheet (Exness-MT5Trial6)

Verified live on 2026-09-27 from this Linux sandbox with account <your-login>.
Two protocols are spoken by the same IPs on port 443:

| | Native TCP (desktop terminal) | WebSocket (web terminal) |
|---|---|---|
| URL / transport | raw TCP `IP:443`, **no TLS** | `wss://IP:443/terminal` (TLS, cert `*.exwebterm.com`) |
| Crypto | XOR chain cipher + streaming-MD5 challenge | AES-256-CBC (zero IV) + session key |
| Status | AUTH VERIFIED (Msg=0); command layer undocumented | **FULLY WORKING** (auth, symbols, candles, quotes, trading) |
| Recommendation | fallback only | **use this** |

## 1. Server discovery

- MetaQuotes broker search (what the terminal does):
  `GET http://search.mtapi.io/Search?company=Exness-MT5Trial6&mt5=true`
  or `POST https://updates.metaquotes.net/public/mt5/network` with body
  `company=Exness-MT5Trial6&code=mt5&signature=MD5(MD5(body)+KEY32)&ver=2`
  (KEY32 = `3d7b1516d6eabb34d9d663e3623e1bd7fbdcaef4573bdf357fa8cf0beaad927f`).
- Exness-MT5Trial6 access IPs (all serve the same server, TLS cert `*.exwebterm.com`):
  `47.130.41.116, 57.182.183.85, 16.79.3.122, 18.61.99.175, 8.219.172.6,
  47.236.224.248, 47.81.62.132, 43.210.112.100, 35.154.31.85` (port 443)
- `https://IP:443/terminal` serves the web-terminal HTML; it embeds
  `window.__terminal_params = { build: 6182, trade_server_demo: "Exness-MT5Trial6", ... }`
  — use it to confirm which server a gateway serves.

## 2. WebSocket framing

Connect: `wss://47.130.41.116:443/terminal`,
headers `Origin: https://47.130.41.116:443`, TLS verification off (IP dial, cert is `*.exwebterm.com`).

Every WS binary message (both directions):

```
[payload_len:u32 LE][version:u32 LE = 1][ciphertext]
```

Ciphertext = AES-256-CBC (IV = 16 zero bytes, PKCS7) of:

```
command  (client→server): [rnd:u8][rnd:u8][cmd_id:u16 LE][payload]
response (server→client): [tag:u16 LE][cmd_id:u16 LE][res_code:u8][body]
```

Keys:
- static key for the first AUTH command (from the public web-terminal JS):
  `02de02a1a65cc794684fcbea1ecb0fd74ae657e43662c11eee885d2fd64f4964`
- session key = **last 32 bytes** of the decrypted AUTH response body; used for
  all subsequent frames in both directions.

## 3. Command set (verified)

| cmd_id | name | payload → response |
|---|---|---|
| 0 | AUTH | 64 zero bytes → [64B session token][32B session key] |
| 28 | LOGIN | 912B: password UTF-16LE @4, `len(host)` u32 @476, host UTF-16LE @480, login u64 @736 → [160B account][u64 account_ref] |
| 3 | ACCOUNT | none → 816B FL header: balance f64@9, currency(64B)@25, group(256B)@97, server(128B)@355 |
| 34 | SYMBOLS | none → 4B skip + gzip/zlib blob: [count u32][526B recs: name(64)@0, desc(128)@64, digits u32@192, **symbol_id u32@196**, path(256)@200, …] |
| 7 | SUBSCRIBE | [count u32][symbol_id u32 …] → server pushes cmd 8 |
| 8 | QUOTES (push) | body = raw 50B records (count = len/50): sym_id u32, time i32, fields u32, bid f64, ask f64, last f64, vol i64, msΔ u32, flags u16. **Prices are RAW: divide by 10^digits** |
| 11 | CANDLES | [symbol 64B UTF-16LE][tf u16][from i32][to i32] → raw 48B bars: [ts i32][open f64][high f64][low f64][close f64][tickvol i64][spread i32] (real prices) |
| 12 | TRADE | 380B Op/Op+Ap structure (see reverse-eng repo for full details) |
| 4 / 5 | POSITIONS / DEALS | none / [from u32, to u32] → [count][344B recs] / [count][356B recs] |
| 51 | HEARTBEAT | none → empty; send every 3–5 s to keep the session alive |
| 15 / 17 / 19 / 22 | SYSTEM / SYMBOL_SPEC / TRADE_EVENT / POS_UPDATE (pushes) | ignore for market data |

Timeframe constants: M1=1 M5=5 M15=15 M30=30 H1=16385 H4=16388 D1=16408 W1=32769 MN1=49153.
Max ≈ 7 000–14 000 bars per request; split larger ranges. Candle timestamps are broker
server time (Exness trial = UTC+0, empirically).

## 4. Exness specifics

- Standard symbol suffix is **"m"**: gold = `XAUUSDm` (symbol_id 442, digits 3), also
  `XAUUSD247m`; majors `EURUSDm`, crypto `BTCUSDm` (24/7) etc. Always resolve names
  from the cmd-34 symbol table, don't hardcode.
- Live ticks confirmed outside FX hours via BTCUSDm; XAUUSD ticks only while the
  gold market is open (Sun 22:00 – Fri 21:00 UTC).

## 5. Native TCP protocol (fallback, auth verified)

`connect IP:443` (plain TCP) →
1. send `[tag=0:u8][len:u32 LE][seq:u16 LE][ver=2:u16 LE][xor(34B login: tick,0,build=5500,ver=20813,login u64, hwid 16B, rnd u32)]`
2. recv 32B: session-key challenge @ offset 8..24
3. send `[tag=1][len][seq=1][ver=2][xor(34B: rnd u16, MD5x16, rnd 16B)]` where
   `MD5x = streaming-MD5: state = MD5(loginLE u64 + password UTF-16LE + "MQ" UTF-16LE), then continue hashing the 16B challenge`
4. recv → `Msg=0` = authenticated (3247B account blob follows)

XOR chain: `out[i] = in[i] ^ ((prev + K[i & 15]) & 0xFF)`, `prev = out[i]`, K =
`41 b6 7f 58 38 0c f0 2d 3b 39 08 fe 21 bb 41 58`. Commands after auth are not
publicly documented — that's why the WebSocket protocol is preferred.

## 6. References

- Full reverse-engineered protocol (source of this cheat-sheet):
  https://github.com/leon-git-21/MT5-Client-Reverse-Engineer
  (`WEBSOCKET_PROTOCOL.md`, `CONNECTION_PROTOCOL.md`, `ws_client.py`)
- Local copy of the repo used during research: `/home/z/mt5research/MT5-Client-Reverse-Engineer`
