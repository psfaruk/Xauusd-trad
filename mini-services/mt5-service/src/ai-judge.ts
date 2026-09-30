/**
 * ai-judge.ts — the REAL AI inside the trading brain.
 *
 * A large language model (GLM via z-ai-web-dev-sdk — free, no API key, runs
 * server-side) that the brain consults:
 *   • ENTRY verdicts  — is this lamp signal a genuine breakout worth risk, or
 *                       a trap? It sees the same things the chart shows:
 *                       S/R, POC/VAH/VAL, trend, candle tape, spread, momentum.
 *   • REVIEW verdicts — for open positions: hold / tighten / close, using the
 *                       live R, peak R, age and flow.
 *
 * Deterministic rails stay in trader.ts (risk caps, spread budget, cooldowns,
 * max positions). The judge refines JUDGEMENT — it may confirm the candidate
 * side or veto it ("pass"). It can never flip the side (safety) and its
 * SL/TP adjustments are clamped.
 *
 * All verdict notes are written in বাংলা — the brain speaks the user's language.
 */

export type VerdictAction = "buy" | "sell" | "pass" | "hold" | "tighten" | "close";

export interface JudgeVerdict {
  action: VerdictAction;
  conf: number;          // 0..100
  note: string;          // বাংলা — shown live in the UI
  slAtrMult?: number;    // entry verdicts: SL = ATR × this (clamped 0.8..3.2)
  tpR?: number;          // entry verdicts: TP = R × this (clamped 1.2..3.5)
}

export interface EntryContext {
  symbol: string;
  candidateSide: "buy" | "sell";
  lampStrength: number;        // 0..1
  trendOk: boolean;            // price vs EMA20 agrees
  momOk: boolean;              // tick momentum agrees
  extAtr: number;              // |price − EMA20| / ATR (chase guard)
  mtf?: { agree: number; total: number; note: string }; // 8-frame consensus (v6)
  momWith?: number;            // signed tick momentum with the side (v6)
  tpUsd?: number;              // fixed-dollar profit target (v6; 0 = R-mode)
  market: {
    digits: number;
    price: number;
    atr: number;
    trend: { dir: string; slopeAtr: number };
    supports: { price: number; touches: number; ageMin: number }[];
    resistances: { price: number; touches: number; ageMin: number }[];
    valueArea: { poc: number; vah: number; val: number } | null;
    bias: { state: string; strength: number } | null;
    candles: { o: number; h: number; l: number; c: number }[]; // recent M1
  };
  spreadInAtr: number;         // spread / ATR
  lessons: string[];           // the brain's own lessons for this symbol (বাংলা)
  edgeWinRate: number | null;  // learned win-rate (EMA) — null if no evidence
  openSame: { side: string; pnlR: number }[]; // open positions on this symbol
  riskMode: string;
}

export interface ReviewContext {
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  price: number;
  pnlR: number;
  peakR: number;
  heldSec: number;
  beMoved: boolean;
  partialDone: boolean;
  tpUsd?: number;              // fixed-dollar target mode (v6)
  tpLeftUsd?: number;          // $ still to go to the target (v6)
  market: EntryContext["market"];
  bias: { state: string; strength: number } | null;
}

export interface JudgeStats {
  ok: number;
  fail: number;
  lastOkAt: number;
  avgMs: number;
  lastError: string;
  model: string;
  /** ms epoch until which the judge refuses to call the provider (429 backoff).
   *  0 = not paused. The brain reads this to explain "AI offline" honestly. */
  pausedUntil?: number;
}

const JUDGE_MODEL_NOTE = "glm (z-ai-web-dev-sdk, in-sandbox, keyless)";

export class AiJudge {
  private zai: { chat: { completions: { create: (a: unknown) => Promise<{ choices: { message?: { content?: string } }[] }> } } } | null = null;
  private creating = false;
  // ── 429 BACKOFF — hammering a rate-limited provider every cooldown only
  //    burns the shared quota (113 fails / 0 OK observed live). After 3
  //    straight failures the judge pauses itself, doubling the pause up to
  //    10 min. Any success fully resets it. Local rules keep trading. ──
  private consecFails = 0;
  private pausedUntil = 0;
  stats: JudgeStats = { ok: 0, fail: 0, lastOkAt: 0, avgMs: 0, lastError: "", model: JUDGE_MODEL_NOTE };

  private backoffMs(): number {
    if (this.consecFails < 3) return 0;
    return Math.min(10 * 60_000, 30_000 * 2 ** (this.consecFails - 3));
  }

