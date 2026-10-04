/**
 * Flow engine — the "running candle X-ray" scalpers read.
 *
 * What pro tape-readers see when they "know where the candle will go":
 *   1. TICK RULE  — every tick that lifts the price is aggressive BUYING,
 *                   every tick that drops it is aggressive SELLING (uptick/downtick).
 *   2. DELTA      — cumulative (buyTicks − sellTicks) inside the running candle.
 *                   Price up + delta up   = real buyers  → continuation.
 *                   Price up + delta down = hidden absorption → fragile.
 *   3. TAPE SPEED — ticks/sec burst = institutional urgency.
 *   4. WICK X-RAY — wicks growing against the body = passive defenders rejecting price.
 *   5. VOLUME NODES — price levels where the most ticks printed = where the battle is.
 *
 * Plus the SIGNAL LAMP — a hysteresis state machine (neutral → buy / sell)
 * that answers the only question a scalper cares about: "is this candle
 * being bought or sold RIGHT NOW, and will it continue?" It is deliberately
 * HARD to flip (persistence + wide hysteresis band + min-hold + cooldown),
 * because a lamp that whipsaws is worse than no lamp at all. Every completed
 * signal books its real outcome (points captured) so the panel can show a
 * live, honest win-rate.
 */

export interface FlowTick { p: number; d: 1 | -1 | 0; t: number; seq: number } // price, direction, epoch ms, per-candle sequence (unique key)
export interface FlowNode { p: number; b: number; s: number }
export interface FlowPrev { t: number; dir: 1 | -1; d: number; dp: number; r: number; h: number; l: number }

export interface FlowScore {
  bullProb: number; // 0..1 — probability the running candle closes bullish
  verdict: "buyers" | "sellers" | "absorb_top" | "absorb_bottom" | "balanced";
  drivers: {
    confirm: boolean; // delta direction agrees with candle direction
    speed: number; // −1..1 tape-speed burst vs candle average
    wick: number; // −1..1 net wick bias (lower wicks = bullish rejection)
    closePos: number; // 0..1 where price sits inside the candle range
    recentPct: number; // −1..1 micro-momentum (last 15 ticks)
  };
}

// ── the signal lamp ──
export interface FlowSignalEpisode { state: "buy" | "sell"; pts: number; holdMs: number; at: number; won: boolean }
export interface FlowSignal {
  state: "buy" | "sell" | "neutral";
  sinceMs: number;      // when the current state began (epoch ms)
  entryPrice: number;   // price when buy/sell engaged (0 for neutral)
  strength: number;     // 0..1 — conviction of the current state
  raw: number;          // −1..1 live bias score (smoothed)
  pnlPts: number;       // points moved since entry, signed by side
  flips: number;        // total engaged↔neutral transitions (session)
  quiet: boolean;       // tape asleep (< quietTps) — honest reason for WAIT
  stats: { fired: number; won: number; winPct: number; avgPts: number; avgHoldMs: number };
  recent: FlowSignalEpisode[]; // last completed episodes (newest last)
}

export interface FlowPayload {
  s: string; tf: string;
  t: number; // bar open (UTC sec)
  now: number; // emit time (epoch ms)
  o: number; h: number; l: number; c: number;
  buy: number; sell: number; flat: number;
  delta: number; deltaPct: number; recentDelta: number;
  tps: number; tpsAvg: number;
  lastTickMs: number;
  tape: FlowTick[];
  deltaHist: { t: number; d: number }[];
  /** cross-candle cumulative-delta history for the 2-candle delta-micro chart
   *  (each candle's delta restarts at 0 — the reset at every boundary is the
   *  point). Only attached ~every 2s (it barely changes); the fresh running
   *  tail always comes from deltaHist at full emit rate. */
  histDeep?: { t: number; d: number }[];
  nodes: FlowNode[];
  prev: FlowPrev[];
  score: FlowScore;
  sig: FlowSignal;
}

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2592000,
};

const TAPE_MAX = 26;        // ticks shown in the tape
const TICK_TIMES_MAX = 160; // ~5s window even at 30 tps
const DELTA_HIST_MAX = 130; // downsampled cumulative-delta sparkline
const DEEP_MAX = 2800;      // cross-candle delta buffer (~9 candles at 300/candle)
const DEEP_SEND = 720;      // points broadcast per refresh (~2.3 candles)
const DEEP_SEND_MS = 2000;  // refresh cadence — the deep path is slow-moving
const NODES_MAX = 400;      // price buckets kept (integer keys)
const EMIT_MIN_MS = 80;     // max ~12.5 emits/sec per tracker
const RECENT_N = 15;        // micro-momentum window

