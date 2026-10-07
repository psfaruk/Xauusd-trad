/**
 * board.ts — THE 6-AGENT AI BOARD (v21.0)
 *
 * User blueprint (বাংলা spec): a Multi-Agent AI roundtable that reads the
 * LIVE market on every candle close and issues ONE final decision with
 * chart drawing coordinates:
 *
 *   Agent 1  Trend & Indicators Analyst   — MTF trend, EMA/RSI/MACD/ADX
 *   Agent 2  SMC & Price Action Specialist— OB / FVG / liquidity / structure
 *   Agent 3  Risk & Money Manager         — lot size, SL/TP, RR ≥ 1:2
 *   Agent 4  Risk Auditor (The Skeptic)   — counter-arguments, fakeout traps
 *   Agent 5  Volatility & News Filter     — ATR regime, spread, session
 *   Agent 6  Chief Trading Officer        — consensus + final BUY/SELL/HOLD
 *
 * Design contract:
 *   · The LLM DECIDES, the code DRAWS — the CTO returns numbers only; the
 *     deterministic geometry builder (validated zones/swings) produces the
 *     chart coordinates. No raw model output ever reaches the canvas.
 *   · Agents 1–5 run in PARALLEL (one LLM call each, strict JSON, 30s cap);
 *     a failed agent falls back to a deterministic local read — the board
 *     never stalls, the answer is flagged degraded.
 *   · The CTO's numbers pass a geometry sanitizer (finite, direction-
 *     consistent, RR ≥ 1.5, within ATR reach of price) or the decision
 *     drops to the local fallback — an invalid plan is never drawn.
 */

import type { Candle } from "./types";
import type {
  BoardAgentOut, BoardContextSummary, BoardDecision, BoardDrawings,
} from "./types";
import { atr, ema, rsi, macd, adx, swings, sessionOf } from "./indicators";
import {
  detectStructure, detectOrderBlocks, detectFvg, detectSupplyDemand,
  premiumDiscount, type Zone, type StructureRead,
} from "./smc";
import { detectPatterns } from "./patterns";
import { modelById } from "@/lib/ai/registry";
import { chatComplete } from "@/lib/ai/llm";

// ── helpers ────────────────────────────────────────────────────────────────

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

function lastNum(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return null;
}

function trendWord(r: StructureRead | null): string {
  if (!r) return "unknown";
  return r.trend === "bullish" ? "up" : r.trend === "bearish" ? "down" : "range";
}

/** the compact, LLM-friendly market snapshot — every number walk-forward
 *  safe (closed bars only), every field cheap to verify. */
export interface BoardContext {
  json: Record<string, unknown>; // what the agents read
  summary: BoardContextSummary; // what the panel shows
  // internals for geometry + fallbacks
  atr: number;
  price: number;
  digits: number;
  spread: number;
  zones: Zone[];
  swingList: { t: number; price: number; tag: "HH" | "HL" | "LH" | "LL" }[];
  structure: StructureRead | null;
  tfSec: number;
}

