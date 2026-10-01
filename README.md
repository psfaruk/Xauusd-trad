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
- **কোনো SIM নেই (v13)** — MT5 সংযুক্ত না থাকলে অ্যাপ স্পষ্টভাবে "MT5 OFFLINE" দেখায় এবং Settings → MT5 Account থেকে সংযোগ করা যায়। কোনো নকল প্রাইস কখনো দেখানো হয় না।
- **সব সার্ভার সাপোর্টেড** — Exness-MT5Trial6 থেকে Exness-MT5Real21 পর্যন্ত: সার্ভারের নাম দিলেই অ্যাপ নিজেই MetaQuotes ডিরেক্টরি থেকে গেটওয়ে IP খুঁজে নেয়।

## 🚀 লোকাল রান / Run locally

```bash
bun install
bun run db:push          # SQLite schema
bun run dev              # Next.js :3000

# আলাদা টার্মিনালে — MT5 ডেটা সার্ভিস:
cd mini-services/mt5-service && bun install && bun run dev
# socket.io :3030 + REST :3031
```

`.env` (সবই ঐচ্ছিক):

```env
DATABASE_URL=file:./db/custom.db
MT5_SERVICE_URL=http://127.0.0.1:3031
# MT5 ক্রেডেনশিয়াল দুইভাবে দেওয়া যায় —
#   ১) env দিয়ে:            MT5_LOGIN / MT5_PASSWORD / MT5_SERVER
#   ২) অ্যাপের ভিতরে (v13):  Settings → MT5 Account ফর্মে লগইন দিন —
#      ক্রেডেনশিয়াল AES-256-GCM এনক্রিপ্টেড ডিস্কে সেভ হয়, রিস্টার্টে অটো-রিকানেক্ট
```

> 🔐 **ক্রেডেনশিয়াল কখনো কোডে হার্ডকোড করা নেই।** অ্যাপ-ফর্ম দিয়ে দিলে সেটা শুধু আপনার সার্ভারে এনক্রিপ্টেড থাকে (`data/mt5-credentials.json`, mode 600) — কোনো রেসপন্স/লগ/রেপোতে কখনো ফেরত যায় না।

## 🚂 Railway Deploy (শূন্য ভ্যারিয়েবল + অটো-ডিপ্লয়)

রেপোতে `Dockerfile` + `railway.json` + `start-railway.sh` + `Caddyfile.railway` সব রেডি — Railway **সবকিছু অটোমেটিক** বিল্ড/রান করে। **কোনো ভ্যারিয়েবল সেট করতেই হয় না** — MT5 অ্যাকাউন্ট ডিপ্লয়ের পর অ্যাপের ভিতরে থেকে সংযোগ করা যায়।

### ধাপ (একবারই)