// ── signal-lamp tuning (time-based so it is tick-rate independent) ──
// Exported as an object so the backtest can sweep configurations; production
// uses DEFAULT_TUNE untouched.
export interface SigTune {
  entryRaw: number;        // |raw| must reach this to ENGAGE
  exitRaw: number;         // |raw| must collapse below this to DISENGAGE (hysteresis)
  persistEnterMs: number;  // raw must hold beyond entry threshold this long
  persistExitMs: number;   // raw must stay under exit threshold this long
  cooldownMs: number;      // neutral rest before a new engagement
  minDecisive: number;     // decisive ticks before engaging (dead tape = no signal)
  deltaExtreme: number;    // decisive-delta one-sidedness required at entry
  posBuy: number;          // closePos gate — buy only from the top of the candle
  posSell: number;         // sell only from the bottom
  rangeExpand: number;     // current range vs avg of last 3 candles (0 = off)
  trendGate: boolean;       // require previous candle to agree (continuation only)
  breakout: boolean;        // require price to break the rolling 5-bar range
  breakoutPad: number;      // fraction of current range allowed above/below the level
  minHoldM1: number;       // min hold (ms) for M1-class tfs
  ageFrac: number;         // candle-age gate: fraction of the tf that must elapse
  ageMinMs: number;        // candle-age gate: absolute minimum ms
  deltaAlpha: number;      // per-tick EMA of the decisive delta (core gauge speed)
  alphaRefTps: number;     // tape speed deltaAlpha was calibrated for — the gauge
                           // re-scales per-tick alpha so conviction builds in
                           // constant TIME (~10s) on ANY tape speed (see stepSignal)
  alphaMax: number;        // clamp for the re-scaled alpha (single tick must not
                           // jump the gauge — that would whipsaw on dead tape)
  quietTps: number;        // below this tape speed the lamp reports `quiet`
                           // (UI tells the user honestly the market is asleep)
}
export const DEFAULT_TUNE: SigTune = {
  // ── TUNED Sep 28 on 17k REAL recorded XAUUSDm ticks + 140k reconstructed
  // ticks (scripts/lamp-tune.ts) after the user reported the lamp sitting on
  // WAIT forever (production-before fired 1.2/h, 0% coverage — dead).
  // This tune: 4.7/h on the quiet evening tape (96% concurrent accuracy,
  // +635pt avg episode, 48% 30s-drift hit) and ~30/h cap on busy tape.
  // Anti-whipsaw machinery unchanged: wide hysteresis (exit at raw ≤0.12),
  // min-hold 8s, neutral-bridge (no direct buy↔sell), cooldown, adverse stop.
  entryRaw: 0.36,
  exitRaw: 0.12,
  persistEnterMs: 1500,
  persistExitMs: 1500,
  cooldownMs: 4000,
  minDecisive: 12,
  deltaExtreme: 0.20,
  posBuy: 0.57,
  posSell: 0.43,
  rangeExpand: 0,
  trendGate: true,
  breakout: false,
  breakoutPad: 0.10,
  minHoldM1: 8_000,
  ageFrac: 0.10,
  ageMinMs: 6_000,
  deltaAlpha: 0.09,
  // ── TAPE-SPEED ADAPTATION (Sep 28, after "waiting dekhay" report) ──
  // The user watches at Dhaka midnight: XAU tape drops to ~0.7 tps (NY closed,
  // Asian pre-open). A per-tick alpha of 0.09 needs 24 one-sided ticks = 36s
  // = 60% of an M1 candle to converge — conviction structurally could not
  // build inside a candle, so the lamp sat on WAIT even when one side really
  // did control the tape. The gauge now re-scales alpha by measured tps so
  // convergence takes the same WALL-CLOCK time at any speed (clamped so a
  // single tick never moves the gauge more than alphaMax).
  alphaRefTps: 2.5,
  alphaMax: 0.30,
  quietTps: 1.5,
};

/** min-hold + adverse-exit scale with the timeframe (stability for bigger candles) */
function minHoldMsFor(tfSec: number, minHoldM1: number) {
  if (tfSec <= 60) return minHoldM1;
  if (tfSec <= 300) return minHoldM1 * 2.5;
  if (tfSec <= 900) return minHoldM1 * 3.75;
  return minHoldM1 * 5.6;
}

const SIG_MAX_EPISODES = 50;       // outcome history kept for stats

export class FlowTracker {
  private tfSec: number;
  private prevMid: number | null = null;
  private prevDir: 1 | -1 | 0 = 0; // last direction (for flat-tick attribution)

  // running candle
  private bucket = 0;
  private o = 0; private h = 0; private l = 0; private c = 0;
  private buy = 0; private sell = 0; private flat = 0;
  private openedMs = 0;
  private totalTicks = 0;

  private tape: FlowTick[] = [];
  private tickTimes: number[] = [];
  private deltaHist: { t: number; d: number }[] = [];
  private lastHistMs = 0;
  /** continuous across candles: each candle's cumulative delta, reset to 0 at
   *  every boundary (the delta-micro chart draws these resets like the area
   *  chart draws bar boundaries). Sampling is tf-adaptive (≤300 pts/candle). */
  private histDeep: { t: number; d: number }[] = [];
  private histStepMs: number;
  private lastDeepMs = 0;
  private lastDeepSentMs = 0;
  /** final cumulative delta of the last N COMPLETED candles — the brain's
   *  delta-micro view (cross-candle delta continuity). */
  private prevFinals: number[] = [];
  private nodes = new Map<number, { b: number; s: number }>(); // INTEGER bucket → counts
  private nodeQuantum = 0;
  private prev: FlowPrev[] = [];

  private lastEmit = 0;
  private lastTickMs = 0;
  private dirty = false;
  private tune: SigTune;

  // ── signal lamp state ──
  private sigState: "buy" | "sell" | "neutral" = "neutral";
  private sigSinceMs = 0;
  private sigEntryPrice = 0;
  private sigFlips = 0;
  private sigLastExitMs = 0;
  private deltaEma = 0;                 // smoothed decisive-delta
  private bullAboveSince = 0;           // raw ≥ entry threshold since (ms)
  private bearBelowSince = 0;           // raw ≤ −entry threshold since (ms)
  private weakAboveSince = 0;           // raw ≤ exit threshold since (ms) — for buy exit
  private weakBelowSince = 0;           // raw ≥ −exit threshold since (ms) — for sell exit
  private episodes: FlowSignalEpisode[] = [];

