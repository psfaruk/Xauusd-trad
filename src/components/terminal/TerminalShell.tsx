"use client";

/**
 * TerminalShell — ONE layout, ONE tab model on every device (Binance style):
 *
 *   ┌ TopBar: brand · symbol · live quote · connection · theme · language ┐
 *   ├ DesktopTabStrip: Home · Chart · Auto Signals · Settings            │
 *   ├ content (fills, scrolls)                                           │
 *   └ mobile: bottom tab bar / desktop: StatusBar diagnostics footer
 *
 * The old 6-tab bottom nav + 6-tab desktop dock are folded into the 4 tabs:
 *   Home ← market + roadmap + status · Chart ← flow + analysis
 *   Auto Signals ← auto + signals + backtest · Settings ← theme/lang/data
 */

import { useEffect, useState } from "react";
import type { AnalysisResponse, BoardSessionPayload, UserDrawing } from "@/lib/market/types";
import { useFeedBoot } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { TopBar, BrandMark } from "./TopBar";
import { DesktopTabStrip, MobileNav } from "./MobileNav";
import { HomePanel } from "./HomePanel";
import { ChartWorkspace } from "./ChartWorkspace";
import { AutoSignalsView } from "./AutoSignalsView";
import { SettingsPanel } from "./SettingsPanel";
import { StatusBar } from "./StatusBar";
import { LoginGate } from "./LoginGate";

interface Props {
  analysis: AnalysisResponse | null;
  /** v21 — the AI Board's latest decision (hero chart ink + Board panel) */
  board: BoardSessionPayload | null;
  /** v16.4 (audit §13): true when the /api/analysis fetch is failing — the
   *  UI must show a DATA outage banner, not a silent "no signal" state. */
  analysisError?: boolean;
  userDrawings: UserDrawing[];
  onCreateDrawing: (d: Omit<UserDrawing, "id" | "createdAt">) => void;
  onUpdateDrawing: (id: string, points: UserDrawing["points"], style: UserDrawing["style"]) => void;
  onDeleteDrawing: (id: string) => void;
  onClearDrawings: () => void;
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

export default function TerminalShell({
  analysis,
  board,
  analysisError = false,
  userDrawings,
  onCreateDrawing,
  onUpdateDrawing,
  onDeleteDrawing,
  onClearDrawings,
}: Props) {
  useFeedBoot();
  const isDesktop = useIsDesktop();
  const { t } = useI18n();

  if (isDesktop === null) {
    // first paint placeholder (avoids hydration mismatch)
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background">
        <BrandMark className="animate-pulse text-muted-foreground" />
      </div>
    );
  }

  const chartProps = {
    analysis,
    board,
    userDrawings,
    onCreateDrawing,
    onUpdateDrawing,
    onDeleteDrawing,
    onClearDrawings,
    mobile: !isDesktop,
  };

  return (
    <>
      {/* auth overlay — covers (never unmounts) the shell when the deployment is locked */}
      <LoginGate />
      <div className={isDesktop ? "flex h-screen flex-col overflow-hidden bg-background" : "flex h-[100dvh] flex-col overflow-hidden bg-background"}>
        <TopBar />
        {isDesktop && <DesktopTabStrip />}
        {/* v16.4 (audit §13): a hard data outage is NOT "no signal" — this
            banner makes the difference visible on every tab. */}
        {analysisError && (
          <div role="alert" className="flex items-center gap-2 border-b border-down/40 bg-down/10 px-3 py-1.5 text-[11px] text-down">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-down" aria-hidden />
            <span className="font-bold uppercase tracking-wider">{t("dataUnavailable")}</span>
            <span className="truncate text-down/80">{t("dataUnavailableHint")}</span>
          </div>
        )}
        <main className="min-h-0 flex-1">
          {/* the tab body — each tab owns its full height */}
          <TabBody {...chartProps} />
        </main>
        {isDesktop ? <StatusBar /> : <MobileNav />}
      </div>
    </>
  );
}

function TabBody(props: Props & { mobile: boolean }) {
  const { mainTab } = useTerminal();
  switch (mainTab) {
    case "home":
      return <HomePanel analysis={props.analysis} />;
    case "chart":
      return <ChartWorkspace {...props} />;
    case "auto":
      return <AutoSignalsView analysis={props.analysis} board={props.board} />;
    case "settings":
      return <SettingsPanel />;
  }
}
