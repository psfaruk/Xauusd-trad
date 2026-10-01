import { NextResponse } from "next/server";
import type { TraderJournalEntry, TraderState } from "@/lib/market/types";

/**
 * AI deep-think v2 — the narration layer of the trading brain, EVENT-DRIVEN.
 *
 * The deterministic engine (mt5-service/src/trader.ts) feels every tick and
 * acts in milliseconds; THIS layer reads its live state and "thinks out loud"
 * the way a human scalper narrates their session — and it ALWAYS FOLLOWS UP:
 * entries taken, entries skipped (why), TP hits, SL hits, open positions and
 * how far they sit from the fixed-dollar target / stop.
 *
 * v2 fixes (the user's complaint — "the AI doesn't SEE entries / SL / TP"):
 *   • context is now an explicit EVENT LIST (open/skip/close with exitKind)
 *   • system prompt demands follow-up on every event kind
 *   • `force` busts the time-cache right after a trade event (still limited
 *     to one real LLM call / 5s)
 *   • LLM failure NEVER yields HTTP 500 — a local Bengali narrator built from
 *     the live state answers instead, flagged `degraded: true`
 */

export const runtime = "nodejs";

// ── in-process cache + rate limits ──
// non-forced calls: 1 real LLM call / 10s; forced (event-driven) calls bust
// the time-cache but are still limited to 1 real call / 5s so a burst of
// journal events can never hammer the provider.
let lastCallAt = 0;
let cache: { at: number; body: Record<string, string> } | null = null;
const MIN_INTERVAL_MS = 10_000;
const FORCE_MIN_INTERVAL_MS = 5_000;

interface BrainInput {
  state?: TraderState;
  force?: boolean;
}

// ── event formatting — every journal entry becomes an EXPLICIT line the
//    model can SEE ("TP HIT ✅ +0.51", "SKIP (3-chart veto: …)") ──