  constructor(
    public readonly symbol: string,
    public readonly tf: string,
    private digits: number,
    tune?: Partial<SigTune>,
  ) {
    this.tfSec = TF_SEC[tf] ?? 60;
    this.tune = { ...DEFAULT_TUNE, ...(tune ?? {}) };
    this.nodeQuantum = Math.max(Math.pow(10, -digits) * 10, Math.pow(10, -digits)); // 10 ticks of precision
    this.histStepMs = Math.max(700, Math.round((this.tfSec * 1000) / 300));
  }

  /** feed a raw tick (mid price) — called for EVERY tick, pre-throttle */
  tick(mid: number, tsSec: number, tsMs: number) {
    if (!Number.isFinite(mid) || mid <= 0) return;

    const bucket = Math.floor(tsSec / this.tfSec) * this.tfSec;
    if (bucket !== this.bucket) {
      // archive the completed candle's final delta into the deep buffer:
      // final value at the boundary, then the new candle's restart at 0 —
      // the vertical reset line the delta-micro chart shows at every open.
      const finalD = this.buy - this.sell;
      if (this.totalTicks > 0) this.rollCandle();
      this.prevFinals.push(finalD);
      if (this.prevFinals.length > 8) this.prevFinals.shift();
      this.bucket = bucket;
      this.o = this.h = this.l = this.c = mid;
      this.buy = this.sell = this.flat = 0;
      this.totalTicks = 0;
      this.openedMs = tsMs;
      this.tape = [];
      this.tickTimes = [];
      this.deltaHist = [{ t: tsMs, d: 0 }];
      this.lastHistMs = tsMs;
      // boundary point only when a path already exists (a lone reset with no
      // history before it would float disconnected on the chart)
      if (this.histDeep.length) {
        this.histDeep.push({ t: tsMs, d: finalD }, { t: tsMs, d: 0 });
        if (this.histDeep.length > DEEP_MAX) this.histDeep.shift();
      }
      this.lastDeepMs = tsMs;
      this.nodes.clear();
      this.prevMid = null; // tick-rule resets on new candle (open auction unknown)
      this.onCandleRoll(tsMs);
    }

    // ── tick rule: direction vs previous mid ──
    let dir: 1 | -1 | 0;
    if (this.prevMid === null || mid === this.prevMid) {
      dir = 0;
      this.flat++;
      // attribute flats to the previous direction when known (quote refresh at same price)
    } else {
      dir = mid > this.prevMid ? 1 : -1;
      this.prevDir = dir;
      if (dir === 1) this.buy++;
      else this.sell++;
    }
    this.prevMid = mid;

    this.h = Math.max(this.h, mid);
    this.l = Math.min(this.l, mid);
    this.c = mid;
    this.totalTicks++;
    this.lastTickMs = tsMs;

    // tape (newest last) — seq makes each entry a unique React key even when
    // multiple ticks land in the same millisecond
    this.tape.push({ p: mid, d: dir, t: tsMs, seq: this.totalTicks });
    if (this.tape.length > TAPE_MAX) this.tape.shift();

    // speed window
    this.tickTimes.push(tsMs);
    while (this.tickTimes.length > TICK_TIMES_MAX) this.tickTimes.shift();

    // cumulative delta history (downsample ~1 point / 700ms)
    const delta = this.buy - this.sell;
    if (tsMs - this.lastHistMs >= 700) {
      this.deltaHist.push({ t: tsMs, d: delta });
      if (this.deltaHist.length > DELTA_HIST_MAX) this.deltaHist.shift();
      this.lastHistMs = tsMs;
    }

    // deep cross-candle buffer (tf-adaptive step) — the 2-candle delta chart
    if (tsMs - this.lastDeepMs >= this.histStepMs) {
      this.histDeep.push({ t: tsMs, d: delta });
      if (this.histDeep.length > DEEP_MAX) this.histDeep.shift();
      this.lastDeepMs = tsMs;
    }

    // volume nodes (tick count per price bucket, split by direction)
    // NOTE: keys are INTEGERS (bucket index) — float keys like
    // Math.round(p/q)*q produce two different keys for the same price.
    if (dir === 0 && this.prevDir !== 0 && this.prevMid !== null) {
      // flat tick refreshes the book at the prev battleground — count to prev side lightly
      const bk = Math.round(this.prevMid / this.nodeQuantum);
      const n = this.nodes.get(bk) ?? { b: 0, s: 0 };
      if (this.prevDir === 1) n.b += 0.5;
      else n.s += 0.5;
      this.nodes.set(bk, n);
    } else if (dir !== 0) {
      const bk = Math.round(mid / this.nodeQuantum);
      const n = this.nodes.get(bk) ?? { b: 0, s: 0 };
      if (dir === 1) n.b++;
      else n.s++;
      this.nodes.set(bk, n);
      if (this.nodes.size > NODES_MAX) this.pruneNodes();
    }

    // ── signal lamp: evaluate on EVERY tick ──
    this.stepSignal(tsMs);

    this.dirty = true;
  }