export function buildBoardContext(
  symbol: string,
  tf: string,
  barsByTf: Record<string, Candle[]>,
  spread: number,
  digits: number,
  extras: {
    balance: number | null;
    engineSignal: { direction: string; trigger: string; entry: number; sl: number; tp: number } | null;
    recentBoard: string[]; // last outcomes, e.g. "won +0.8%"
    /** v22 — live web headlines from the Control Tower's news radar */
    newsHeadlines?: string[];
  },
): BoardContext {
  const bars = (barsByTf[tf] ?? []).filter((b) => !b.f);
  const win = bars.slice(-260);
  const lastBar = bars[bars.length - 1] ?? null;
  const price = lastBar?.c ?? 0;
  const tfSec = TF_SEC[tf] ?? 900;

  const atrArr = atr(win, 14);
  const atrNow = (lastNum(atrArr) ?? Math.max(1e-9, price * 0.001)) || 1e-9;
  const closes = win.map((b) => b.c);
  const rsiNow = lastNum(rsi(win, 14));
  const e20 = lastNum(ema(closes, 20));
  const e50 = lastNum(ema(closes, 50));
  const macdNow = macd(win);
  const macdHist = lastNum(macdNow.hist);
  const adxNow = adx(win, 14);

  // structure + swings (major 3/3 like the engine's read)
  const structure = win.length >= 40 ? detectStructure(win.slice(-160), 3, 3) : null;
  const sw = swings(win.slice(-160), 3, 3);
  // tag swings HH/HL/LH/LL by comparing to the previous same-kind swing
  const swingList: { t: number; price: number; tag: "HH" | "HL" | "LH" | "LL" }[] = [];
  {
    let lastHigh: number | null = null;
    let lastLow: number | null = null;
    for (const s of sw) {
      if (s.kind === "high") {
        const tag = lastHigh == null ? "HH" : s.price > lastHigh ? "HH" : "LH";
        swingList.push({ t: s.t, price: s.price, tag });
        lastHigh = s.price;
      } else {
        const tag = lastLow == null ? "LL" : s.price > lastLow ? "HL" : "LL";
        swingList.push({ t: s.t, price: s.price, tag });
        lastLow = s.price;
      }
    }
  }

  // fresh zones near price (the ones a trade would actually lean on)
  const allZones: Zone[] = [
    ...detectSupplyDemand(win.slice(-200)),
    ...detectOrderBlocks(win.slice(-200)),
    ...detectFvg(win.slice(-120)),
  ];
  const freshZones = allZones
    .filter((z) => z.mitT == null && !z.filled && z.brokenT == null)
    .filter((z) => Math.abs((z.hi + z.lo) / 2 - price) <= 3.2 * atrNow)
    .sort((a, b) => Math.abs((a.hi + a.lo) / 2 - price) - Math.abs((b.hi + b.lo) / 2 - price))
    .slice(0, 6);

  // nearest key levels from unbroken swings (2 per side)
  const nowT = lastBar?.t ?? 0;
  const barsAgo = (t: number) => Math.max(0, Math.round((nowT - t) / tfSec));
  const unbrokenHighs = sw
    .filter((s) => s.kind === "high" && s.price > price)
    .sort((a, b) => a.price - b.price).slice(0, 2);
  const unbrokenLows = sw
    .filter((s) => s.kind === "low" && s.price < price)
    .sort((a, b) => b.price - a.price).slice(0, 2);

  const pd = win.length >= 30 ? premiumDiscount(win, 60, price) : null;

  // MTF trend words
  const h1 = (barsByTf.H1 ?? []).filter((b) => !b.f).slice(-200);
  const h4 = (barsByTf.H4 ?? []).filter((b) => !b.f).slice(-200);
  const h1Read = h1.length >= 40 ? detectStructure(h1, 3, 3) : null;
  const h4Read = h4.length >= 40 ? detectStructure(h4, 3, 3) : null;

  // recent closed bars — compact [o,h,l,c] rounded (last 24)
  const recentBars = bars.slice(-24).map((b) =>
    [b.o, b.h, b.l, b.c].map((v) => Number(v.toFixed(Math.min(3, digits + 1)))),
  );

  // v22 — classic chart patterns (double top/bottom, H&S, flags, triangles…)
  // on the active window: the deterministic pattern engine's best 2 reads.
  const pats = win.length >= 60 ? detectPatterns(win.slice(-160)) : [];
  const scored = [...pats].sort((a, b) => {
    const confirmed = (p: typeof a) => (p.state === "confirmed" ? 1 : 0);
    return confirmed(b) - confirmed(a);
  }).slice(0, 2);
  const chartPatterns = scored.map((p) => ({
    name: p.name, state: p.state, dir: p.dir,
    entry: Number(p.entry.price.toFixed(digits)),
    sl: Number(p.sl.toFixed(digits)),
    target: Number(p.target.toFixed(digits)),
    rr: p.rr == null ? null : Number(p.rr.toFixed(2)),
  }));

  const lastEvent = structure?.events?.[structure.events.length - 1] ?? null;
  const session = lastBar ? sessionOf(lastBar.t + tfSec / 2) : "off";

  const zoneName: Record<Zone["side"], string> = {
    ob_bull: "OB bull", ob_bear: "OB bear",
    supply: "supply", demand: "demand",
    fvg_bull: "FVG bull", fvg_bear: "FVG bear",
  };

  const json = {
    symbol,
    timeframe: tf,
    price: Number(price.toFixed(digits)),
    digits,
    spread: Number(spread.toFixed(digits + 1)),
    atr14: Number(atrNow.toFixed(digits)),
    session,
    indicators: {
      rsi14: rsiNow == null ? null : Number(rsiNow.toFixed(1)),
      macdHist: macdHist == null ? null : Number(macdHist.toFixed(digits)),
      ema20: e20 == null ? null : Number(e20.toFixed(digits)),
      ema50: e50 == null ? null : Number(e50.toFixed(digits)),
      adx14: adxNow == null ? null : Number(adxNow.toFixed(1)),
    },
    trend: {
      active: trendWord(structure),
      h1: trendWord(h1Read),
      h4: trendWord(h4Read),
      lastStructureEvent: lastEvent
        ? `${lastEvent.label} ${lastEvent.dir} @${lastEvent.price.toFixed(digits)} (${barsAgo(lastEvent.t)} bars ago)`
        : "none",
    },
    swings: swingList.slice(-8).map((s) => ({
      tag: s.tag, price: Number(s.price.toFixed(digits)), barsAgo: barsAgo(s.t),
    })),
    zonesNearPrice: freshZones.map((z) => ({
      kind: zoneName[z.side],
      lo: Number(z.lo.toFixed(digits)),
      hi: Number(z.hi.toFixed(digits)),
      ageBars: barsAgo(z.t),
      side: z.hi < price ? "below" : z.lo > price ? "above" : "around price",
    })),
    levels: {
      resistances: unbrokenHighs.map((s) => Number(s.price.toFixed(digits))),
      supports: unbrokenLows.map((s) => Number(s.price.toFixed(digits))),
    },
    premiumDiscount: pd
      ? { state: pd.state, equilibrium: Number(pd.eq.toFixed(digits)) }
      : null,
    recentBarsOHLC: recentBars,
    chartPatterns: chartPatterns.length ? chartPatterns : "none active",
    newsHeadlines: extras.newsHeadlines?.length ? extras.newsHeadlines.slice(0, 6) : "no live headlines",
    engineSignal: extras.engineSignal,
    recentBoardResults: extras.recentBoard,
    account: extras.balance != null ? { balance: Number(extras.balance.toFixed(2)) } : null,
  };

  const summary: BoardContextSummary = {
    price: Number(price.toFixed(digits)),
    atr: Number(atrNow.toFixed(digits)),
    rsi: rsiNow == null ? null : Number(rsiNow.toFixed(1)),
    emaFast: e20 == null ? null : Number(e20.toFixed(digits)),
    emaSlow: e50 == null ? null : Number(e50.toFixed(digits)),
    macdHist: macdHist == null ? null : Number(macdHist.toFixed(digits)),
    adx: adxNow == null ? null : Number(adxNow.toFixed(1)),
    trend: trendWord(structure),
    h1Trend: trendWord(h1Read),
    h4Trend: trendWord(h4Read),
    spread: Number(spread.toFixed(digits + 1)),
    session,
    structureEvent: lastEvent ? `${lastEvent.label} ${lastEvent.dir}` : null,
    lastZone: freshZones[0]
      ? `${zoneName[freshZones[0].side]} ${freshZones[0].lo.toFixed(digits)}–${freshZones[0].hi.toFixed(digits)} (${freshZones[0].hi < price ? "below" : "above"})`
      : null,
  };

  return {
    json, summary,
    atr: atrNow, price, digits, spread,
    zones: freshZones, swingList, structure,
    tfSec,
  };
}

