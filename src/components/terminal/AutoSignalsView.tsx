"use client";

/** AutoSignalsView — the AUTO SIGNALS tab: everything the AI trading stack
 *  does, folded into one clean segmented folder.
 *
 *    Brain    — the cockpit (arm switch, risk, per-pair rules, live
 *               positions, journal, AI verdicts, feelings)  [AutoTradePanel]
 *    Signals  — the live signal engine list for the active chart [SignalsPanel]
 *    Backtest — walk-forward verification of the engine [BacktestPanel]
 */

import type { AnalysisResponse } from "@/lib/market/types";
import { useTerminal, type AutoView } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AutoTradePanel } from "./AutoTradePanel";
import { SignalsPanel } from "./SignalsPanel";
import { BacktestPanel } from "./BacktestPanel";
import { BrainCircuit, Zap, FlaskConical } from "lucide-react";

const VIEWS: { id: AutoView; icon: any; key: string }[] = [
  { id: "brain", icon: BrainCircuit, key: "viewBrain" },
  { id: "signals", icon: Zap, key: "viewSignals" },
  { id: "backtest", icon: FlaskConical, key: "viewBacktest" },
];

export function AutoSignalsView({ analysis }: { analysis: AnalysisResponse | null }) {
  const { autoView, setAutoView } = useTerminal();
  const { t } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* segmented folder header */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-card/60 px-3">
        {VIEWS.map(({ id, icon: Icon, key }) => {
          const active = autoView === id;
          return (
            <button
              key={id}
              onClick={() => setAutoView(id)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(key)}
            </button>
          );
        })}
      </div>

      {/* folder body */}
      <div className="min-h-0 flex-1">
        {autoView === "brain" && <AutoTradePanel />}
        {autoView === "signals" && <SignalsPanel analysis={analysis} />}
        {autoView === "backtest" && <BacktestPanel analysis={analysis} />}
      </div>
    </div>
  );
}