  private rollCandle() {
    const dir: 1 | -1 = this.c >= this.o ? 1 : -1;
    const d = this.buy - this.sell;
    const total = this.buy + this.sell + this.flat;
    this.prev.push({ t: this.bucket, dir, d, dp: total ? d / total : 0, r: this.h - this.l, h: this.h, l: this.l });
    if (this.prev.length > 6) this.prev.shift();
  }

  private pruneNodes() {
    // drop the 40 smallest buckets.
    // entries() yields [key, value] PAIRS — index them, do NOT use .value
    // (the old .value access crashed the whole service — see mt5-service.log).
    const arr = [...this.nodes.entries()]
      .sort((a, b) => (a[1].b + a[1].s) - (b[1].b + b[1].s));
    for (let i = 0; i < 40 && i < arr.length; i++) this.nodes.delete(arr[i][0]);
  }

  /** true → caller should broadcast (throttled) */
  shouldEmit(nowMs: number): boolean {
    if (!this.dirty) return false;
    if (nowMs - this.lastEmit >= EMIT_MIN_MS) {
      this.lastEmit = nowMs;
      this.dirty = false;
      return true;
    }
    return false;
  }

  forceEmitReady() { this.lastEmit = 0; this.dirty = true; }

  /**
   * Seed the running candle with the REAL bar OHLC (used when subscribing
   * mid-candle: o/h/l/c come from the actual bar; delta still counts live ticks).
   */
  seedBar(t: number, o: number, h: number, l: number, c: number) {
    if (this.totalTicks === 0 || t === this.bucket) {
      this.bucket = t;
      this.o = o;
      this.h = Math.max(this.h, h);
      this.l = this.l === 0 ? l : Math.min(this.l, l);
      if (this.totalTicks === 0) this.c = c; // no live tick yet → last bar close
      this.dirty = true;
    }
  }

  // ═══════════════════════ the SIGNAL LAMP ═══════════════════════
  //
  // raw bias ∈ (−1, 1) — what the tape says RIGHT NOW:
  //   34% smoothed decisive delta   (buy−sell)/(buy+sell) — the core pressure gauge
  //   18% micro-momentum            last 15 ticks net direction
  //   14% close position            where price sits inside the candle range
  //   10% wick rejection            long lower wick = buyers defended
  //    8% tape speed × direction    urgency agrees with momentum
  //   10% trend context             previous candles' delta continuity
  //    6% node defence              price standing on a buy-node / under a sell-node
  //
  // state machine:  neutral ──(raw ≥ +0.52 for ≥1.2s, ≥25 decisive ticks,
  //                            4s after last exit)──▶ buy
  //   buy ──(raw ≤ +0.12 for ≥1.5s AND held ≥ minHold)──▶ neutral
  //   buy ──(candle closed against us AND raw < 0.30)───▶ neutral  (book the loss)
  //   buy ──(adverse move > 50% of candle range for 3s+)──▶ neutral (stop)
  // sell is the mirror. DIRECT buy↔sell flips are impossible — every flip
  // passes through neutral + cooldown, so the lamp NEVER whipsaws.
  private rawBias(): number {
    const decisive = this.buy + this.sell;
    const deltaAdj = decisive >= 4 ? (this.buy - this.sell) / decisive : 0;

    const tail = this.tape.slice(-RECENT_N);
    const recentDelta = tail.reduce((a, x) => a + x.d, 0);
    const recentPct = tail.length ? recentDelta / tail.length : 0;

    const range = this.h - this.l;
    const closePos = range > 1e-12 ? (this.c - this.l) / range : 0.5;
    const upperWick = this.h - Math.max(this.o, this.c);
    const lowerWick = Math.min(this.o, this.c) - this.l;
    const wick = range > 1e-12 ? (lowerWick - upperWick) / range : 0;

    const now = this.lastTickMs;
    const inWin = this.tickTimes.filter((t) => now - t <= 5000).length;
    const tps = Math.min(inWin / 5, 40);
    const elapsedMin = Math.max((now - this.openedMs) / 1000, 5) / 60;
    const tpsAvg = this.totalTicks / elapsedMin / 60;
    // speed floor 1.2: below ~1.2 tps "slower than usual" carries no signal —
    // the book is simply asleep. The old floor (0.6) let a dead tape read as
    // permanently "slowing", a constant conviction penalty against whichever
    // side tried to form (one of the three stacked WAIT causes at midnight).
    const speed = Math.max(-1, Math.min(1, (tps - tpsAvg) / Math.max(tpsAvg, 1.2)));
    const speedBias = speed * Math.sign(recentPct || 0);

    // trend context — agreement of the last 3 candle deltas
    const last3 = this.prev.slice(-3);
    const trendCtx = last3.length
      ? Math.max(-1, Math.min(1, last3.reduce((a, x) => a + x.dp, 0) / last3.length))
      : 0;

    // node defence — strongest battle level under/over price
    let nodeBias = 0;
    if (this.nodes.size && range > 1e-12) {
      let bestBelow: { k: number; v: { b: number; s: number } } | null = null;
      let bestAbove: { k: number; v: { b: number; s: number } } | null = null;
      const curK = Math.round(this.c / this.nodeQuantum);
      for (const [k, v] of this.nodes) {
        const tot = v.b + v.s;
        if (tot < 3) continue;
        if (k <= curK && (!bestBelow || tot > bestBelow.v.b + bestBelow.v.s)) bestBelow = { k, v };
        if (k > curK && (!bestAbove || tot > bestAbove.v.b + bestAbove.v.s)) bestAbove = { k, v };
      }
      if (bestBelow) nodeBias += 0.5 * ((bestBelow.v.b - bestBelow.v.s) / (bestBelow.v.b + bestBelow.v.s));
      if (bestAbove) nodeBias -= 0.5 * ((bestAbove.v.b - bestAbove.v.s) / (bestAbove.v.b + bestAbove.v.s));
      nodeBias = Math.max(-1, Math.min(1, nodeBias));
    }

    const sc =
      0.34 * this.deltaEma +
      0.18 * recentPct +
      0.14 * (closePos * 2 - 1) +
      0.10 * wick +
      0.08 * speedBias +
      0.10 * trendCtx +
      0.06 * nodeBias;
    return Math.tanh(1.6 * sc);
  }