// ── the agents ──────────────────────────────────────────────────────────────

interface AgentPersona {
  id: BoardAgentOut["id"];
  roleEn: string;
  roleBn: string;
  model: string;
  /** badge suffix, e.g. "MTF" — the runtime model label prefixes it */
  suffix: string;
  system: string;
}

const JSON_RULE =
  'Respond ONLY with valid JSON, no markdown fences: {"vote":"BUY"|"SELL"|"HOLD","confidence":<0-100 integer>,"note":"<Bengali, ≤ 18 words, trading terms in English>"}';

/** v22 — badge for the model actually answering this agent's call. */
function agentBadge(persona: AgentPersona, modelId: string | undefined): string {
  const m = modelId ? modelById(modelId) : null;
  return `${m ? m.label : "GLM-4.6"} · ${persona.suffix}`;
}

export const AGENT_PERSONAS: AgentPersona[] = [
  {
    id: "trend",
    roleEn: "Trend & Indicators Analyst",
    roleBn: "ট্রেন্ড ও ইন্ডিকেটর বিশ্লেষক",
    model: "GLM-4.6 · MTF",
    suffix: "MTF",
    system:
      "You are AGENT 1 — Trend & Indicators Analyst on a 6-member AI trading board (XAUUSD, MetaTrader 5). " +
      "Your ONLY job: read the MULTI-TIMEFRAME trend and momentum — EMA20 vs EMA50, RSI14, MACD histogram, ADX strength, and the active/H1/H4 structure trend. " +
      "Vote from INDICATORS ALONE (ignore order blocks and zones — Agent 2 owns those). " +
      "No clear directional edge (mixed tfs, ADX < 20, RSI mid-range) → HOLD. " +
      JSON_RULE,
  },
  {
    id: "smc",
    roleEn: "SMC & Price Action Specialist",
    roleBn: "SMC ও প্রাইস অ্যাকশন বিশেষজ্ঞ",
    model: "GLM-4.6 · SMC",
    suffix: "SMC",
    system:
      "You are AGENT 2 — Smart Money Concepts & Price Action Specialist on a 6-member AI trading board (XAUUSD). " +
      "Your ONLY job: read the institutional map — Order Blocks, Fair Value Gaps, fresh supply/demand zones, premium vs discount, liquidity (swing pools), and the last BOS/CHoCH. " +
      "Vote from SMC ALONE (ignore RSI/MACD — Agent 1 owns those). Price in a fresh demand/OB bull zone in discount after a bullish CHoCH → BUY; in supply/OB bear in premium → SELL; mid-range with no fresh zone → HOLD. " +
      JSON_RULE,
  },
  {
    id: "risk",
    roleEn: "Risk & Money Manager",
    roleBn: "রিস্ক ও মানি ম্যানেজার",
    model: "GLM-4.6 · Math",
    suffix: "Math",
    system:
      "You are AGENT 3 — Risk & Money Manager on a 6-member AI trading board (XAUUSD). " +
      "Your ONLY job: decide whether a TRADEABLE GEOMETRY exists right now. Using the zones, levels, ATR and spread in the context: a valid long = entry at/near a demand zone or support, SL below the zone low (not inside it), TP at the next resistance with reward ≥ 2× risk; a valid short is the mirror. " +
      "If the nearest zone is too far, spread eats the stop, or no ≥ 1:2 setup fits → vote HOLD. Your vote means 'the risk math works for THIS direction'. " +
      JSON_RULE,
  },
  {
    id: "skeptic",
    roleEn: "Risk Auditor (The Skeptic)",
    roleBn: "রিস্ক অডিটর (সংশয়বাদী)",
    model: "GLM-4.6 · Devil's Advocate",
    suffix: "Devil's Advocate",
    system:
      "You are AGENT 4 — Risk Auditor, THE SKEPTIC on a 6-member AI trading board (XAUUSD). " +
      "Your job: argue AGAINST the trade the other agents will want. Look for: liquidity traps and fakeouts (a sweep right before the current price), ranging markets disguised as trends, zones already half-mitigated, sessions where stops get hunted, and overextended moves far from EMA20 likely to mean-revert. " +
      "Vote the direction you would DEFEND after your own scrutiny, or HOLD if the obvious trade looks like a trap. Your note must name the concrete danger you see. " +
      JSON_RULE,
  },
  {
    id: "volatility",
    roleEn: "Volatility & News Filter",
    roleBn: "ভোলাটিলিটি ও নিউজ ফিল্টার",
    model: "GLM-4.6 · Regime",
    suffix: "Regime",
    system:
      "You are AGENT 5 — Volatility & News Filter on a 6-member AI trading board (XAUUSD). " +
      "Your ONLY job: is NOW safe to trade? Check: ATR vs recent bars (volatility explosion?), spread vs the ATR (cost regime), the session (London/NY killzones are tradeable; dead Tokyo/off hours are not), and the LIVE news headlines provided in the context (newsHeadlines — real web results; look for CPI, NFP, FOMC, Fed, rates, geopolitical flashes). " +
      "Dangerous regime (news window, extreme volatility, wide spread, dead session) → HOLD regardless of direction. Safe regime → vote with the session's typical behavior. " +
      JSON_RULE,
  },
];

