/**
 * Candle-engine verification (dev tool — NOT test code).
 *
 * v19.0: runs the candlestick strategy engine over REAL MT5 history and
 * prints, per timeframe:
 *   · the live read — which setups the chart would box right now
 *   · the walk-forward backtest — overall + per-pattern + per-candle-count
 *     W/L / win% / avgR (fill at trigger close, stop-first resolution,
 *     24-bar horizon) so the detection thresholds can be judged on the
 *     symbol's own tape, not on theory.
 *
 * Usage:  bun run scripts/verify-candles.ts [symbol tf]...
 *         (defaults: XAUUSDm M5/M15/H1)
 */

import { detectCandlePatterns, backtestCandles, CANDLE_CATALOG_SIZE } from "../src/lib/market/candlesticks";

const MT5 = "http://127.0.0.1:3031";

const JOBS: [string, string][] = [
  ["XAUUSDm", "M5"],
  ["XAUUSDm", "M15"],
  ["XAUUSDm", "H1"],
];

async function getCandles(symbol: string, tf: string, limit: number) {
  const r = await fetch(`${MT5}/api/candles?symbol=${symbol}&tf=${tf}&limit=${limit}`);
  if (!r.ok) throw new Error(`${symbol} ${tf}: HTTP ${r.status}`);
  const d = await r.json();
  return (d.bars ?? []) as any[];
}

function fmt(v: number, dp = 2) {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

async function main() {
  const args = process.argv.slice(2);
  const jobs: [string, string][] = [];
  for (let i = 0; i < args.length; i += 2) jobs.push([args[i], args[i + 1] ?? "M15"]);
  if (!jobs.length) jobs.push(...JOBS);

  console.log(`\n🕯 candle-engine verification — ${CANDLE_CATALOG_SIZE} setups · 1–5 candles\n`);
  for (const [symbol, tf] of jobs) {
    const bars = await getCandles(symbol, tf, 900);
    const closed = bars.filter((b: any) => !b.f);
    if (closed.length < 120) {
      console.log(`${symbol} ${tf}: only ${closed.length} closed bars — skipped\n`);
      continue;
    }

    // ── the live read (what the chart would box right now) ──
    const read = detectCandlePatterns(closed, tf);
    console.log(`══ ${symbol} ${tf} — ${closed.length} closed bars ══`);
    console.log(`  live setups (${read.patterns.length}):`);
    for (const p of read.patterns) {
      const lvl = p.context.atLevel ? ` @${p.context.atLevel} ${p.context.levelPrice?.toFixed(2)}` : "";
      console.log(
        `    ${new Date(p.t1 * 1000).toISOString().slice(5, 16)}  ${p.code.padEnd(10)} ${p.side === "bull" ? "▲" : "▼"} ${p.n}c  conf ${String(p.confidence).padStart(2)}%  [${p.status}]${lvl}  E ${fmt(p.entry)} SL ${fmt(p.sl)} TP ${fmt(p.tp)} (${p.rr}R)`,
      );
      for (const l of p.logicBn.slice(0, 2)) console.log(`        · ${l}`);
    }

    // ── the walk-forward backtest ──
    const bt = backtestCandles(closed);
    const o = bt.overall;
    console.log(
      `  backtest: fired ${o.fired} · won ${o.won} · lost ${o.lost} · expired ${o.expired} · win% ${o.winPct} · avgR ${o.avgR} · totalR ${o.totalR} · open ${bt.open}`,
    );
    console.log(`  by candle count:`);
    for (const n of bt.byN) {
      console.log(`    ${n.n}-candle: fired ${String(n.fired).padStart(3)}  win% ${String(n.winPct).padStart(3)}  avgR ${n.avgR}`);
    }
    console.log(`  by pattern:`);
    for (const c of bt.byCode) {
      console.log(
        `    ${c.code.padEnd(11)} ${c.side === "bull" ? "▲" : "▼"} ${c.n}c  fired ${String(c.fired).padStart(3)}  W ${String(c.won).padStart(3)} L ${String(c.lost).padStart(3)}  win% ${String(c.winPct).padStart(3)}  avgR ${String(c.avgR).padStart(6)}  totalR ${String(c.totalR).padStart(7)}`,
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("verify-candles failed:", e);
  process.exit(1);
});