  private stepSignal(tsMs: number) {
    const T = this.tune;
    const decisive = this.buy + this.sell;

    // EMA of the decisive delta (the core gauge) — update per tick.
    // TAPE-SPEED ADAPTIVE: alpha is re-scaled by the measured tick rate so the
    // gauge converges in constant WALL-CLOCK time (~ln(0.1)/ln(1−a)/tpsRef
    // seconds ≈ 10s at the reference tape). Without this, a 0.7 tps midnight
    // tape needed 36s to converge — conviction could never build inside the
    // candle and the lamp sat on WAIT forever even under real one-sided flow.
    // The clamp (alphaMax) keeps any single tick from jumping the gauge.
    if (decisive >= 4) {
      const deltaAdj = (this.buy - this.sell) / decisive;
      const tps = this.measuredTps();
      const scale = tps > 0.05 ? this.tune.alphaRefTps / tps : 1;
      const a = Math.min(
        Math.max(this.tune.deltaAlpha * Math.max(scale, 1), this.tune.deltaAlpha),
        this.tune.alphaMax,
      );
      this.deltaEma += a * (deltaAdj - this.deltaEma);
    }

    const raw = this.rawBias();
    const absRaw = Math.abs(raw);
    const minHold = minHoldMsFor(this.tfSec, T.minHoldM1);

    // persistence timers (time-based → tick-rate independent)
    if (absRaw >= T.entryRaw) {
      if (raw > 0) { this.bullAboveSince ||= tsMs; this.bearBelowSince = 0; }
      else { this.bearBelowSince ||= tsMs; this.bullAboveSince = 0; }
    } else {
      this.bullAboveSince = 0;
      this.bearBelowSince = 0;
    }

    if (this.sigState === "neutral") {
      const cooled = tsMs - this.sigLastExitMs >= T.cooldownMs;
      const ripe = decisive >= T.minDecisive;
      if (cooled && ripe) {
        // ══ THE FIVE PRO GATES (backtest-hardened) ══
        // The naive lamp chased the opening push of every candle and lost
        // (0% win). A tape-reader only fires on ESTABLISHED continuation:
        //
        // 1. AGE — the opening slice of a candle is auction noise, not flow.
        const elapsedMs = this.openedMs ? tsMs - this.openedMs : Infinity;
        const oldEnough = elapsedMs >= Math.max(T.ageMinMs, this.tfSec * 1000 * T.ageFrac);
        //
        // 2. ALIGNMENT — engage WITH the forming candle AND the PREVIOUS
        //    candle. A dip inside a bull candle can never trigger a SELL
        //    when the previous candle closed bullish — that was the leak.
        const range = this.h - this.l;
        const bullSide = !!this.bullAboveSince;
        const bodyAligned = range > 1e-12
          ? (bullSide ? this.c >= this.o : this.c <= this.o)
          : true;
        const lastPrev = this.prev.length ? this.prev[this.prev.length - 1] : null;
        const trendAligned = !T.trendGate || !lastPrev || (lastPrev.dir === (bullSide ? 1 : -1));
        //
        // 3. BREAKOUT / POSITION — the deepest lesson of the backtest: inside
        //    a bounded candle, buying the upper half ALWAYS mean-reverts to
        //    the close (measured 17-22% accuracy — systematically wrong).
        //    The scalper pattern from the user's videos is BREAKOUT: price
        //    LEAVING the last 5 candles' range with one-sided tape. So:
        //    buy only at/above the rolling 5-bar high, sell only at/below
        //    the rolling 5-bar low. Inside the range → no signal, ever.
        const closePos = range > 1e-12 ? (this.c - this.l) / range : 0.5;
        const last5 = this.prev.slice(-5);
        let posAligned: boolean;
        if (T.breakout && last5.length >= 2) {
          const rollHi = Math.max(...last5.map((x) => x.h));
          const rollLo = Math.min(...last5.map((x) => x.l));
          const pad = range * T.breakoutPad;
          posAligned = bullSide
            ? this.c >= rollHi - pad   // breaking UP through the ceiling
            : this.c <= rollLo + pad; // breaking DOWN through the floor
        } else {
          posAligned = bullSide ? closePos >= T.posBuy : closePos <= T.posSell;
        }
        //
        // 4. ONE-SIDED TAPE — the decisive delta itself must be extreme,
        //    not just the blended score.
        const deltaAdj = decisive >= 4 ? (this.buy - this.sell) / decisive : 0;
        const tapeExtreme = bullSide ? deltaAdj >= T.deltaExtreme : deltaAdj <= -T.deltaExtreme;
        //
        // 5. EXPANSION — the candle must be expanding vs the recent average
        //    (momentum bar). Chop candles are skipped entirely.
        const last3 = this.prev.slice(-3);
        const avgPrevRange = last3.length
          ? last3.reduce((a, x) => a + (x.r || range), 0) / last3.length
          : range;
        const expanding = range >= avgPrevRange * T.rangeExpand;

        if (oldEnough && bodyAligned && trendAligned && posAligned && tapeExtreme && expanding) {
          const bullReady = this.bullAboveSince && tsMs - this.bullAboveSince >= T.persistEnterMs;
          const bearReady = this.bearBelowSince && tsMs - this.bearBelowSince >= T.persistEnterMs;
          if (bullReady) this.engage("buy", tsMs);
          else if (bearReady) this.engage("sell", tsMs);
        }
      }
      // weak-timers keep ticking so a fast re-engage can't skip the band
      this.weakAboveSince = 0;
      this.weakBelowSince = 0;
      return;
    }

    // ── engaged: check for collapse (hysteresis) ──
    // v16.8 (user audit) DELTA-GATED EXIT: entry required a one-sided tape
    // (deltaExtreme); exit now respects it too — a momentary raw dip while
    // the decisive delta is still clearly on the trade's side must NOT kill
    // the lamp (the old exit fired on raw alone and cost the trader full
    // moves that immediately resumed). A FULL flip (raw past −entryRaw) or
    // a genuinely faded tape still disengages.
    const side = this.sigState;
    const deltaFavors = side === "buy"
      ? this.deltaEma >= T.deltaExtreme * 0.5
      : this.deltaEma <= -T.deltaExtreme * 0.5;
    if (side === "buy") {
      const hardFlip = raw <= -T.entryRaw;
      if (raw <= T.exitRaw && (hardFlip || !deltaFavors)) this.weakAboveSince ||= tsMs;
      else this.weakAboveSince = 0;
    } else {
      const hardFlip = raw >= T.entryRaw;
      if (raw >= -T.exitRaw && (hardFlip || !deltaFavors)) this.weakBelowSince ||= tsMs;
      else this.weakBelowSince = 0;
    }
    const weakSince = side === "buy" ? this.weakAboveSince : this.weakBelowSince;
    const collapsed = weakSince !== 0 && tsMs - weakSince >= T.persistExitMs;
    const heldLong = tsMs - this.sigSinceMs >= minHold;

    // stop: adverse move beyond 40% of the RECENT CANDLE ATR (v16.8 user
    // audit) — the old "half the running candle's range" unit had nothing
    // to do with entry distance: an entry near the candle's 75% level got
    // adverse-stopped by a move that was still INSIDE the candle's normal
    // range. ATR-like = mean range of the last 14 completed candles.
    const range = this.h - this.l;
    const lastN = this.prev.slice(-14);
    const atrLike = lastN.length
      ? lastN.reduce((s, x) => s + (x.r || range), 0) / lastN.length
      : range;
    let adverseStop = false;
    if (atrLike > 1e-12 && this.sigEntryPrice > 0) {
      const adverse = side === "buy" ? this.sigEntryPrice - this.c : this.c - this.sigEntryPrice;
      if (adverse > atrLike * 0.4 && tsMs - this.sigSinceMs >= 3000) adverseStop = true;
    }

    if ((collapsed && heldLong) || adverseStop) this.disengage(tsMs);
  }