const CTO_PERSONA: AgentPersona = {
  id: "cto",
  roleEn: "Chief Trading Officer",
  roleBn: "চিফ ট্রেডিং অফিসার",
  model: "GLM-4.6 · Consensus",
  suffix: "Consensus",
  system:
    "You are AGENT 6 — the CHIEF TRADING OFFICER, final authority of a 6-member AI trading board (XAUUSD, MetaTrader 5). " +
    "Five agents voted with reasons. Weigh them: trend+SMC alignment matters most; the Skeptic's warning can veto a marginal setup; the Volatility filter can veto ANY entry; the Risk manager's geometry is mandatory. " +
    "Issue the FINAL decision. Rules (non-negotiable): " +
    "(1) Risk:Reward must be ≥ 1:2. " +
    "(2) SL goes BEYOND the invalidation (below the zone low / swing low for BUY, above the zone high / swing high for SELL) — never inside a zone. " +
    "(3) Entry within 1.5×ATR of the current price (a market or near-limit entry), TP at the next real level. " +
    "(4) No strong majority or a veto → HOLD (cash is a position). " +
    "consensus = 0-100 how united the board is behind your decision. " +
    "Respond ONLY with valid JSON, no markdown fences: " +
    '{"action":"BUY"|"SELL"|"HOLD","entry":<price number>,"sl":<price number>,"tp":<price number>,"tp2":<price number or null>,"consensus":<0-100 integer>,"reasoning":"<Bengali, ≤ 30 words, trading terms in English>"}',
};

// ── LLM plumbing ────────────────────────────────────────────────────────────

interface LlmResult {
  ok: boolean;
  raw: string;
}

async function llmJson(
  system: string,
  user: string,
  timeoutMs: number,
  modelId?: string,
): Promise<LlmResult & { usedModelId: string }> {
  // v23 — KEYLESS multi-model board: every company's model runs without any
  // API key (built-in engine + persona), so the assigned model is always
  // honored. Board calls are kind:"board" — when the engine is rate-limited
  // they fail fast and the agent degrades to its local read, never stalling
  // the meeting.
  const useId = modelId ?? "glm-4.6";
  const res = await chatComplete({
    modelId: useId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    timeoutMs,
    temperature: 0.3,
    maxTokens: 700,
    kind: "board",
  });
  return { ok: res.ok, raw: res.ok ? res.content : "", usedModelId: useId };
}

/** parse one agent vote object — used by the committee's regex-salvage path
 *  when the model answers with loose objects instead of a JSON array.
 *  v26 — also surfaces a valid agent `id` when the model included one, so the
 *  salvage tier can attribute votes by their own id instead of array order. */
function parseAgentJson(raw: string): { id: string | null; vote: "BUY" | "SELL" | "HOLD"; confidence: number; note: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const vote = j.vote === "BUY" || j.vote === "SELL" || j.vote === "HOLD" ? j.vote : null;
    if (!vote) return null;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0)));
    const note = typeof j.note === "string" ? j.note.trim().slice(0, 220) : "";
    const id = typeof j.id === "string" && j.id ? j.id : null;
    return { id, vote, confidence, note };
  } catch {
    return null;
  }
}

// ── deterministic local fallbacks (never a dead board) ─────────────────────

function localAgent(
  persona: AgentPersona,
  ctx: BoardContext,
  vote: "BUY" | "SELL" | "HOLD",
  note: string,
): BoardAgentOut {
  return {
    id: persona.id, roleEn: persona.roleEn, roleBn: persona.roleBn, model: persona.model,
    vote, confidence: 40, note, degraded: true,
  };
}

/** indicator-only read for Agent 1 fallback */
function localTrend(ctx: BoardContext): "BUY" | "SELL" | "HOLD" {
  const s = ctx.summary;
  if (s.emaFast == null || s.emaSlow == null) return "HOLD";
  const up = s.emaFast > s.emaSlow && (s.rsi ?? 50) > 52 && s.trend === "up";
  const dn = s.emaFast < s.emaSlow && (s.rsi ?? 50) < 48 && s.trend === "down";
  return up ? "BUY" : dn ? "SELL" : "HOLD";
}

/** SMC-only read for Agent 2 fallback: price inside/near a fresh zone */
function localSmc(ctx: BoardContext): "BUY" | "SELL" | "HOLD" {
  const z = ctx.zones[0];
  if (!z) return "HOLD";
  const mid = (z.hi + z.lo) / 2;
  const bull = z.side === "ob_bull" || z.side === "demand" || z.side === "fvg_bull";
  const bear = z.side === "ob_bear" || z.side === "supply" || z.side === "fvg_bear";
  const near = Math.abs(mid - ctx.price) <= 1.2 * ctx.atr;
  if (!near) return "HOLD";
  if (bull && z.hi >= ctx.price - 0.2 * ctx.atr) return "BUY";
  if (bear && z.lo <= ctx.price + 0.2 * ctx.atr) return "SELL";
  return "HOLD";
}

function localAgents(ctx: BoardContext): BoardAgentOut[] {
  const s = ctx.summary;
  const t = localTrend(ctx);
  const smc = localSmc(ctx);
  const highVol = s.atr > 0 && s.price > 0 && (s.atr / s.price) * 100 > 0.35; // XAU ATR > 0.35% = hot
  const wideSpread = ctx.spread > 0 && ctx.atr > 0 && ctx.spread > ctx.atr * 0.12;
  return [
    localAgent(AGENT_PERSONAS[0], ctx, t,
      t === "HOLD" ? "ইন্ডিকেটর দিশাহীন — EMA/RSI মিশ্র সিগন্যাল।" :
      t === "BUY" ? "EMA20>50, RSI বুলিশ জোনে — আপট্রেন্ড মোমেন্টাম।" :
      "EMA20<50, RSI বেয়ারিশ — ডাউনট্রেন্ড মোমেন্টাম।"),
    localAgent(AGENT_PERSONAS[1], ctx, smc,
      smc === "HOLD" ? "প্রাইস ফ্রেশ জোনের কাছে নেই — SMC সেটআপ নেই।" :
      smc === "BUY" ? "প্রাইস ফ্রেশ ডিমান্ড/OB জোনে — বাই রিঅ্যাকশন সেটআপ।" :
      "প্রাইস ফ্রেশ সাপ্লাই/OB জোনে — সেল রিঅ্যাকশন সেটআপ।"),
    localAgent(AGENT_PERSONAS[2], ctx,
      smc === "HOLD" ? "HOLD" : smc,
      "জোন-ভিত্তিক জ্যামিতি হিসাব করা হয়েছে — RR শর্ত পূরণ হলে এন্ট্রি।"),
    localAgent(AGENT_PERSONAS[3], ctx,
      // v26 — was a dead ternary that always returned HOLD. Deliberate rule
      // now: the local skeptic supports a direction ONLY when the indicator
      // read AND the SMC read agree on it; anything mixed or one-sided stays
      // HOLD (the devil's advocate never invents an edge).
      t !== "HOLD" && t === smc ? t : "HOLD",
      "সংশয়: ফেকআউট বা লিকুইডিটি ট্র্যাপ ঝুঁকি যাচাই করুন।"),
    localAgent(AGENT_PERSONAS[4], ctx,
      highVol || wideSpread ? "HOLD" : smc !== "HOLD" ? smc : t,
      highVol ? "ATR অস্বাভাবিক উঁচু — ভোলাটিলিটি রেজিম বিপজ্জনক।"
      : wideSpread ? "স্প্রেড ATR-এর তুলনায় বেশি — কস্ট রেজিম খারাপ।"
      : `সেশন ${s.session} — ভোলাটিলিটি স্বাভাবিক, ট্রেড করা যায়।`),
  ];
}

