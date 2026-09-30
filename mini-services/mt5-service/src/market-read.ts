/**
 * market-read.ts — the brain's EYES. One call builds the full structural read
 * of a symbol: ATR, S/R (fractal clusters), trend (LR slope), tick value area
 * (POC/VAH/VAL), and live flow bias. Extracted from /api/ai-chart so the AI
 * judge (the real LLM inside the brain) sees EXACTLY what the chart shows.
 */
import type { Mt5Manager } from "./manager";

export interface MarketRead {
  symbol: string;
  tf: string;
  digits: number;
  price: number;
  atr: number;
  supports: { price: number; touches: number; ageMin: number }[];
  resistances: { price: number; touches: number; ageMin: number }[];
  trend: { dir: "up" | "down" | "flat"; slopeAtr: number };
  valueArea: { poc: number; vah: number; val: number; ticks: number } | null;
  bias: { state: string; strength: number; deltaPct: number } | null;
  candles: { t: number; o: number; h: number; l: number; c: number }[];
}

export function buildMarketRead(
  manager: Mt5Manager,
  symbol: string,
  tf = "M15",
  candleLimit = 260,
): Promise<MarketRead | null> {
  return manager.getCandles(symbol, tf, candleLimit).then((bars) => {
    if (!bars.length) return null;
    const q = manager.getQuote(symbol);
    const price = q?.mid ?? bars[bars.length - 1]?.c ?? 0;
    const digits = manager.digits(symbol);

    // ATR(14) on this tf — the yardstick for everything below
    let atr = 0;
    if (bars.length > 15) {
      const trs: number[] = [];
      for (let i = 1; i < bars.length; i++) {
        const b = bars[i], p = bars[i - 1];
        trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
      }
      atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
    }

    // ── S/R: fractal swings (k=2) clustered within 0.35 ATR ──
    const levels: { price: number; kind: "support" | "resistance"; touches: number; ageMin: number }[] = [];
    if (atr > 0 && bars.length > 8) {
      const k = 2;
      const tol = atr * 0.35;
      const swings: { price: number; t: number }[] = [];
      for (let i = k; i < bars.length - k; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= k; j++) {
          if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
          if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
        }
        if (isHigh) swings.push({ price: bars[i].h, t: bars[i].t });
        if (isLow) swings.push({ price: bars[i].l, t: bars[i].t });
      }
      const sorted = [...swings].sort((a, b) => a.price - b.price);
      const clusters: { price: number; touches: number; lastT: number }[] = [];
      for (const s of sorted) {
        const last = clusters[clusters.length - 1];
        if (last && Math.abs(s.price - last.price) <= tol) {
          last.price = (last.price * last.touches + s.price) / (last.touches + 1);
          last.touches++;
          last.lastT = Math.max(last.lastT, s.t);
        } else clusters.push({ price: s.price, touches: 1, lastT: s.t });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      for (const c of clusters) {
        levels.push({
          price: Number(c.price.toFixed(digits + 1)),
          kind: c.price >= price ? "resistance" : "support",
          touches: c.touches,
          ageMin: Math.max(1, Math.round((nowSec - c.lastT) / 60)),
        });
      }
    }
    const resistances = levels.filter((l) => l.kind === "resistance").sort((a, b) => a.price - b.price).slice(0, 3);
    const supports = levels.filter((l) => l.kind === "support").sort((a, b) => b.price - a.price).slice(0, 3);

    // ── trend: linear-regression slope of last 60 closes (per-bar, in ATR) ──
    let trend: { dir: "up" | "down" | "flat"; slopeAtr: number } = { dir: "flat", slopeAtr: 0 };
    if (bars.length > 20 && atr > 0) {
      const closes = bars.slice(-60).map((b) => b.c);
      const n = closes.length;
      const meanX = (n - 1) / 2, meanY = closes.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        num += (i - meanX) * (closes[i] - meanY);
        den += (i - meanX) ** 2;
      }
      const slope = den ? num / den : 0;
      const slopeAtr = slope / atr;
      trend = { dir: slopeAtr > 0.08 ? "up" : slopeAtr < -0.08 ? "down" : "flat", slopeAtr: Number(slopeAtr.toFixed(3)) };
    }

    // ── tick value area (last 5 min of real tape) — POC / VAH / VAL ──
    let valueArea: { poc: number; vah: number; val: number; ticks: number } | null = null;
    const ticks = manager.getTicks(symbol, 300);
    if (ticks.length >= 30 && atr > 0) {
      const bucket = Math.max(atr / 12, 1e-9);
      const hist = new Map<number, number>();
      for (const t of ticks) {
        const b = Math.floor(t.p / bucket);
        hist.set(b, (hist.get(b) ?? 0) + 1);
      }
      let pocB = 0, pocN = -1;
      for (const [b, n] of hist) if (n > pocN) { pocN = n; pocB = b; }
      const total = ticks.length;
      let covered = hist.get(pocB) ?? 0;
      let lo = pocB, hi = pocB;
      while (covered < total * 0.7 && (hist.has(lo - 1) || hist.has(hi + 1))) {
        const dn = hist.get(lo - 1) ?? 0, up = hist.get(hi + 1) ?? 0;
        if (dn >= up) { lo--; covered += dn; } else { hi++; covered += up; }
      }
      valueArea = {
        poc: Number(((pocB + 0.5) * bucket).toFixed(digits + 1)),
        vah: Number(((hi + 1) * bucket).toFixed(digits + 1)),
        val: Number((lo * bucket).toFixed(digits + 1)),
        ticks: total,
      };
    }

    // ── live flow bias (if a tracker exists for M1) ──
    let bias: { state: string; strength: number; deltaPct: number } | null = null;
    try {
      const fp = manager.getFlowSnapshot(symbol, "M1");
      if (fp) bias = {
        state: fp.sig.state,
        strength: Number(fp.sig.strength.toFixed(2)),
        deltaPct: Number((fp.deltaPct ?? 0).toFixed(2)),
      };
    } catch { /* no tracker yet */ }

    return {
      symbol, tf, digits, price, atr: Number(atr.toFixed(digits + 1)),
      supports, resistances, trend, valueArea, bias,
      candles: bars.slice(-40).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c })),
    };
  }).catch(() => null);
}