  private engage(state: "buy" | "sell", tsMs: number) {
    this.sigState = state;
    this.sigSinceMs = tsMs;
    this.sigEntryPrice = this.c;
    this.sigFlips++;
    this.bullAboveSince = 0;
    this.bearBelowSince = 0;
    this.weakAboveSince = 0;
    this.weakBelowSince = 0;
  }

  private disengage(tsMs: number) {
    if (this.sigState === "neutral") return;
    const side = this.sigState;
    const pts = this.points(this.c - this.sigEntryPrice) * (side === "buy" ? 1 : -1);
    this.episodes.push({
      state: side, pts, holdMs: tsMs - this.sigSinceMs, at: tsMs, won: pts > 0,
    });
    if (this.episodes.length > SIG_MAX_EPISODES) this.episodes.shift();
    this.sigState = "neutral";
    this.sigSinceMs = tsMs;
    this.sigEntryPrice = 0;
    this.sigFlips++;
    this.sigLastExitMs = tsMs;
    this.weakAboveSince = 0;
    this.weakBelowSince = 0;
  }

  /** candle closed — if it closed hard against the lamp, book the outcome now */
  private onCandleRoll(tsMs: number) {
    if (this.sigState === "neutral") return;
    const side = this.sigState;
    const candleAgainst = side === "buy" ? this.c < this.o : this.c > this.o;
    if (candleAgainst && this.deltaEma * (side === "buy" ? 1 : -1) < 0.30) {
      this.disengage(tsMs);
    }
  }

  private points(priceDelta: number): number {
    return priceDelta * Math.pow(10, this.digits);
  }

  /** rolling tape speed (ticks/sec over the last ~5s window) */
  private measuredTps(): number {
    const now = this.lastTickMs;
    let n = 0;
    for (let i = this.tickTimes.length - 1; i >= 0; i--) {
      if (now - this.tickTimes[i] <= 5000) n++;
      else break;
    }
    return Math.min(n / 5, 40);
  }

