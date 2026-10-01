"use client";

/**
 * AURUM Terminal — live XAUUSD/forex analysis straight from MetaTrader 5.
 *
 * Data path:  Exness-MT5Trial6 ─(direct WS protocol)→ mt5-service :3030/:3031
 *             → this Next.js app (chart + signal engine + roadmap)
 *             → your browser (socket.io live ticks + REST candles).
 */

import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import TerminalShell from "@/components/terminal/TerminalShell";
import { useTerminal } from "@/hooks/useTerminal";
import { useBars } from "@/hooks/useFeed";
import type { AnalysisResponse, UserDrawing } from "@/lib/market/types";

async function fetchAnalysis(symbol: string, tf: string): Promise<AnalysisResponse> {
  const res = await fetch(`/api/analysis?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
  if (!res.ok) throw new Error(`analysis ${res.status}`);
  return res.json();
}

async function fetchDrawings(symbol: string, tf: string): Promise<UserDrawing[]> {
  const res = await fetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.drawings ?? [];
}

export default function Home() {
  const { symbol, timeframe } = useTerminal();
  const qc = useQueryClient();

  // live analysis (engine + roadmap + auto-drawings + signal history)
  const analysisQ = useQuery({
    queryKey: ["analysis", symbol, timeframe],
    queryFn: () => fetchAnalysis(symbol, timeframe),
    refetchInterval: 15_000,
    retry: 2,
    staleTime: 6_000,
  });

  // ── real-time per-timeframe analysis: every time a bar of the ACTIVE
  // symbol+tf closes (a new bar opens), refetch the engine immediately so
  // signals/roadmap/drawings follow the market, not the 15s poll.
  const bars = useBars(symbol, timeframe);
  const lastBarTRef = useRef<number>(0);
  const lastFetchRef = useRef<number>(0);
  useEffect(() => {
    const lastT = bars.length ? bars[bars.length - 1].t : 0;
    if (!lastT || lastT === lastBarTRef.current) return;
    const isNewBar = lastBarTRef.current !== 0 && lastT > lastBarTRef.current;
    lastBarTRef.current = lastT;
    if (!isNewBar) return;
    // throttle: at most one engine refetch per 5s (M1 closes)
    if (Date.now() - lastFetchRef.current < 5_000) return;
    lastFetchRef.current = Date.now();
    void qc.invalidateQueries({ queryKey: ["analysis", symbol, timeframe] });
  }, [bars, qc, symbol, timeframe]);

  // user drawings for this symbol|tf
  const drawingsQ = useQuery({
    queryKey: ["drawings", symbol, timeframe],
    queryFn: () => fetchDrawings(symbol, timeframe),
  });
  const userDrawings = drawingsQ.data ?? [];

  const onCreateDrawing = useCallback(
    async (d: Omit<UserDrawing, "id" | "createdAt">) => {
      try {
        const res = await fetch("/api/drawings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        qc.setQueryData<UserDrawing[]>(
          ["drawings", d.symbol, d.timeframe],
          (old) => [...(old ?? []), data.drawing],
        );
      } catch {
        toast({ title: "Could not save drawing", variant: "destructive" });
      }
    },
    [qc],
  );

  const onUpdateDrawing = useCallback(
    async (id: string, points: UserDrawing["points"], style: UserDrawing["style"]) => {
      // optimistic: chart already moved the points locally
      qc.setQueryData<UserDrawing[]>(["drawings", symbol, timeframe], (old) =>
        (old ?? []).map((d) => (d.id === id ? { ...d, points, style } : d)),
      );
      try {
        await fetch("/api/drawings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, points, style }),
        });
      } catch {
        toast({ title: "Could not update drawing", variant: "destructive" });
      }
    },
    [qc, symbol, timeframe],
  );

  const onDeleteDrawing = useCallback(
    async (id: string) => {
      qc.setQueryData<UserDrawing[]>(["drawings", symbol, timeframe], (old) =>
        (old ?? []).filter((d) => d.id !== id),
      );
      try {
        await fetch(`/api/drawings?id=${id}`, { method: "DELETE" });
      } catch {
        toast({ title: "Could not delete drawing", variant: "destructive" });
      }
    },
    [qc, symbol, timeframe],
  );

  const onClearDrawings = useCallback(async () => {
    qc.setQueryData<UserDrawing[]>(["drawings", symbol, timeframe], []);
    try {
      await fetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}&tf=${timeframe}`, {
        method: "DELETE",
      });
      toast({ title: "Drawings cleared" });
    } catch {
      toast({ title: "Could not clear drawings", variant: "destructive" });
    }
  }, [qc, symbol, timeframe]);

  return (
    <TerminalShell
      analysis={analysisQ.data ?? null}
      userDrawings={userDrawings}
      onCreateDrawing={onCreateDrawing}
      onUpdateDrawing={onUpdateDrawing}
      onDeleteDrawing={onDeleteDrawing}
      onClearDrawings={onClearDrawings}
    />
  );
}