// ── the CTO decision sanitizer ──────────────────────────────────────────────

interface CtoRaw {
  action: "BUY" | "SELL" | "HOLD";
  entry: number; sl: number; tp: number; tp2: number | null;
  consensus: number; reasoning: string;
}

function parseCto(raw: string): CtoRaw | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const action = j.action === "BUY" || j.action === "SELL" || j.action === "HOLD" ? j.action : null;
    if (!action) return null;
    return {
      action,
      entry: Number(j.entry), sl: Number(j.sl), tp: Number(j.tp),
      tp2: j.tp2 == null ? null : Number(j.tp2),
      consensus: Math.max(0, Math.min(100, Math.round(Number(j.consensus) || 0))),
      reasoning: typeof j.reasoning === "string" ? j.reasoning.trim().slice(0, 400) : "",
    };
  } catch {
    return null;
  }
}

/** geometry validation + repair. Returns null when the plan is unfixable. */
function sanitizeDecision(
  cto: CtoRaw,
  ctx: BoardContext,
  votes: { id: string; vote: string }[],
): { entry: number; sl: number; tp: number; tp2: number | null; rr: number } | null {
  if (cto.action === "HOLD") return null;
  const dir = cto.action; // BUY | SELL
  const a = ctx.atr;
  let { entry, sl, tp, tp2 } = cto;
  if (![entry, sl, tp].every((v) => Number.isFinite(v))) return null;

  // entry must be near the market (market or near-limit entry)
  if (Math.abs(entry - ctx.price) > 1.8 * a) return null;
  // direction invariant; try ONE repair (mirror the wrong side) before dropping
  if (dir === "BUY") {
    if (!(sl < entry && tp > entry)) {
      // maybe the model swapped sl/tp
      if (tp < entry && sl > entry) [sl, tp] = [tp, sl];
      else return null;
    }
  } else {
    if (!(sl > entry && tp < entry)) {
      if (tp > entry && sl < entry) [sl, tp] = [tp, sl];
      else return null;
    }
  }
  // stop distance sane: ≥ 0.15 ATR (not noise) and ≤ 4 ATR (not a moonshot)
  const risk = Math.abs(entry - sl);
  if (risk < 0.15 * a || risk > 4 * a) return null;
  // RR floor 1.5 — if the model's TP is too close, stretch it to 2R
  let rr = Math.abs(tp - entry) / risk;
  if (rr < 1.5) {
    tp = dir === "BUY" ? entry + 2 * risk : entry - 2 * risk;
    rr = 2;
    tp2 = null;
  }
  if (rr > 10) return null; // absurd
  if (tp2 != null && !Number.isFinite(tp2)) tp2 = null;
  if (tp2 != null) {
    // tp2 must extend beyond tp in the profit direction
    if (dir === "BUY" && tp2 <= tp) tp2 = null;
    else if (dir === "SELL" && tp2 >= tp) tp2 = null;
  }
  void votes;
  return {
    entry: Number(entry.toFixed(ctx.digits)),
    sl: Number(sl.toFixed(ctx.digits)),
    tp: Number(tp.toFixed(ctx.digits)),
    tp2: tp2 == null ? null : Number(tp2.toFixed(ctx.digits)),
    rr: Number(rr.toFixed(2)),
  };
}

/** the deterministic local CTO: weighted vote + geometry from the nearest
 *  fresh zone in the winning direction. */