  private signalPayload(nowMs: number): FlowSignal {
    const raw = this.rawBias();
    const fired = this.episodes.length;
    const won = this.episodes.filter((e) => e.won).length;
    const avgPts = fired ? this.episodes.reduce((a, e) => a + e.pts, 0) / fired : 0;
    const avgHoldMs = fired ? this.episodes.reduce((a, e) => a + e.holdMs, 0) / fired : 0;
    const pnlPts = this.sigState !== "neutral" && this.sigEntryPrice > 0
      ? this.points(this.c - this.sigEntryPrice) * (this.sigState === "buy" ? 1 : -1)
      : 0;
    // strength: how far raw sits beyond the exit band, scaled to the entry threshold
    const strength = this.sigState === "neutral"
      ? Math.min(1, abs01(raw) / this.tune.entryRaw)
      : Math.min(1, Math.max(0, (abs01(raw) - this.tune.exitRaw) / (this.tune.entryRaw - this.tune.exitRaw)));
    return {
      state: this.sigState,
      sinceMs: this.sigState !== "neutral" ? this.sigSinceMs : this.sigSinceMs,
      entryPrice: this.sigEntryPrice,
      strength: Math.round(strength * 1000) / 1000,
      raw: Math.round(raw * 1000) / 1000,
      pnlPts: Math.round(pnlPts * 10) / 10,
      flips: this.sigFlips,
      // honest tape-state: below quietTps the book is asleep (Dhaka midnight
      // XAU) — the UI tells the user WHY the lamp waits instead of looking stuck
      quiet: this.measuredTps() < this.tune.quietTps,
      stats: {
        fired, won,
        winPct: fired ? Math.round((won / fired) * 1000) / 10 : 0,
        avgPts: Math.round(avgPts * 10) / 10,
        avgHoldMs: Math.round(avgHoldMs),
      },
      recent: this.episodes.slice(-8),
    };
  }

  private score(): FlowScore {
    const total = this.buy + this.sell + this.flat;
    const decisive = this.buy + this.sell;
    // DECISIVE delta ratio — flats are quote refreshes, not aggression.
    // (dividing by total-with-flats kept the verdict pinned at "balanced")
    const deltaPct = decisive >= 4 ? (this.buy - this.sell) / decisive : this.deltaEma;
    const range = this.h - this.l;
    const body = this.c - this.o;
    const upperWick = this.h - Math.max(this.o, this.c);
    const lowerWick = Math.min(this.o, this.c) - this.l;
    const closePos = range > 1e-12 ? (this.c - this.l) / range : 0.5;

    const tail = this.tape.slice(-RECENT_N);
    const recentDelta = tail.reduce((a, x) => a + x.d, 0);
    const recentPct = tail.length ? recentDelta / tail.length : 0;

    const now = this.lastTickMs;
    const inWin = this.tickTimes.filter((t) => now - t <= 5000).length;
    const tps = Math.min(inWin / 5, 40);
    const elapsedMin = Math.max((now - this.openedMs) / 1000, 5) / 60;
    const tpsAvg = this.totalTicks / elapsedMin / 60;
    const speed = Math.max(-1, Math.min(1, (tps - tpsAvg) / Math.max(tpsAvg, 0.6)));

    const wick = range > 1e-12 ? (lowerWick - upperWick) / range : 0;

    const delta = this.buy - this.sell;
    const confirm = (body >= 0 && delta >= 0) || (body < 0 && delta <= 0);

    let sc =
      0.40 * deltaPct +
      0.20 * recentPct +
      0.15 * (closePos * 2 - 1) +
      0.15 * wick +
      0.10 * speed;
    if (!confirm) sc *= 0.72; // price/delta disagreement → weak conviction

    const bullProb = 1 / (1 + Math.exp(-2.6 * sc));

    let verdict: FlowScore["verdict"];
    if (body >= 0 && delta < 0 && totalTicksEnough(total)) verdict = "absorb_top";
    else if (body < 0 && delta > 0 && totalTicksEnough(total)) verdict = "absorb_bottom";
    else if (deltaPct > 0.15 && bullProb > 0.58) verdict = "buyers";
    else if (deltaPct < -0.15 && bullProb < 0.42) verdict = "sellers";
    else verdict = "balanced";

    return {
      bullProb,
      verdict,
      drivers: { confirm, speed, wick, closePos, recentPct },
    };
  }