function hhmmss(at: number) {
  return new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function pnlStr(j: TraderJournalEntry) {
  return j.pnl !== undefined
    ? ` ${j.pnl >= 0 ? `+${j.pnl.toFixed(2)}` : `−${Math.abs(j.pnl).toFixed(2)}`}`
    : "";
}

function eventLine(j: TraderJournalEntry): string {
  const t = hhmmss(j.at);
  switch (j.action) {
    case "open":
      return `${t} OPEN ${j.symbol} ${(j.side ?? "").toUpperCase()}${j.lots ? ` ${j.lots}` : ""} @${j.price ?? "?"} (${j.reason})`;
    case "close": {
      switch (j.exitKind) {
        case "TP": return `${t} TP HIT ✅${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "SL": return `${t} SL HIT ❌${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "FLIP": return `${t} FLIP EXIT${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "ADVERSE": return `${t} ADVERSE CUT${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "TIME": return `${t} TIME STOP${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "AI": return `${t} AI CLOSE${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "MANUAL": return `${t} MANUAL CLOSE${pnlStr(j)} ${j.symbol} (${j.reason})`;
        case "PARTIAL": return `${t} PARTIAL${pnlStr(j)} ${j.symbol} (${j.reason})`;
        default: return `${t} CLOSE${pnlStr(j)} ${j.symbol} (${j.reason})`; // legacy entry — no exitKind
      }
    }
    case "skip":
      return `${t} SKIP ${j.symbol} (${j.reason})`; // the veto reason explains WHY no entry
    case "manage":
      return `${t} MANAGE ${j.symbol} — ${j.reason}`;
    case "halt":
      return `${t} HALT — ${j.reason}`;
    case "error":
      return `${t} ERROR ${j.symbol} — ${j.reason}`;
    default:
      return `${t} INFO${j.symbol ? ` ${j.symbol}` : ""} — ${j.reason}`;
  }
}

// ── context builder — rich, event-first ──

function buildContext(s: TraderState) {
  const tpUsd = s.tpUsd ?? 0;
  const beUsd = s.beUsd ?? 0;
  // v9: the running-balance trend the user asked to follow — session baseline,
  // live delta, direction, and the recent balance trail
  const s0 = s.sessionStartBalance;
  const balDelta = s0 != null && s0 > 0 ? Math.round((s.balance - s0) * 100) / 100 : null;
  return {
    now: new Date().toISOString(),
    armed: s.enabled,
    riskMode: s.riskMode,
    balance: s.balance,
    equity: s.equity,
    floatingPnl: s.floatingPnl,
    balanceTrend: {
      sessionStart: s0 ?? undefined,
      deltaUsd: balDelta ?? undefined,
      direction: balDelta == null ? "unknown" : balDelta > 0 ? "up" : balDelta < 0 ? "down" : "flat",
      recentTrail: (s.balanceHist ?? []).slice(-8).map((h) => h.balance),
    },
    currency: s.currency,
    noFunds: s.noFunds,
    connected: s.connected,
    haltedToday: s.haltedToday,
    haltReason: s.haltReason || undefined,
    // fixed-dollar profit target: e.g. 0.5 ⇒ every trade banks profit at +$0.50
    tpTarget: tpUsd,
    tpTargetMeaning: tpUsd > 0
      ? `fixed-dollar TP — every trade banks profit at +$${tpUsd.toFixed(2)}`
      : "R-multiple TP mode (tpR × risk) — no fixed-dollar target",
    // v9: breakeven rule — profit ≥ trigger moves SL to entry(+lock)
    beTrigger: beUsd > 0 ? beUsd : tpUsd > 0 ? Math.round(tpUsd * 0.6 * 100) / 100 : null,
    beMeaning: beUsd > 0
      ? `breakeven at +$${beUsd.toFixed(2)} — SL jumps to entry (+$0.05 lock)`
      : "breakeven AUTO — fires at 60% of the $ target",
    today: s.today,
    positions: s.positions.map((p) => ({
      symbol: p.symbol, side: p.side, lots: p.lots, entry: p.entry, price: p.price,
      pnlUsd: Math.round(p.pnl * 100) / 100,
      pnlR: Math.round(p.pnlR * 100) / 100,
      peakR: Math.round(p.peakR * 100) / 100,
      heldSec: Math.round((Date.now() - p.openedAt) / 1000),
      sl: p.sl, tp: p.tp,
      ...(p.tpUsdAway !== undefined ? { tpUsdAway: Math.round(p.tpUsdAway * 100) / 100 } : {}),
      ...(p.slUsdAway !== undefined ? { slUsdAway: Math.round(p.slUsdAway * 100) / 100 } : {}),
      // v11: WHO opened it — "AI" (the brain) or "user" (manual, MT5/app)
      ...(p.origin ? { openedBy: p.origin === "brain" ? "AI" : "user" } : {}),
      reason: p.reason,
    })),
    // v11: pending limit/stop orders — one line each (else "no pending orders")
    pending: (s.pendingOrders ?? []).length
      ? (s.pendingOrders ?? []).map((o) =>
          `PENDING: ${o.symbol} ${o.orderTypeName} ${o.lots} @ ${o.price} (${o.orderType})`)
      : ["no pending orders"],
    // v11: recent closes from the broker's own deal history (last 8, newest
    // first) — WHO opened it + HOW it ended, e.g.
    // "HIST: EURUSDm SELL +$0.50 TP (brain)"
    recentHistory: (s.recentHistory ?? []).slice(0, 8).map((h) =>
      `HIST: ${h.symbol} ${h.side.toUpperCase()} ${h.pnl >= 0 ? "+" : "−"}$${Math.abs(h.pnl).toFixed(2)} ${h.exitKind} (${h.origin})`),
    feelings: s.feelings,
    events: s.journal.slice(-14).map(eventLine), // newest LAST
    thoughts: s.brain.slice(-6).map((b) => b.text),
  };
}

// ── system prompt — the follow-up contract ──

function systemPrompt(s: TraderState): string {
  const tpUsd = s.tpUsd ?? 0;
  const target = tpUsd > 0
    ? `a fixed-dollar profit target (bank profit at +$${tpUsd.toFixed(2)} on every trade)`
    : "R-multiple profit targets";
  return (
    `You are the narration layer of an automated MT5 scalping brain with ${target}. ` +
    "You receive live events: entries OPENED, entries SKIPPED (with the veto reason), TP hits, SL hits, and open positions. " +
    "THINK LIKE A SCALPER REVIEWING THEIR DESK. YOU MUST ALWAYS FOLLOW UP: " +
    "(1) if an entry just opened — acknowledge it, its side, and what you expect; " +
    "(2) if a TP or SL was just hit — say it explicitly with the dollar amount and what it means for today's total; " +
    "(3) if entries were skipped — explain the top veto reason in one short phrase (this tells the user WHY signals are/aren't coming); " +
    "(4) open positions — how far from the $target/SL, healthy or at risk, and whether breakeven protection has fired; " +
    "(5) the RUNNING BALANCE trend — is the account growing or bleeding (balance vs session start, e.g. \"balance 484.04 → 486.10 (+2.06)\") and the floating P/L; " +
    "(6) pending limit/stop orders and recent closed trades (HIST lines) — acknowledge them and always say WHO opened each trade (the AI brain vs the user's own manual order); " +
    "(7) state your plan. " +
    "Be concise: 'read' ≤ 90 words, 'bias'/'risk'/'plan' ≤ 22 words each. " +
    "Bengali (বাংলা) primarily, trading terms in English (BUY/SELL, SL, TP, R). " +
    "NEVER invent data. Respond ONLY valid JSON: " +
    '{"read":"…","bias":"…","risk":"…","plan":"…"}'
  );
}

// ── LOCAL FALLBACK — deterministic Bengali narration built straight from the
//    live state. No LLM, no network: it always mentions the latest event,
//    open positions with $-distance, today's W/L and one plan line. ──

/** latin → বাংলা digits (for the count in “পেন্ডিং অর্ডার ২টা”) */
function bnDigits(n: number) {
  return String(n).replace(/[0-9]/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]);
}

function localNarrate(s: TraderState): { read: string; bias: string; risk: string; plan: string } {
  const tpUsd = s.tpUsd ?? 0;
  const d = (n: number) => `$${Math.abs(n).toFixed(2)}`;
  const today = s.today;
  const todayPart = today && today.trades > 0
    ? ` আজ: ${today.wins}W/${today.losses}L · P/L ${today.pnl >= 0 ? "+" : "−"}${d(today.pnl)}।`
    : "";

  // newest newsworthy event (shallow backward scan)
  let ev: TraderJournalEntry | undefined;
  for (let i = s.journal.length - 1; i >= Math.max(0, s.journal.length - 10) && !ev; i--) {
    const j = s.journal[i];
    if (j.action === "open" || j.action === "close" || j.action === "skip" || j.action === "halt") ev = j;
  }

  let lead = "";
  if (ev) {
    const p = pnlStr(ev);
    switch (ev.action) {
      case "open":
        lead = `${ev.symbol} ${ev.side === "sell" ? "SELL" : "BUY"} এন্ট্রি নেওয়া হলো @${ev.price ?? "?"}${ev.lots ? ` (${ev.lots} lots)` : ""}${tpUsd > 0 ? ` — টার্গেট +${d(tpUsd)}` : ""}।`;
        break;
      case "close":
        if (ev.exitKind === "TP") lead = `${ev.symbol} TP HIT ✅${p} — টার্গেট পূরণ, প্রফিট ব্যাংক হলো।`;
        else if (ev.exitKind === "SL") lead = `${ev.symbol} SL HIT ❌${p} — স্টপে ক্লোজ, লস কাটা গেল।`;
        else if (ev.exitKind === "FLIP") lead = `${ev.symbol} ফ্লো ঘুরে যাওয়ায় ক্লোজ${p}।`;
        else if (ev.exitKind === "ADVERSE") lead = `${ev.symbol} বিপরীত ফ্লোতে কাট${p}।`;
        else if (ev.exitKind === "TIME") lead = `${ev.symbol} টাইম-স্টপে ক্লোজ${p}।`;
        else if (ev.exitKind === "AI") lead = `${ev.symbol} AI নিজেই ক্লোজ করল${p}।`;
        else if (ev.exitKind === "MANUAL") lead = `${ev.symbol} ম্যানুয়ালি ক্লোজ${p}।`;
        else lead = `${ev.symbol} ক্লোজ${p} — ${ev.reason}।`;
        break;
      case "skip":
        lead = `${ev.symbol} এন্ট্রি নেওয়া হয়নি (SKIP) — কারণ: ${ev.reason}।`;
        break;
      case "halt":
        lead = `আজকের ট্রেডিং থামানো হলো — ${ev.reason}।`;
        break;
    }
  }
  if (!lead) lead = s.enabled ? "ব্রেইন সক্রিয় — সেটআপের অপেক্ষায়।" : "ব্রেইন ডিসআর্মড — শুধু নজরদারি চলছে।";

  // open positions with $-distance to target / stop
  const posParts = s.positions.map((p) => {
    const bits: string[] = [];
    if (p.tpUsdAway !== undefined) bits.push(`টার্গেট আর +${d(p.tpUsdAway)}`);
    if (p.slUsdAway !== undefined) bits.push(`SL আর −${d(p.slUsdAway)}`);
    if (p.beMoved) bits.push("SL ব্রেকইভেনে 🛡️");
    const away = bits.length ? ` (${bits.join(" · ")})` : "";
    return `${p.symbol} ${p.side.toUpperCase()} ${p.pnl >= 0 ? "+" : "−"}${d(p.pnl)}${away}`;
  });
  const posPart = posParts.length ? ` ওপেন: ${posParts.join(" · ")}।` : " কোনো ওপেন পজিশন নেই।";

  // v11: pending orders + the latest closes from the broker's own history —
  // with WHO opened them (AI vs আপনি), the mystery-order answer in বাংলা
  const pend = s.pendingOrders ?? [];
  let pendPart = "";
  if (pend.length) {
    const pendTxt = pend.slice(0, 3)
      .map((o) => `${o.symbol} ${o.orderTypeName} @${o.price}`)
      .join(" · ");
    pendPart = ` পেন্ডিং অর্ডার ${bnDigits(pend.length)}টা: ${pendTxt}।`;
  }
  const hist = (s.recentHistory ?? []).slice(0, 2);
  const histPart = hist.length
    ? ` শেষ ট্রেড: ${hist.map((h) =>
        `${h.symbol} ${h.side.toUpperCase()} ${h.pnl >= 0 ? "+" : "−"}$${Math.abs(h.pnl).toFixed(2)} (${h.exitKind}, ${h.origin === "brain" ? "AI-এর" : "আপনার"})`).join(" · ")}.`
    : "";

  // v9: the running-balance trend — the user's “ব্যালেন্স কমছে বাড়ছে” question,
  // answered with numbers (session start → now, plus floating P/L)
  let balPart = "";
  const s0 = s.sessionStartBalance;
  if (s0 != null && s0 > 0) {
    const delta = s.balance - s0;
    const dirTxt = delta > 0 ? "বাড়ছে 📈" : delta < 0 ? "কমছে 📉" : "সমান";
    balPart = ` ব্যালেন্স ${s.balance.toFixed(2)} (${dirTxt}, সেশন শুরু ${s0.toFixed(2)} থেকে ${delta >= 0 ? "+" : "−"}${d(delta)})`;
    if (s.positions.length && s.floatingPnl !== undefined) {
      balPart += `, ফ্লোটিং ${s.floatingPnl >= 0 ? "+" : "−"}${d(s.floatingPnl)}।`;
    } else balPart += ".";
  }

  // bias from the strongest feeling gauge
  let bias = "বায়াস: টেপ নিরপেক্ষ — স্পষ্ট দিক এখনো নেই।";
  const feels = s.feelings ?? [];
  if (feels.length) {
    const f = [...feels].sort((a, b) => b.confidence - a.confidence)[0];
    if (f.bias === "buy") bias = `বায়াস: ${f.symbol} বাই-পক্ষে (কনফিডেন্স ${Math.round(f.confidence * 100)}%)।`;
    else if (f.bias === "sell") bias = `বায়াস: ${f.symbol} সেল-পক্ষে (কনফিডেন্স ${Math.round(f.confidence * 100)}%)।`;
  }

  const losing = s.positions.filter((p) => p.pnl < 0).length;
  let risk = "রিস্ক: ছোট লট, প্রতিটি ট্রেডে SL সেট — ঝুঁকি নিয়ন্ত্রিত।";
  if (losing > 0) risk = `রিস্ক: ${losing}টি ট্রেড লসে আছে — SL ধরে রাখছি, বড় ক্ষতি হবে না।`;
  else if (!s.enabled) risk = "রিস্ক: ডিসআর্মড — এখন কোনো নতুন ঝুঁকি নেই।";

  let plan = "প্ল্যান: কনফ্লুয়েন্স মিললেই এন্ট্রি — না মিললে ধৈর্য।";
  if (s.positions.length) {
    plan = tpUsd > 0
      ? `প্ল্যান: চলমান ট্রেড ধরে রাখা — +${d(tpUsd)} ছুঁলেই প্রফিট ব্যাংক, ফ্লো ঘুরলে কাট।`
      : "প্ল্যান: চলমান ট্রেড ম্যানেজ — প্রফিটে ট্রেইল, ফ্লো ঘুরলে কাট।";
  } else if (s.haltedToday) {
    plan = "প্ল্যান: আজ আর নতুন এন্ট্রি নেই — রিস্ক রক্ষা করা হয়েছে।";
  }

  return { read: `${lead}${posPart}${pendPart}${balPart}${todayPart}${histPart}`, bias, risk, plan };
}

// ── the route ──

export async function POST(req: Request) {
  let s: TraderState | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as BrainInput;
    s = body.state;
    const force = body.force === true;

    if (!s) {
      return NextResponse.json({ error: "state required" }, { status: 400 });
    }
    // v16.3 SHAPE NORMALIZATION — the route's header promises "never a 500",
    // but a shape-valid-yet-partial body.state ({} / missing collections)
    // crashed buildContext (s.positions.map) and then the catch's
    // localNarrate (s.journal.length) crashed AGAIN — HTTP 500 anyway. Fill
    // every collection the consumers deref; scalar fields keep ??-guards.
    s = {
      ...s,
      positions: Array.isArray(s.positions) ? s.positions : [],
      pendingOrders: Array.isArray(s.pendingOrders) ? s.pendingOrders : [],
      recentHistory: Array.isArray(s.recentHistory) ? s.recentHistory : [],
      journal: Array.isArray(s.journal) ? s.journal : [],
      brain: Array.isArray(s.brain) ? s.brain : [],
      feelings: Array.isArray(s.feelings) ? s.feelings : [],
      balanceHist: Array.isArray(s.balanceHist) ? s.balanceHist : [],
      rules: Array.isArray(s.rules) ? s.rules : [],
      today: s.today ?? { trades: 0, wins: 0, losses: 0, pnl: 0, winPct: 0 },
    };

    const now = Date.now();
    const minInterval = force ? FORCE_MIN_INTERVAL_MS : MIN_INTERVAL_MS;
    // forced (event-driven) calls bust the time-cache — but never more than
    // one REAL LLM call per 5s; within that window the cached read is served.
    if (cache && now - lastCallAt < minInterval) {
      return NextResponse.json(cache.body);
    }

    const ctx = buildContext(s);

    // ── real LLM attempt (server-side only) ──
    let parsed: Record<string, string> | null = null;
    try {
      const ZAI = (await import("z-ai-web-dev-sdk")).default;
      const zai = await ZAI.create();
      const completion = await zai.chat.completions.create({
        messages: [
          // v12.1: a system prompt must carry role "system" — "assistant"
          // made the model treat its own instructions as prior chat turns
          // (weaker instruction-following, occasional persona drift).
          { role: "system", content: systemPrompt(s) },
          {
            role: "user",
            content: `Live brain state (JSON):\n${JSON.stringify(ctx)}\n\nNarrate now — follow up on the latest event first.`,
          },
        ],
        thinking: { type: "disabled" },
      });
      const raw = completion.choices[0]?.message?.content ?? "";
      // extract JSON (the model may wrap it in ```json fences)
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
      }
      if (parsed && !parsed.read) parsed = null;
    } catch {
      parsed = null; // LLM threw / timed out / rate-limited — local fallback below
    }

    if (parsed) {
      lastCallAt = now;
      cache = { at: now, body: parsed };
      return NextResponse.json(parsed);
    }

    // ── LOCAL FALLBACK — never a 500, never a dead panel. Fresh from state,
    //    so it beats any stale cache after a trade event. ──
    return NextResponse.json({ ...localNarrate(s), degraded: true });
  } catch (e) {
    // absolute last resort (malformed request / unexpected bug) — still JSON
    if (s) return NextResponse.json({ ...localNarrate(s), degraded: true, note: (e as Error).message });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