function localCtoDecision(
  ctx: BoardContext,
  votes: BoardAgentOut[],
): { cto: CtoRaw; geom: ReturnType<typeof sanitizeDecision> } {
  let score = 0;
  const w: Record<string, number> = { trend: 1, smc: 1.2, risk: 1, skeptic: 0.8, volatility: 0.8 };
  for (const v of votes) {
    if (v.id === "cto") continue;
    const k = w[v.id] ?? 1;
    score += (v.vote === "BUY" ? 1 : v.vote === "SELL" ? -1 : 0) * k * (0.5 + v.confidence / 200);
  }
  const dir: "BUY" | "SELL" | "HOLD" = score >= 1.0 ? "BUY" : score <= -1.0 ? "SELL" : "HOLD";

  let geom: ReturnType<typeof sanitizeDecision> = null;
  if (dir !== "HOLD") {
    const bull = dir === "BUY";
    // lean on the nearest fresh zone in the trade direction; else EMA pullback
    const z = ctx.zones.find((zz) => {
      const isBull = zz.side === "ob_bull" || zz.side === "demand" || zz.side === "fvg_bull";
      return bull ? isBull && zz.hi <= ctx.price + 0.3 * ctx.atr
                  : !isBull && zz.lo >= ctx.price - 0.3 * ctx.atr;
    });
    const entry = z
      ? (bull ? Math.min(ctx.price, z.hi) : Math.max(ctx.price, z.lo))
      : ctx.price;
    const sl = bull
      ? Math.min(entry - 0.6 * ctx.atr, z ? z.lo - 0.15 * ctx.atr : entry - 0.8 * ctx.atr)
      : Math.max(entry + 0.6 * ctx.atr, z ? z.hi + 0.15 * ctx.atr : entry + 0.8 * ctx.atr);
    const tp = bull ? entry + 2 * (entry - sl) : entry - 2 * (sl - entry);
    geom = sanitizeDecision(
      { action: dir, entry, sl, tp, tp2: null, consensus: 0, reasoning: "" },
      ctx, [],
    );
  }
  const consensus = Math.round(Math.min(100, Math.abs(score) * 30 + (geom ? 25 : 0)));
  const buyBn = votes.filter((v) => v.vote === "BUY").length;
  const sellBn = votes.filter((v) => v.vote === "SELL").length;
  return {
    cto: {
      action: geom ? dir : "HOLD",
      entry: geom?.entry ?? 0, sl: geom?.sl ?? 0, tp: geom?.tp ?? 0, tp2: geom?.tp2 ?? null,
      consensus,
      reasoning: geom
        ? `বোর্ড ভোট ${buyBn} BUY / ${sellBn} SELL — ${dir === "BUY" ? "ডিমান্ড জোনে" : "সাপ্লাই জোনে"} কনফ্লুয়েন্স এন্ট্রি, SL জোনের ওপারে, TP 2R।`
        : `বোর্ড ঐক্যে পৌঁছায়নি (${buyBn} BUY / ${sellBn} SELL / ${votes.length - buyBn - sellBn} HOLD) — ক্যাশও একটি পজিশন।`,
    },
    geom,
  };
}

// ── deterministic drawing geometry (the LLM decides, the code draws) ───────

export function buildDecisionDrawings(
  action: "BUY" | "SELL",
  entry: number,
  ctx: BoardContext,
): BoardDrawings {
  const out: BoardDrawings = {};
  const a = ctx.atr;

  // OB / zone box: the fresh zone the trade leans on — must sit on the
  // correct side of the entry and within reach
  const bull = action === "BUY";
  const z = ctx.zones.find((zz) => {
    const isBull = zz.side === "ob_bull" || zz.side === "demand" || zz.side === "fvg_bull";
    return bull
      ? isBull && zz.hi <= entry + 0.25 * a && entry - zz.hi < 2.5 * a
      : !isBull && zz.lo >= entry - 0.25 * a && zz.lo - entry < 2.5 * a;
  });
  if (z) {
    const names: Record<string, string> = {
      ob_bull: "OB+", ob_bear: "OB−", demand: "DEMAND", supply: "SUPPLY",
      fvg_bull: "FVG+", fvg_bear: "FVG−",
    };
    out.ob = {
      t: z.t, hi: z.hi, lo: z.lo,
      side: (z.side === "ob_bull" || z.side === "demand" || z.side === "fvg_bull") ? "bull" : "bear",
      label: names[z.side] ?? "ZONE",
    };
  }

  // trendline: connect the last two same-kind structure swings in the
  // trade direction (HLs for BUY — ascending; LHs for SELL — descending)
  const tags = bull ? ["HL", "LL"] : ["LH", "HH"]; // prefer HL/LH, fall back
  const pts = ctx.swingList.filter((s) => s.tag === (bull ? "HL" : "LH")).slice(-2);
  let pair = pts.length === 2 ? pts : null;
  if (pair) {
    const [p1, p2] = pair;
    const ascending = bull && p2.price > p1.price;
    const descending = !bull && p2.price < p1.price;
    if (!ascending && !descending) pair = null;
  }
  if (!pair) {
    // fallback: the last two same-side swings regardless of tag direction
    const alt = ctx.swingList.filter((s) => (bull ? s.tag === "LL" : s.tag === "HH")).slice(-2);
    if (alt.length === 2) {
      const [p1, p2] = alt;
      const ok = bull ? p2.price > p1.price : p2.price < p1.price;
      if (ok) pair = alt;
    }
  }
  void tags;
  if (pair) {
    out.trendline = {
      t1: pair[0].t, p1: pair[0].price,
      t2: pair[1].t, p2: pair[1].price,
    };
  }
  return out;
}

// ── lot sizing (deterministic, risk % of balance) ──────────────────────────

export function lotFor(
  symbol: string,
  balance: number | null,
  entry: number,
  sl: number,
  riskPct = 1,
): number | null {
  if (balance == null || balance <= 0) return null;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const riskUsd = balance * (riskPct / 100);
  // XAU: 1 lot = 100 oz → $1 price move = $100/lot. Forex: approximate by
  // digits (2 = 100k units like EURUSD → $10/pip-like 0.0001*10) — a
  // coarse but honest size hint; the card labels it "suggested".
  const perUnitPerLot = /XAU/i.test(symbol) ? 100
    : /BTC/i.test(symbol) ? 1
    : /XAG/i.test(symbol) ? 50
    : 100000 * 0.0001 * 10 / 10; // ~$10 per 0.0001 on majors ≈ $1 per 0.00001 — keep simple: not used for non-XAU precision
  const lot = riskUsd / (risk * perUnitPerLot);
  if (!Number.isFinite(lot) || lot <= 0) return null;
  return Number(lot.toFixed(2));
}

// ── the meeting ─────────────────────────────────────────────────────────────