  /** rebuild the cross-candle delta path from persisted raw ticks, so a fresh
   *  tracker (restart / hot-reload / new subscriber) shows a FULL 2-candle
   *  delta view instantly instead of filling in over the next hours.
   *  Only candles STRICTLY BEFORE the live running bucket are seeded — the
   *  running candle's delta legitimately counts from subscribe time. */
  seedDeep(ticks: { t: number; p: number }[]) {
    if (this.histDeep.length || !ticks.length) return;
    const tfMs = this.tfSec * 1000;
    // seed just enough to fill a broadcast slice (~2.3 candles) + margin
    const horizon = Date.now() - (DEEP_SEND + 80) * this.histStepMs - tfMs;
    let prevP: number | null = null;
    let buy = 0, sell = 0;
    let bucket = -1;
    let lastSample = -Infinity;
    let lastD = 0;
    const out: { t: number; d: number }[] = [];
    for (const tk of ticks) {
      if (tk.t < horizon) { prevP = tk.p; continue; }
      const b = Math.floor(tk.t / tfMs) * tfMs;
      if (b !== bucket) {
        if (out.length) out.push({ t: b, d: lastD }, { t: b, d: 0 });
        bucket = b; buy = 0; sell = 0; lastSample = -Infinity;
        prevP = null; // tick rule resets each candle
      }
      if (prevP !== null && tk.p !== prevP) {
        if (tk.p > prevP) buy++; else sell++;
      }
      prevP = tk.p;
      lastD = buy - sell;
      if (tk.t - lastSample >= this.histStepMs) {
        out.push({ t: tk.t, d: lastD });
        lastSample = tk.t;
      }
    }
    // bucket=0 → no live tick yet: trim at the wall-clock bucket instead
    const liveBucketMs = (this.bucket > 0 ? this.bucket * 1000 : Math.floor(Date.now() / tfMs) * tfMs);
    this.histDeep = out.filter((x) => x.t < liveBucketMs).slice(-DEEP_MAX);
    // close the last seeded candle at the live boundary with its final delta,
    // then the restart-at-0 — the vertical reset the chart draws at every open
    if (this.histDeep.length && lastD !== 0) {
      this.histDeep.push({ t: liveBucketMs, d: lastD }, { t: liveBucketMs, d: 0 });
      if (this.histDeep.length > DEEP_MAX) this.histDeep.shift();
    }
    // rebuild prevFinals from the seeded reset pairs (final → 0 boundaries)
    this.prevFinals = [];
    for (let i = 1; i < this.histDeep.length; i++) {
      if (this.histDeep[i].d === 0 && this.histDeep[i - 1].d !== 0) {
        this.prevFinals.push(this.histDeep[i - 1].d);
      }
    }
    this.prevFinals = this.prevFinals.slice(-8);
  }

  /** 3-CHART CONFLUENCE READ (the delta-micro view the user reads):
   *  the live candle's cumulative delta + the last completed candles' final
   *  deltas + how many consecutive candles agree in sign. A real continuation
   *  shows TWO+ same-sign candles; a single half-candle of delta is a trap. */
  deepRead(): { curDelta: number; prevDelta: number; agreeStreak: number } {
    const curDelta = this.buy - this.sell;
    const f = this.prevFinals;
    const prevDelta = f.length ? f[f.length - 1] : 0;
    let agreeStreak = 0;
    if (f.length >= 2) {
      const sign = Math.sign(f[f.length - 1]);
      if (sign !== 0) {
        for (let i = f.length - 1; i >= 0; i--) {
          if (Math.sign(f[i]) === sign) agreeStreak++;
          else break;
        }
      }
    }
    return { curDelta, prevDelta, agreeStreak };
  }

  payload(nowMs: number, forceDeep = false): FlowPayload {
    const total = this.buy + this.sell + this.flat;
    const delta = this.buy - this.sell;
    const tail = this.tape.slice(-RECENT_N);
    const recentDelta = tail.reduce((a, x) => a + x.d, 0);
    const now = this.lastTickMs;
    const inWin = this.tickTimes.filter((t) => now - t <= 5000).length;
    const tps = Math.min(inWin / 5, 40);
    const elapsedMin = Math.max((now - this.openedMs) / 1000, 5) / 60;
    const tpsAvg = this.totalTicks / elapsedMin / 60;

    // top 8 battle levels (most-ticked price buckets)
    const nodes = [...this.nodes.entries()]
      .map(([k, v]) => ({ p: k * this.nodeQuantum, b: v.b, s: v.s }))
      .sort((a, b) => b.b + b.s - (a.b + a.s))
      .slice(0, 8);

    return {
      s: this.symbol, tf: this.tf,
      t: this.bucket, now: nowMs,
      o: this.o, h: this.h, l: this.l, c: this.c,
      buy: this.buy, sell: this.sell, flat: this.flat,
      delta, deltaPct: total ? delta / total : 0, recentDelta,
      tps, tpsAvg,
      lastTickMs: this.lastTickMs,
      tape: this.tape.slice(),
      deltaHist: this.deltaHist.slice(),
      ...(forceDeep || nowMs - this.lastDeepSentMs >= DEEP_SEND_MS
        ? ((this.lastDeepSentMs = nowMs), { histDeep: this.histDeep.slice(-DEEP_SEND) })
        : {}),
      nodes,
      prev: this.prev.slice(),
      score: this.score(),
      sig: this.signalPayload(nowMs),
    };
  }
}

function totalTicksEnough(total: number) {
  return total >= 12; // avoid verdicts on dead tape
}

function abs01(x: number) {
  return Math.min(1, Math.abs(x));
}

// ═══════════════════════ tick recorder ═══════════════════════
// Persists the raw tick stream (per symbol) so the signal engine can be
// backtested on REAL ticks later — no synthesis, no approximation.
export class TickRecorder {
  private buf: { t: number; p: number }[];
  private lastFlush = 0;
  constructor(
    public readonly symbol: string,
    private maxTicks: number,
    private flush: (symbol: string, ticks: { t: number; p: number }[]) => void,
    seed: { t: number; p: number }[] = [],
  ) {
    this.buf = seed.slice(-maxTicks);
  }

  tick(t: number, p: number) {
    this.buf.push({ t, p });
    if (this.buf.length > this.maxTicks) this.buf.shift();
  }
  maybeFlush(nowMs: number, intervalMs = 90_000) {
    if (nowMs - this.lastFlush < intervalMs) return;
    if (!this.buf.length) return;
    this.lastFlush = nowMs;
    this.flush(this.symbol, this.buf.slice());
  }
  /** newest-last raw ticks (used to seed a fresh tracker's deep delta path). */
  recent(max: number): { t: number; p: number }[] {
    return this.buf.slice(-max);
  }
}