1. [Railway](https://railway.app) → **New Project → Deploy from GitHub repo** → `psfaruk/Xauusd-trad` → branch `main`
2. Railway নিজে থেকেই `Dockerfile` ধরে নেবে (`railway.json` নির্দেশ করে আছে) — বিল্ড শুরু হবে
3. **🌐 পাবলিক URL চালু করুন (গুরুত্বপূর্ণ ধাপ):** সার্ভিস পেজ → **Settings → Networking → Public Networking → Generate Domain**
   - Railway **নিজে থেকেই পোর্ট ডিটেক্ট করে বসিয়ে দেবে** — কন্টেইনারে একটাই পাবলিক লিসেনার আছে (Caddy গেটওয়ে, Railway-এর ইনজেক্ট করা `$PORT`, যেমন `6193`)। **ডিটেক্ট করা পোর্টটাই থাকুন — কিছু টাইপ করতে হবে না।**
   - ⚠️ **`80` লিখবেন না** — সেটা পুরনো ভুল নির্দেশ ছিল; Railway সবসময় নিজের `$PORT` ইনজেক্ট করে (ধারণা `80` কেউ শোনে না) — `80` দিলে ডোমেইন ৫০২ দেবে আর "পোর্ট খুঁজে পাবেন না"।
   - এটাই `https://<আপনার-অ্যাপ>.up.railway.app` তৈরি করে — **এই ধাপ ছাড়া অ্যাপের কোনো URL পাবেন না।**
   - যদি কখনো ৫০২ আসে: Domain-এ ক্লিক করে টার্গেট পোর্ট আবার অটো-ডিটেক্টেড নম্বরে বসিয়ে দিন (Deployments → View Logs-এর ব্যানারে `public gateway (Caddy) = :XXXX` লাইনে আসল নম্বর দেখা যায়)।
4. (ঐচ্ছিক, প্রস্তাবিত) **Volume** যোগ করুন, mount path `/data` — ড্রয়িং/সিগন্যাল হিস্ট্রি/ট্রেডার-স্টেট/**MT5 ক্রেডেনশিয়াল** redeploy-এর পরও থাকবে
5. Deploy শেষ হলে URL খুলুন → **প্রথম বুটের লগ** (Deployments → সেই ডিপ্লয় → View Logs) থেকে `AURUM LOGIN PASSWORD` লাইনটি কপি করুন — এটাই অ্যাপের লগইন পাসওয়ার্ড (নিজে ভ্যারিয়েবল না দিলে অটো-জেনারেট হয়; `APP_PASSWORD` ভ্যারিয়েবল দিলে আপনার পছন্দেরটাই চলবে)
6. লগইন করুন → **Settings → MT5 Account** → Exness লগইন / পাসওয়ার্ড / সার্ভার (যেমন `Exness-MT5Trial6`) দিন → **Connect** → লাইভ ডেটা চালু ✓
7. যাচাই: `https://<আপনার-অ্যাপ>.up.railway.app/api/setup-status` → `"ok": true` হলেই সব ঠিক

### ভ্যারিয়েবল — Raw Editor (কপি-পেস্ট ব্লক)

Service → **Variables** ট্যাব → **Raw Editor** খুলে নিচের ব্লকটি পেস্ট করুন (শুধু `APP_PASSWORD`-ই লাগবে; বাকিসব অটো):

```bash
APP_PASSWORD=<একটা_শক্ত_পাসওয়ার্ড_এখানে_বসান>
```

- পাসওয়ার্ড ভাঙতে সহজ হবে না এমন দিন (12+ অক্ষর)। Raw Editor-এ এক লাইনে একটি `KEY=value` — `#` কমেন্ট লাইন দেওয়া যায় না।
- **`PORT` কখনো নিজে সেট করবেন না** — Railway নিজেই ইনজেক্ট করে; নিজে সেট করলে ডোমেইন রাউটিং ভেঙে যায়।
- `DATABASE_URL`-ও দরকার নেই — boot স্ক্রিপ্ট Volume (`/data`) থাকলে `file:/data/aurum.db`, না থাকলে ইন-ইমেজ db ব্যবহার করে।
- ঐচ্ছিক টেবিল:

| Variable | মান | আবশ্যক? |
|---|---|---|
| `APP_PASSWORD` | অ্যাপ-লগইন পাসওয়ার্ড | না — না দিলে অটো-জেনারেট হয়ে প্রথম বুট-লগে একবার দেখায় (Volume থাকলে সেটাই স্থায়ী হয়) |
| `MT5_LOGIN` / `MT5_PASSWORD` | MT5 ক্রেডেনশিয়াল | না — অ্যাপের Settings → MT5 Account ফর্মে দিলেই হয় |
| `MT5_SERVER` | ডিফল্ট `Exness-MT5Trial6` | না |
| `DATABASE_URL` | — | না (boot স্ক্রিপ্ট অটো-সেট করে) |

### অটো-ডিপ্লয়

GitHub রেপো কানেক্ট থাকায় **`main` ব্রাঞ্চে প্রতিটি push-এ Railway স্বয়ংক্রিয়ভাবে রিবিল্ড + রিডিপ্লয় করে** — কিছু করতে হয় না।

### কন্টেইনারে কী চলে (v14 — একটাই পাবলিক দরজা, একটাই উদ্দেশ্য)

- **Caddy** (`:$PORT` — একমাত্র পাবলিক লিসেনার) — `?XTransformPort=3030` দিয়ে শুধু socket.io রাউট করে
- **Next.js** (127.0.0.1:3000 — লুপব্যাক) — UI + অ্যানালাইসিস ইঞ্জিন + SQLite (Prisma)
- **mt5-service** (127.0.0.1:3030 socket.io + 127.0.0.1:3031 REST — লুপব্যাক) — সরাসরি Exness MT5 গেটওয়েতে WSS (কোনো PC/টার্মিনাল লাগে না)

v14 নিরাপত্তা: **:3031 REST এখন ইন্টারনেট থেকে পাওয়া যায় না** — অ্যাপের ব্রাউজার এটি ছোঁয় শুধু Next.js সেম-অরিজিন প্রক্সি `/api/mt5/*` দিয়ে (সার্ভার-সাইডে x-trader-key সহ)। সার্ভিসের নিজের গার্ডও সব মার্কেট এন্ডপয়েন্টে সেশন/কী চায় (ডিফেন্স-ইন-ডেপথ); খোলা শুধু `/health` (লোকাল)।

ফলে Railway-এর পোর্ট ডিটেকশন সবসময় **ঠিক একটাই পোর্ট** দেখে (Caddy) — Generate Domain কখনো ভুল পোর্টে যাবে না। **Health check:** `/`

> ℹ️ Exness সার্ভারের গেটওয়ে IP অ্যাপ **নিজেই অটো-ডিসকভার** করে (MetaQuotes broker-search API — ঠিক যেভাবে একটি MT5 টার্মিনাল করে)। Trial6-এর জন্য ভেরিফাইড IP লিস্ট বিল্ট-ইন আছে।

## 📁 গুরুত্বপূর্ণ ফাইল / Key files

```
mini-services/mt5-service/
  src/mt5-client.ts      MT5 web-terminal protocol client (AES framing, auth, candles, quotes)
  src/manager.ts         reconnect loop, tick→bar builder, candle cache, server discovery
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

শিক্ষামূলক ডেমো টুল। ফাইন্যান্সিয়াল অ্যাডভাইস নয় — ট্রেডিং ঝুঁকিপূর্ণ। ডিফল্ট সার্ভার একটি **ডেমো MT5 অ্যাকাউন্ট** (Exness-MT5Trial6); রিয়েল অ্যাকাউন্ট সংযোগ করলে সম্পূর্ণ ঝুঁকি আপনার।
