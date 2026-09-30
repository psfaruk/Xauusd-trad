# AURUM·T — Live MT5 Gold Trading Terminal

**XAUUSD / ফরেক্স লাইভ অ্যানালাইসিস টার্মিনাল** — ডেটা আসছে সরাসরি **MetaTrader 5** থেকে (Exness-MT5Trial6), কোনো PC / MT5 টার্মিনাল / Windows ছাড়াই। ব্রাউজার + সার্ভার সব জায়গায় রিয়েল-টাইম।

![terminal](https://img.shields.io/badge/data-MetaTrader%205-gold) ![license](https://img.shields.io/badge/deploy-Railway-8bc34a)

---

## ✨ ফিচারসমূহ / Features

| | |
|---|---|
| **📈 ক্যান্ডেলস্টিক চার্ট** | lightweight-charts ইঞ্জিন, প্যান/জুম, ক্রসহেয়ার, ভলিউম, লাইভ-প্রাইস ইজিং (rAF, EASE 0.22) |
| **🎨 ড্রয়িং টুলস** | ট্রেন্ডলাইন, রে, হরাইজন্টাল/ভার্টিকাল লাইন, আয়তক্ষেত্র, ফিবোনাচি (গোল্ডেন পকেট + OTE), টেক্সট, মেজার — ড্র্যাগ/ডিলিট সহ, **ডেটাবেজে সেভ** হয় |
| **🧠 SMC অটো-ড্রয়িং** | BOS/CHoCH ডায়মন্ড, HH/HL/LH/LL সুইং লেবেল, Supply/Demand জোন, Order Block, FVG, BSL/SSL লিকুইডিটি, EQ, ট্রেন্ডলাইন প্রজেকশন, ফিব + OTE, ম্যাগনেট লেভেল, ড্র-পথ |
| **⚡ সিগন্যাল ইঞ্জিন** | মাল্টি-TF বায়াস ভোট (H4/H1/M15/M5 + EMA), ট্রিগার = SFP / জোন-রিটেস্ট / পুলব্যাক, ১৩-ফ্যাক্টর কনফ্লুয়েন্স গেট, কনফিডেন্স স্কোর (W_TREND .20 · W_MTF .15 · W_TRIGGER .20 · W_RSI .10 · W_SESSION .05 · W_ATR .05 · W_CONFLUENCE .25), সেটআপ-ট্রু জিওমেট্রি (SL = জোন ফার-এজ ∓ 0.35·ATR, লিকুইডিটি প্রোটেকশন, TP ল্যাডার 1.2–1.8R), সিগন্যাল হিস্ট্রি ট্র্যাকিং (won/lost/R) |
| **🗺️ মার্কেট রোডম্যাপ** | ডিরেকশন ভারডিক্ট (fresh liquidity event > draw-on-liquidity > bias), স্ট্রাকচার ল্যাডার (run/phase/p_reversal), ম্যাগনেট লেভেল, লিকুইডিটি টার্গেট, বুল/বিয়ার সিনারিও ল্যাডার |
| **📊 ইন্ডিকেটর প্যানেল** | RSI, ATR, ADX, Kaufman ER, MACD, Stochastic, Bollinger %B, EMA 9/21/50 স্ট্যাক, রেজিম (vol ratio + ER), ক্যান্ডেল-ব্যাটল (ভলিউম-ওয়েটেড buyer/seller), হোয়েল পালস |
| **🕐 কিল-জোন** | এশিয়া / লন্ডন / NY AM / NY PM সেশন ব্যান্ড |
| **📱 আলাদা মোবাইল ডিজাইন** | বটম-ট্যাব অ্যাপ (Chart/Signals/Roadmap/Market), বটম-শিট ড্রয়িং টুলস, কম্প্যাক্ট হেডার |
| **🖥️ আলাদা ডেস্কটপ ডিজাইন** | প্রো টার্মিনাল — টপ-বার, ওয়াচলিস্ট রেইল, ভার্টিকাল টুল-স্ট্রিপ, রাইট অ্যানালাইসিস ডক, স্ট্যাটাস বার |
| **🌍 EN / বাংলা** | সম্পূর্ণ UI দুই ভাষায় |
| **🌗 ডার্ক / লাইট** | থিম টগল |

## 🏗️ আর্কিটেকচার / Architecture

```
Exness-MT5Trial6 (MT5 server)
        │  wss://<gateway-ip>:443/terminal  (MT5 web-terminal binary protocol,
        │  AES-256-CBC framed — reverse-engineered, no terminal needed)
        ▼
mini-services/mt5-service        (Bun + TypeScript)
  :3030 socket.io → tick / bar / status events
  :3031 REST      → /api/candles /api/symbols /api/quote /api/status
        │
        ▼
Next.js 16 app (this repo)
  src/lib/market/*  → indicator + SMC + signal + roadmap engines (TS)
  /api/analysis     → multi-TF fetch → evaluate → save signals → drawings
  /api/drawings     → user drawing CRUD (SQLite/Prisma)
  /api/signals      → signal history + stats
        │
        ▼
Browser — lightweight-charts + canvas overlay, socket.io live ticks
```

- **মোবাইল/ডেস্কটপ উভয়ই** একই ডেটা-পাইপলাইন ব্যবহার করে, লেআউট সম্পূর্ণ আলাদা।
- MT5 unreachable হলে **SIM fallback** (স্পষ্টভাবে লেবেল করা) — সাইট কখনো মৃত থাকে না, ৬০ সেকেন্ড পরপর MT5 রি-কানেক্ট চেষ্টা করে।

## 🚀 লোকাল রান / Run locally

```bash
bun install
bun run db:push          # SQLite schema
bun run dev              # Next.js :3000

# আলাদা টার্মিনালে — MT5 ডেটা সার্ভিস:
cd mini-services/mt5-service && bun install && bun run dev
# socket.io :3030 + REST :3031
```

`.env` (defaults already work):

```env
DATABASE_URL=file:./db/custom.db
MT5_SERVER=Exness-MT5Trial6
MT5_LOGIN=<আপনার MT5 লগইন>
MT5_PASSWORD=<আপনার MT5 পাসওয়ার্ড>
MT5_SERVICE_URL=http://127.0.0.1:3031
```

> 🔐 **ক্রেডেনশিয়াল কখনো কোডে হার্ডকোড করা নেই** — শুধুমাত্র environment variable (`.env`) থেকে পড়া হয়। ভ্যারিয়েবল সেট না থাকলে অ্যাপ **SIM মোডে** বুট করে (সাইট মৃত থাকে না), সেট করলে লাইভ MT5 ডেটা চালু হয়ে যায়।

## 🚂 Railway Deploy (অটো-ডিপ্লয় + অটো ভ্যারিয়েবল)

রেপোতে `Dockerfile` + `railway.json` + `start-railway.sh` + `Caddyfile.railway` সব রেডি — Railway **সবকিছু অটোমেটিক** বিল্ড/রান করে।

### ধাপ (একবারই)

1. [Railway](https://railway.app) → **New Project → Deploy from GitHub repo** → `psfaruk/Xauusd-trad` → branch `main`
2. Railway নিজে থেকেই `Dockerfile` ধরে নেবে (`railway.json` নির্দেশ করে আছে) — বিল্ড শুরু হবে
3. (ঐচ্ছিক, প্রস্তাবিত) **Volume** যোগ করুন, mount path `/data` — ড্রয়িং/সিগন্যাল হিস্ট্রি/ট্রেডার-স্টেট redeploy-এর পরও থাকবে
4. **Variables**-এ আপনার MT5 অ্যাকাউন্ট যোগ করুন:

   | Variable | মান | আবশ্যক? |
   |---|---|---|
   | `MT5_LOGIN` | আপনার MT5 লগইন নম্বর | লাইভ ডেটার জন্য হ্যাঁ |
   | `MT5_PASSWORD` | আপনার MT5 পাসওয়ার্ড | লাইভ ডেটার জন্য হ্যাঁ |
   | `MT5_SERVER` | ডিফল্ট `Exness-MT5Trial6` | না (ডিফল্ট আছে) |
   | `MT5_SERVICE_URL` | ডিফল্ট `http://127.0.0.1:3031` | না (অটো-সেট) |
   | `DATABASE_URL` | — | না (boot স্ক্রিপ্ট অটো-সেট করে) |

5. Deploy শেষ হলে যাচাই করুন: `https://<আপনার-অ্যাপ>.up.railway.app/api/setup-status`
   → `"ok": true`, `"mode": "LIVE-ready"`, `"broker.source": "mt5"` দেখলেই লাইভ ডেটা চালু ✓

**ভ্যারিয়েবল ছাড়াও ডিপ্লয় হয়** — তখন অ্যাপ SIM মোডে চলে (সাইট কখনো মৃত থাকে না)। ভ্যারিয়েবল যোগ করলেই Railway নিজে থেকে রিডিপ্লয় করে আর লাইভ MT5 ডেটা চালু হয়ে যায়।

### অটো-ডিপ্লয়

GitHub রেপো কানেক্ট থাকায় **`main` ব্রাঞ্চে প্রতিটি push-এ Railway স্বয়ংক্রিয়ভাবে রিবিল্ড + রিডিপ্লয় করে** — কিছু করতে হয় না।

### কন্টেইনারে কী চলে

- **Next.js** (:3000) — UI + অ্যানালাইসিস ইঞ্জিন + SQLite (Prisma)
- **mt5-service** (:3030 socket.io + :3031 REST) — সরাসরি Exness MT5 গেটওয়েতে WSS (কোনো PC/টার্মিনাল লাগে না)
- **Caddy** (:$PORT) — পাবলিক গেটওয়ে, `?XTransformPort=3030/3031` দিয়ে রাউট করে
- একটাই পোর্ট এক্সপোজ করে (Railway $PORT) · **Health check:** `/`

**Health check:** `/` · **Port:** একটিই (Railway $PORT) — গেটওয়ে `?XTransformPort` দিয়ে রাউট করে।

> ⚠️ Exness gateway IP-গুলো সময়ে সময়ে বদলাতে পারে — `mini-services/mt5-service/src/manager.ts`-এর `GATEWAYS` লিস্ট আপডেট করুন (MetaQuotes broker-search API থেকে নতুন IP পাওয়া যায়, দেখুন `mt5-poc/PROTOCOL.md`)।

## 📁 গুরুত্বপূর্ণ ফাইল / Key files

```
mini-services/mt5-service/
  src/mt5-client.ts      MT5 web-terminal protocol client (AES framing, auth, candles, quotes)
  src/manager.ts         reconnect loop, tick→bar builder, candle cache, sim fallback
  index.ts               :3030 socket.io + :3031 REST
src/lib/market/
  indicators.ts          EMA/RSI/ATR/ADX/MACD/Stoch/BB/swings (exact formulas)
  smc.ts                 structure BOS/CHoCH, order blocks, FVG, liquidity, S&D, premium/discount
  engine.ts              bias → triggers → confluence → geometry → confidence
  drawings.ts            auto-drawing builder (chart ink layer)
  roadmap.ts             direction verdict, ladder, magnets, scenarios
src/components/terminal/
  TradingChart.tsx       candlestick chart + canvas overlay + drawing interactions
  TerminalShell.tsx      desktop terminal / mobile tab layouts
prisma/schema.prisma     Drawing / SignalRecord / WatchItem / AppSetting
Dockerfile + start-railway.sh + Caddyfile.railway + railway.json
```

## ⚠️ Disclaimer

শিক্ষামূলক ডেমো টুল। ফাইন্যান্সিয়াল অ্যাডভাইস নয় — ট্রেডিং ঝুঁকিপূর্ণ। ডেটা সোর্স একটি **ডেমো MT5 অ্যাকাউন্ট** (Exness-MT5Trial6)।