  private async sdk() {
    if (this.zai) return this.zai;
    if (this.creating) return null; // another call is initializing — skip this round
    this.creating = true;
    try {
      const mod = (await import("z-ai-web-dev-sdk")) as unknown as { default: { create: () => Promise<unknown> } };
      this.zai = (await mod.default.create()) as never;
      return this.zai;
    } catch (e) {
      this.stats.lastError = (e as Error)?.message ?? String(e);
      return null;
    } finally {
      this.creating = false;
    }
  }

  private parseVerdict(text: string | undefined): JudgeVerdict | null {
    if (!text) return null;
    let raw = text.trim();
    // fence tolerance
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const action = String(o.action ?? "").toLowerCase();
      const conf = Math.max(0, Math.min(100, Math.round(Number(o.conf ?? 50) || 50)));
      const note = String(o.note ?? "").slice(0, 160) || "—";
      const v: JudgeVerdict = { action: action as VerdictAction, conf, note };
      if (typeof o.slAtrMult === "number") v.slAtrMult = Math.max(0.8, Math.min(3.2, o.slAtrMult));
      if (typeof o.tpR === "number") v.tpR = Math.max(1.2, Math.min(3.5, o.tpR));
      return v;
    } catch { return null; }
  }

  private async call(system: string, user: string): Promise<{ text?: string; ms: number } | null> {
    // backoff gate — never touch the provider while paused
    if (Date.now() < this.pausedUntil) {
      this.stats.pausedUntil = this.pausedUntil;
      this.stats.lastError = this.stats.lastError || "provider rate-limited (429) — judge paused";
      return null;
    }
    const zai = await this.sdk();
    if (!zai) return null;
    const t0 = Date.now();
    try {
      const r = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: system },
          { role: "user", content: user },
        ],
        thinking: { type: "disabled" },
      });
      const ms = Date.now() - t0;
      this.stats.ok++;
      this.stats.lastOkAt = Date.now();
      this.stats.avgMs = Math.round((this.stats.avgMs * (this.stats.ok - 1) + ms) / this.stats.ok);
      // healthy answer — full reset of the backoff state
      this.consecFails = 0;
      this.pausedUntil = 0;
      this.stats.pausedUntil = 0;
      return { text: r.choices?.[0]?.message?.content, ms };
    } catch (e) {
      this.stats.fail++;
      this.stats.lastError = (e as Error)?.message ?? String(e);
      this.consecFails++;
      const wait = this.backoffMs();
      if (wait > 0) {
        this.pausedUntil = Date.now() + wait;
        this.stats.pausedUntil = this.pausedUntil;
        this.stats.lastError += ` — judge paused ${Math.round(wait / 1000)}s (backoff)`;
      }
      return null;
    }
  }

  /** Should the brain enter on this candidate? buy/sell = go (side must match
   *  the candidate — a mismatched answer is treated as pass), pass = veto. */
  async judgeEntry(ctx: EntryContext): Promise<JudgeVerdict | null> {
    const m = ctx.market;
    const candles = m.candles.slice(-16).map((c) =>
      `${c.o.toFixed(m.digits)}>${c.h.toFixed(m.digits)}>${c.l.toFixed(m.digits)}>${c.c.toFixed(m.digits)}`,
    ).join(" ");
    const user = [
      `SYMBOL ${ctx.symbol} — ${ctx.riskMode} risk account. Judge a ${ctx.candidateSide.toUpperCase()} entry NOW.`,
      ``,
      `MARKET (live):`,
      `· price=${m.price.toFixed(m.digits)} ATR=${m.atr.toFixed(m.digits)} spread=${(ctx.spreadInAtr * 100).toFixed(0)}%ofATR`,
      `· trend=${m.trend.dir}(${m.trend.slopeAtr}/bar) · M1 tape(oldest→newest O>H>L>C): ${candles}`,
      `· supports=${m.supports.map((s) => `${s.price.toFixed(m.digits)}(${s.touches}t)`).join(" ") || "none"}`,
      `· resistances=${m.resistances.map((s) => `${s.price.toFixed(m.digits)}(${s.touches}t)`).join(" ") || "none"}`,
      `· valueArea=${m.valueArea ? `POC ${m.valueArea.poc.toFixed(m.digits)} VAH ${m.valueArea.vah.toFixed(m.digits)} VAL ${m.valueArea.val.toFixed(m.digits)}` : "n/a"}`,
      `· liveFlow=${m.bias ? `${m.bias.state} ${(m.bias.strength * 100) | 0}%` : "n/a"}`,
      ``,
      `SIGNAL: lamp ${ctx.candidateSide} conviction ${(ctx.lampStrength * 100) | 0}%`,
      `· trendAgrees=${ctx.trendOk} momentumAgrees=${ctx.momOk} extension=${ctx.extAtr.toFixed(2)}ATR`,
      `· MTF consensus=${ctx.mtf ? `${ctx.mtf.agree}/${ctx.mtf.total} frames aligned (${ctx.mtf.note})` : "n/a"}`,
      `· tickMomentum(with side)=${ctx.momWith !== undefined ? ctx.momWith.toFixed(2) : "n/a"}`,
      `· profitPolicy=${ctx.tpUsd && ctx.tpUsd > 0 ? `bank at +$${ctx.tpUsd} FIXED (small-win scalping — favor fast momentum continuation)` : "R-multiple targets"}`,
      `· openSameSymbol=${ctx.openSame.map((p) => `${p.side} ${p.pnlR.toFixed(2)}R`).join(",") || "none"}`,
      `· myLessons=${ctx.lessons.slice(-2).join(" | ") || "none"}`,
      `· learnedWinRate=${ctx.edgeWinRate === null ? "no evidence" : `${(ctx.edgeWinRate * 100) | 0}%`}`,
      ``,
      `RULES: you may only confirm ${ctx.candidateSide.toUpperCase()} or veto with "pass" — never flip the side.`,
      `Prefer entries NEAR value (POC/EMA zone), not chasing extension. A close through a 3-touch level = caution.`,
      `Reply ONE JSON object exactly: {"action":"${ctx.candidateSide}|pass","conf":0-100,"slAtrMult":0.8-3.2,"tpR":1.2-3.5,"note":"≤140 chars বাংলায়"}`,
    ].join("\n");
    const r = await this.call(
      "You are a cold-blooded M1 scalper judge. You have seen thousands of breakout traps. You reply with ONE JSON object only — no prose, no markdown. The note field is a short বাংলা sentence (the user reads it live).",
      user,
    );
    if (!r) return null;
    const v = this.parseVerdict(r.text);
    if (!v) return null;
    if (v.action !== "buy" && v.action !== "sell" && v.action !== "pass") v.action = "pass";
    if ((v.action === "buy" || v.action === "sell") && v.action !== ctx.candidateSide) {
      // model tried to flip the side — treat as veto, keep its reasoning
      return { action: "pass", conf: v.conf, note: `বিপরীত মত (${v.note})`, tpR: v.tpR, slAtrMult: v.slAtrMult };
    }
    return v;
  }

  /** Hold / tighten / close for an open position. */
  async judgeReview(ctx: ReviewContext): Promise<JudgeVerdict | null> {
    const m = ctx.market;
    const user = [
      `POSITION ${ctx.symbol} ${ctx.side.toUpperCase()} ${ctx.lots} lots @${ctx.entry.toFixed(m.digits)}`,
      `· now=${ctx.price.toFixed(m.digits)} P/L=${ctx.pnlR.toFixed(2)}R (peak ${ctx.peakR.toFixed(2)}R) held=${Math.round(ctx.heldSec / 60)}min`,
      `· target=${ctx.tpUsd && ctx.tpUsd > 0 ? `+$${ctx.tpUsd} fixed, $${(ctx.tpLeftUsd ?? 0).toFixed(2)} still to go` : "R-multiple"}`,
      `· slAtBreakeven=${ctx.beMoved} partialTaken=${ctx.partialDone}`,
      `· trend=${m.trend.dir}(${m.trend.slopeAtr}/bar) flow=${ctx.bias ? `${ctx.bias.state} ${(ctx.bias.strength * 100) | 0}%` : "n/a"}`,
      `· nearest support=${m.supports[0]?.price.toFixed(m.digits) ?? "n/a"} resistance=${m.resistances[0]?.price.toFixed(m.digits) ?? "n/a"}`,
      `· POC=${m.valueArea ? m.valueArea.poc.toFixed(m.digits) : "n/a"}`,
      ``,
      `RULES: "tighten" = lock more profit (SL closer). "close" only when the move is clearly dying or reversing against us.`,
      `Reply ONE JSON: {"action":"hold|tighten|close","conf":0-100,"note":"≤140 chars বাংলায়"}`,
    ].join("\n");
    const r = await this.call(
      "You are a disciplined M1 trade manager. You protect profit early and cut dead trades without hesitation. You reply with ONE JSON object only — no prose. The note is short বাংলা.",
      user,
    );
    if (!r) return null;
    const v = this.parseVerdict(r.text);
    if (!v) return null;
    if (v.action !== "hold" && v.action !== "tighten" && v.action !== "close") v.action = "hold";
    return v;
  }
}