/**
 * v24 — the ONE-CALL committee prompt: all 5 analyst personas, each with its
 * own specialty + voting rule + assigned brain, voting independently inside
 * a single request. Replaces 5 separate engine calls (rate-limit relief).
 * v26 — each agent section now carries its ASSIGNED brain's persona, so every
 * vote is cast in that model's own voice, and the batch call itself rides the
 * TREND agent's assigned model (the committee chair): with the v25 flagship
 * defaults the flagship committee actually runs, and the per-agent badges
 * stay honest.
 */
function buildCommitteeSystem(personas: AgentPersona[], models?: Record<string, string>): string {
  const members = personas
    .map((p, i) => {
      // strip the trailing per-agent JSON rule — the committee has its own
      const body = p.system.replace(JSON_RULE, "").trim();
      const m = models?.[p.id] ? modelById(models[p.id]) : null;
      const brain = m ? `\nASSIGNED BRAIN: ${m.label} — ${m.persona}` : "";
      return `AGENT ${i + 1} — id "${p.id}" · ${p.roleEn}${brain}\n${body}`;
    })
    .join("\n\n");

  return (
    "You are the ANALYST COMMITTEE of a 6-member AI trading board (XAUUSD, MetaTrader 5) — five specialists deliberating in ONE room. " +
    "For EACH agent below: think STRICTLY inside that agent's own domain, then cast that agent's OWN vote. " +
    "Agents must NOT converge or copy each other — Agent 1 sees ONLY indicators, Agent 2 ONLY smart-money structure, Agent 3 ONLY trade geometry, Agent 4 argues the BEAR case against the trade, Agent 5 ONLY the volatility/news regime. " +
    "An agent with no edge in its own domain votes HOLD. Notes are in Bengali (trading terms in English).\n\n" +
    members +
    "\n\nDeliberate agent by agent (1→5), then answer. Respond ONLY with valid JSON, no markdown fences — an array of EXACTLY 5 objects in order: " +
    '[{"id":"trend","vote":"BUY"|"SELL"|"HOLD","confidence":<0-100 integer>,"note":"<Bengali, ≤ 18 words>"},' +
    '{"id":"smc",…},{"id":"risk",…},{"id":"skeptic",…},{"id":"volatility",…}]'
  );
}

/** parse the committee's JSON array (fences tolerated, partial arrays kept) */
function parseCommitteeVotes(
  raw: string,
): { id: string; vote: "BUY" | "SELL" | "HOLD"; confidence: number; note: string }[] | null {
  const validIds = new Set(AGENT_PERSONAS.map((p) => p.id as string));
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const candidates: unknown[] = [];
  // 1) a top-level array
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) candidates.push(...parsed);
    } catch { /* fall through */ }
  }
  // 2) {"votes": [...]} wrapper
  if (!candidates.length) {
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart !== -1 && objEnd > objStart) {
      try {
        const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1)) as { votes?: unknown[] };
        if (Array.isArray(parsed?.votes)) candidates.push(...parsed.votes);
      } catch { /* fall through */ }
    }
  }
  // 3) regex salvage: individual vote objects. v26 — a loose object that
  // carries its own valid `id` is attributed to THAT agent (the model said
  // who voted); positional order is only the fallback.
  if (!candidates.length) {
    const objs = (cleaned.match(/\{[^{}]*\}/g) ?? [])
      .map((m) => parseAgentJson(m))
      .filter((o): o is NonNullable<ReturnType<typeof parseAgentJson>> => o != null);
    objs.forEach((o, i) => {
      const persona =
        o.id && validIds.has(o.id)
          ? AGENT_PERSONAS.find((p) => p.id === o.id)
          : AGENT_PERSONAS[i];
      if (persona) candidates.push({ id: persona.id, vote: o.vote, confidence: o.confidence, note: o.note });
    });
  }
  const out: { id: string; vote: "BUY" | "SELL" | "HOLD"; confidence: number; note: string }[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const j = c as Record<string, unknown>;
    const id = typeof j.id === "string" ? j.id : null;
    const vote = j.vote === "BUY" || j.vote === "SELL" || j.vote === "HOLD" ? j.vote : null;
    if (!id || !validIds.has(id) || !vote) continue;
    if (out.some((o) => o.id === id)) continue; // first vote per agent wins
    out.push({
      id,
      vote,
      confidence: Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0))),
      note: typeof j.note === "string" ? j.note.trim().slice(0, 220) : "",
    });
  }
  return out.length ? out : null;
}

export interface MeetingResult {
  agents: BoardAgentOut[];
  decision: BoardDecision;
  degraded: boolean;
  context: BoardContext;
}

