/**
 * Backtest runner (dev verification tool — NOT test code).
 * Runs the walk-forward engine over REAL MT5 history and prints
 * W/L / totalR / avg-RR per symbol×timeframe so engine changes can be
 * measured quantitatively (before/after).
 *
 * Usage:  bun run scripts/backtest-run.ts [symbol tf]...
 *         (defaults: XAUUSDm M1/M5/M15 + GBPJPYm M15 + BTCUSDm M5)
 */

import { seedSignals } from "../src/lib/market/seed";

const MT5 = "http://127.0.0.1:3031";

const MARKETS: [string, string][] = [
  ["XAUUSDm", "M1"],
  ["XAUUSDm", "M5"],
  ["XAUUSDm", "M15"],
  ["GBPJPYm", "M15"],
  ["BTCUSDm", "M5"],
];

async function getCandles(symbol: string, tf: string, limit: number) {
  const r = await fetch(`${MT5}/api/candles?symbol=${symbol}&tf=${tf}&limit=${limit}`);
  if (!r.ok) throw new Error(`${symbol} ${tf}: ${r.status}`);
  const d = await r.json();
  return (d.bars ?? []) as any[];
}

async function getMeta(symbol: string) {
  const r = await fetch(`${MT5}/api/symbols`);
  const d = await r.json();
  const s = (d.list ?? []).find((x: any) => x.name === symbol);
  return { digits: s?.digits ?? 2, spread: s?.spread ?? 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const jobs: [string, string][] = [];
  for (let i = 0; i < args.length; i += 2) jobs.push([args[i], args[i + 1] ?? "M15"]);
  const list = args.length ? jobs : MARKETS;

  console.log(
    "symbol        tf   bars  sigs  win%   W/L/Exp  totalR  avgR   avgRR  byTrigger",
  );
  for (const [symbol, tf] of list) {
    try {
      const [bars, meta] = await Promise.all([
        getCandles(symbol, tf, 900),
        getMeta(symbol),
      ]);
      const { signals } = seedSignals({
        symbol,
        tf,
        digits: meta.digits,
        spread: meta.spread,
        bars,
      });
      const won = signals.filter((s) => s.status === "won").length;
      const lost = signals.filter((s) => s.status === "lost").length;
      const exp = signals.filter((s) => s.status === "expired").length;
      const totalR = signals.reduce((a, s) => a + (s.resultR ?? 0), 0);
      const decided = won + lost;
      const winPct = decided ? (won / decided) * 100 : 0;
      const avgR = signals.length ? totalR / signals.length : 0;
      const avgRR = signals.length ? signals.reduce((a, s) => a + s.rr, 0) / signals.length : 0;
      const byTrig: Record<string, number> = {};
      for (const s of signals) byTrig[s.trigger] = (byTrig[s.trigger] ?? 0) + 1;
      console.log(
        `${symbol.padEnd(13)} ${tf.padEnd(4)} ${String(bars.length).padStart(5)} ${String(signals.length).padStart(5)} ${winPct.toFixed(0).padStart(4)}%  ${won}/${lost}/${exp}   ${totalR >= 0 ? "+" : ""}${totalR.toFixed(1).padStart(5)}  ${avgR.toFixed(2).padStart(5)}  ${avgRR.toFixed(2).padStart(5)}  ${JSON.stringify(byTrig)}`,
      );
    } catch (e) {
      console.log(`${symbol} ${tf} FAILED: ${(e as Error).message}`);
    }
  }
}

main();