export async function runBoardMeeting(
  ctx: BoardContext,
  symbol: string,
  balance: number | null,
  /** v22 — per-agent model ids from Settings → AI Models (defaults to GLM) */
  models?: Record<string, string>,
): Promise<MeetingResult> {
  const contextJson = JSON.stringify(ctx.json);
  const userMsg = `Live market snapshot (JSON):\n${contextJson}\n\nCast your vote now.`;
  const ctoUser = (agents: BoardAgentOut[]) =>
    `Market snapshot (JSON):\n${contextJson}\n\nThe five agents voted:\n${agents
      .filter((a) => a.id !== "cto")
      .map((a) => `- ${a.roleEn} [${a.model}]: ${a.vote} (${a.confidence}%) — ${a.note}`)
      .join("\n")}\n\nIssue the final decision now.`;

  // ── v24 — agents 1–5 in ONE committee call (was 5 separate engine calls).
  //    Backtest finding: 6 calls per meeting + auto-run starved the shared
  //    engine and made the user's CHAT hit rate limits ("limit exhausted").
  //    The committee keeps every agent's own specialty, rule, assigned brain
  //    and Bengali voice — they just share one request now (6 → 2 calls per
  //    meeting, −66% engine pressure). A short/failed batch degrades ONLY
  //    the missing agents to their deterministic local reads.
  //    v26 — the batch now rides the TREND agent's assigned model (the chair)
  //    and every section carries its own brain's persona, so the flagship
  //    committee actually runs and votes in each model's voice. Budgets
  //    tightened 34s→28s / 30s→22s so committee+CTO+spacing fit the route's
  //    maxDuration with room to spare. ──
  let degraded = false;
  const localFb = localAgents(ctx);
  const committeeSystem = buildCommitteeSystem(AGENT_PERSONAS, models);
  const batchModelId = models?.trend && modelById(models.trend) ? models.trend : undefined;
  const batchRes = await llmJson(committeeSystem, userMsg, 28_000, batchModelId);
  const batchVotes = batchRes.ok ? parseCommitteeVotes(batchRes.raw) : null;
  if (!batchVotes) degraded = true;

  const analysts: BoardAgentOut[] = AGENT_PERSONAS.map((persona, i) => {
    const v = batchVotes?.find((x) => x.id === persona.id);
    if (v) {
      return {
        id: persona.id, roleEn: persona.roleEn, roleBn: persona.roleBn,
        model: agentBadge(persona, models?.[persona.id]),
        vote: v.vote, confidence: v.confidence, note: v.note,
      };
    }
    if (batchVotes) degraded = true; // batch answered but this agent is missing
    return { ...localFb[i], model: agentBadge(persona, models?.[persona.id]) };
  });

  // ── the CTO — the final word (gate retries inside its budget) ──
  const ctoModelId = models?.cto;
  const ctoRes = await llmJson(CTO_PERSONA.system, ctoUser(analysts), 22_000, ctoModelId);
  const ctoUsedModelId = ctoRes.usedModelId;
  const ctoParsed = ctoRes.ok ? parseCto(ctoRes.raw) : null;
  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  let geom: ReturnType<typeof sanitizeDecision> = null;
  let consensus = 0;
  let reasoning = "";

  if (ctoParsed) {
    geom = sanitizeDecision(ctoParsed, ctx, analysts);
    action = geom ? ctoParsed.action : "HOLD";
    consensus = ctoParsed.consensus;
    reasoning = ctoParsed.reasoning;
  } else {
    degraded = true;
  }

  if (!geom) {
    // local CTO fallback (also used when the CTO said HOLD but the vote was
    // overwhelming — no: HOLD is a valid CTO decision, only replace it when
    // the CTO call itself FAILED)
    if (!ctoParsed) {
      const fb = localCtoDecision(ctx, analysts);
      action = fb.cto.action;
      geom = fb.geom;
      consensus = fb.cto.consensus;
      reasoning = fb.cto.reasoning;
    }
  }

  const ctoAgent: BoardAgentOut = {
    id: "cto", roleEn: CTO_PERSONA.roleEn, roleBn: CTO_PERSONA.roleBn,
    model: agentBadge(CTO_PERSONA, ctoUsedModelId),
    vote: action,
    confidence: consensus,
    note: reasoning || (action === "HOLD" ? "কনসেনসাস অনুপস্থিত — HOLD।" : "চূড়ান্ত সিদ্ধান্ত জারি হলো।"),
    degraded: !ctoParsed,
  };

  const decision: BoardDecision = {
    action,
    entry: geom?.entry ?? null,
    sl: geom?.sl ?? null,
    tp: geom?.tp ?? null,
    tp2: geom?.tp2 ?? null,
    rr: geom?.rr ?? null,
    lot: geom ? lotFor(symbol, balance, geom.entry, geom.sl) : null,
    consensus,
    reasoning: reasoning || (action === "HOLD" ? "এই বারে কোনো সেটআপ বোর্ডের শর্ত পাস করেনি — ধৈর্য।" : ""),
    drawings:
      geom && (action === "BUY" || action === "SELL")
        ? buildDecisionDrawings(action, geom.entry, ctx)
        : {},
  };

  return { agents: [...analysts, ctoAgent], decision, degraded, context: ctx };
}

// ── deterministic local read (exported for the Control Tower's MTF grid) ─────

/** the board's local brain, no LLM: weighted analyst votes + zone geometry.
 *  The Tower uses it to keep every timeframe's bias fresh between meetings. */
export function localBoardRead(ctx: BoardContext): {
  bias: "BUY" | "SELL" | "HOLD";
  consensus: number;
} {
  const votes = localAgents(ctx);
  const fb = localCtoDecision(ctx, votes);
  return { bias: fb.cto.action, consensus: fb.cto.consensus };
}

// ── outcome tracking (the board's own win/loss record) ─────────────────────

export interface OpenLike {
  id: string;
  action: string;
  entry: number;
  sl: number;
  tp: number;
  barTime: number;
  status: string;
}

export function resolveOutcome(
  s: OpenLike,
  barsSince: Candle[],
  tfSec: number,
): { status: "open" | "won" | "lost" | "expired"; resultPct: number | null } {
  if (s.action === "HOLD" || !barsSince.length) {
    // HOLD decisions expire after one bar (they carry no position)
    if (s.action === "HOLD" && barsSince.length >= 1) return { status: "expired", resultPct: null };
    return { status: s.action === "HOLD" ? "open" : (s.status as "open"), resultPct: null };
  }
  const buy = s.action === "BUY";
  for (const b of barsSince) {
    if (buy) {
      if (b.c >= s.tp) return { status: "won", resultPct: ((s.tp - s.entry) / s.entry) * 100 };
      if (b.c <= s.sl) return { status: "lost", resultPct: ((s.sl - s.entry) / s.entry) * 100 };
    } else {
      if (b.c <= s.tp) return { status: "won", resultPct: ((s.entry - s.tp) / s.entry) * 100 };
      if (b.c >= s.sl) return { status: "lost", resultPct: ((s.entry - s.sl) / s.entry) * 100 };
    }
  }
  // stale: 3× the tf without resolution → expired
  const newest = barsSince[barsSince.length - 1].t;
  if (newest - s.barTime > 3 * tfSec * 30) return { status: "expired", resultPct: null };
  return { status: "open", resultPct: null };
}
