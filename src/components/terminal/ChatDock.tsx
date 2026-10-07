"use client";

/**
 * ChatDock — THE AI CHAT BOX (v24.0 · SEES YOUR CHART).
 *
 * অ্যাপের ভেতরে একটি AI চ্যাট বক্স, নির্দিষ্ট মডেল সিলেক্ট করে চ্যাট করার
 * সুবিধা সহ — a floating chat available on EVERY tab (bottom-right FAB):
 *
 *   · VISION (v24) — every message carries a live SCREENSHOT of the chart
 *     (candles + drawings + AI ink, composited) and a full APP-STATE snapshot
 *     (tab, symbol, tf, layers, board stats, engine health). The backend runs
 *     the screenshot through a VLM first, so asking "চার্টটা দেখতে পারো?"
 *     now returns "হ্যাঁ" + what is actually on the screen. The 👁 toggle in
 *     the composer turns this on/off (on by default).
 *   · model picker — ALL models run WITHOUT any API key: GLM native +
 *     DeepSeek / Alibaba Qwen / Moonshot Kimi through the built-in engine,
 *     each with its own persona; every model shows a LIVE badge and every
 *     reply shows which engine answered.
 *   · effectively UNLIMITED — chat calls jump the engine queue (priority over
 *     AI Board meetings) and wait out cooldowns; the worst case is a few
 *     seconds of "queued…" instead of an error.
 *   · market-aware answers — grounded in the same live snapshot the AI Board
 *     reads (price, zones, patterns, board decision, news headlines).
 *   · history persisted per symbol (survives reloads), markdown rendering,
 *     typing indicator with elapsed time, clear-thread.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import ReactMarkdown from "react-markdown";
import {
  MessageCircle, X, Send, Loader2, Trash2, Sparkles, Bot, Eye, EyeOff, ScanSearch,
} from "lucide-react";
import type { BoardResponse } from "@/lib/market/types";

interface ChatMsgRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string;
  createdAt: string;
  /** "DeepSeek V3 · GLM-engine" style badge (fresh replies) */
  engineLabel?: string;
  /** v24 — this reply was grounded in an actual chart screenshot */
  vision?: boolean;
}

interface ModelsPayload {
  providers: { id: string; name: string; keyUrl: string; keyHint: string; hasKey: boolean; keyMasked: string | null }[];
  models: { id: string; provider: string; label: string; note: string; available: boolean; direct: boolean }[];
  chatModel: string;
  engine?: {
    coolingDown: boolean;
    cooldownRemainingMs: number;
    queuedBehind: number;
    queuedUser: number;
    spacingMs: number;
    stats: { totalCalls: number; total429: number; servedChat: number; servedVision: number; servedBoard: number; lastError: string | null; lastOkAt: number | null };
  };
}

async function fetchModels(): Promise<ModelsPayload> {
  const res = await fetch("/api/ai/models", { cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  return res.json();
}

async function fetchHistory(thread: string): Promise<ChatMsgRow[]> {
  const res = await fetch(`/api/ai/chat?thread=${encodeURIComponent(thread)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`history ${res.status}`);
  const data = await res.json();
  return data.messages ?? [];
}

const PROVIDER_LABELS: Record<string, string> = {
  builtin: "GLM · built-in",
  deepseek: "DeepSeek",
  qwen: "Alibaba Qwen",
  moonshot: "Moonshot Kimi",
};

// ── v24: chart screenshot capture ───────────────────────────────────────────

/**
 * Composite every canvas inside the live chart container (lightweight-charts
 * candles + the overlay with drawings/AI ink) into one downscaled JPEG
 * data-URL the backend can feed to the VLM. Returns null when the chart tab
 * isn't mounted — the chat still works, just without eyes.
 */
function captureChartImage(): string | null {
  try {
    const host = document.querySelector<HTMLElement>("[data-chart-capture]");
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 80 || h < 80) return null;

    const scale = Math.min(1, 1100 / w);
    const out = document.createElement("canvas");
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const ctx = out.getContext("2d");
    if (!ctx) return null;

    // solid dark background (JPEG has no alpha; keeps the chart's dark look)
    ctx.fillStyle = "#0a0f0d";
    ctx.fillRect(0, 0, out.width, out.height);

    // composite all canvases in DOM (stacking) order — candles first, then
    // the crosshair, then the overlay with drawings + AI ink
    host.querySelectorAll("canvas").forEach((c) => {
      try {
        ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, out.width, out.height);
      } catch {
        /* a tainted/odd canvas never blocks the rest */
      }
    });

    return out.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

export function ChatDock() {
  const { symbol, timeframe, mainTab, chartView, autoView, layers } = useTerminal();
  const { t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsgRow[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [vision, setVision] = useState(true);
  const [loadedThread, setLoadedThread] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // vision preference persists
  useEffect(() => {
    try {
      const saved = localStorage.getItem("aurum-chat-vision");
      if (saved === "0") setVision(false);
    } catch {}
  }, []);
  const toggleVision = (v: boolean) => {
    setVision(v);
    try { localStorage.setItem("aurum-chat-vision", v ? "1" : "0"); } catch {}
  };

  // model catalog (once per mount + on window focus when open)
  const modelsQ = useQuery({
    queryKey: ["ai-models"],
    queryFn: fetchModels,
    staleTime: 60_000,
    retry: 1,
  });

  // pick the default model: saved → server default
  useEffect(() => {
    if (!modelsQ.data) return;
    setModelId((prev) => {
      if (prev && modelsQ.data.models.some((m) => m.id === prev)) return prev;
      try {
        const saved = localStorage.getItem("aurum-chat-model");
        if (saved && modelsQ.data.models.some((m) => m.id === saved)) return saved;
      } catch {}
      return modelsQ.data.chatModel;
    });
  }, [modelsQ.data]);

  const pickModel = (id: string) => {
    setModelId(id);
    try { localStorage.setItem("aurum-chat-model", id); } catch {}
  };

  // history per symbol thread — load on open / symbol change
  useEffect(() => {
    if (!open) return;
    if (loadedThread === symbol) return;
    setLoadedThread(symbol);
    void fetchHistory(symbol)
      .then((rows) => setMessages(rows))
      .catch(() => setMessages([]));
  }, [open, symbol, loadedThread]);

  // autoscroll to the newest message
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  // elapsed seconds while the engine works (visible patience, not dead air)
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!sending) { setElapsed(0); return; }
    const started = sendStartedAt ?? Date.now();
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [sending, sendStartedAt]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setSendStartedAt(Date.now());

    // v24 — the AI's eyes: live chart screenshot (when the chart is on
    // screen and vision is toggled on) + the app's own state
    let image: string | null = null;
    if (vision) image = captureChartImage();

    const boardData = qc.getQueryData<BoardResponse>(["board", symbol, timeframe]);
    const layersOn = Object.entries(layers).filter(([, v]) => v).map(([k]) => k);
    const appState = {
      activeTab: mainTab,
      chartView,
      autoView,
      symbol,
      timeframe,
      layersOn,
      drawingsCount: (qc.getQueryData<unknown[]>(["drawings", symbol, timeframe]) ?? []).length,
      autoBoard: (() => { try { return localStorage.getItem("aurum-board-auto") === "1"; } catch { return null; } })(),
      boardStats: boardData?.stats ?? null,
      lastBoardAction: boardData?.latest?.decision.action ?? null,
      openSignals: boardData?.stats.open ?? null,
    };

    const optimistic: ChatMsgRow = {
      id: `tmp-${Date.now()}`,
      role: "user",
      content: text,
      model: modelId,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread: symbol,
          message: text,
          model: modelId,
          image: image ?? undefined,
          appState,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        toast({
          title: t("chatSendFailed"),
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        setInput(text); // give the text back — nothing was lost
        return;
      }
      if (data.userMessage) {
        setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? data.userMessage : m)));
      }
      if (data.assistantMessage) {
        setMessages((prev) => [
          ...prev,
          { ...data.assistantMessage, engineLabel: data.engineLabel, vision: data.vision === true },
        ]);
      }
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      toast({
        title: t("chatSendFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      setInput(text);
    } finally {
      setSending(false);
      setSendStartedAt(null);
      taRef.current?.focus();
    }
  }, [input, sending, modelId, symbol, t, vision, mainTab, chartView, autoView, layers, timeframe, qc]);

  const clearThread = useCallback(async () => {
    try {
      await fetch(`/api/ai/chat?thread=${encodeURIComponent(symbol)}`, { method: "DELETE" });
      setMessages([]);
      toast({ title: t("chatCleared") });
    } catch {
      toast({ title: t("chatSendFailed"), variant: "destructive" });
    }
  }, [symbol, t]);

  const byProvider = (modelsQ.data?.models ?? []).reduce<Record<string, ModelsPayload["models"]>>(
    (acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    },
    {},
  );

  // is the chart visible right now? (vision only has eyes on the chart tab)
  const chartOnScreen = mainTab === "chart";
  const visionActive = vision && chartOnScreen;

  return (
    <>
      {/* the floating launcher — above the mobile nav / status bar */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? t("chatClose") : t("chatTitle")}
        aria-expanded={open}
        className={cn(
          "fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-3 z-50 flex h-12 w-12 items-center justify-center rounded-full border shadow-lg transition-all sm:bottom-6 sm:right-6",
          open
            ? "border-border bg-card text-foreground rotate-0"
            : "border-primary/50 bg-primary text-primary-foreground shadow-[0_0_24px_-6px_rgba(245,158,11,0.6)] hover:scale-105",
        )}
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
        {!open && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-pulse rounded-full border-2 border-background bg-up" aria-hidden />
        )}
      </button>

      {/* the chat panel */}
      {open && (
        <div
          role="dialog"
          aria-label={t("chatTitle")}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl",
            // mobile: nearly full width, above the nav; desktop: docked card
            "inset-x-2 bottom-[calc(140px+env(safe-area-inset-bottom))] top-16",
            "sm:inset-x-auto sm:bottom-24 sm:right-6 sm:top-auto sm:h-[560px] sm:w-[400px]",
          )}
        >
          {/* header */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-2">
            <Sparkles className="h-4 w-4 shrink-0 text-gold" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-black uppercase tracking-wider text-foreground">
                {t("chatTitle")}
              </div>
              <div className="flex items-center gap-1 truncate font-mono text-[8px] font-bold uppercase tracking-wider text-muted-foreground/70">
                <span>{symbol} · {t("chatMarketAware")}</span>
                {visionActive && (
                  <span className="flex items-center gap-0.5 rounded border border-up/40 bg-up/10 px-1 py-px text-[7px] font-black uppercase tracking-wider text-up">
                    <ScanSearch className="h-2.5 w-2.5" aria-hidden />
                    {t("chatSeesChart")}
                  </span>
                )}
              </div>
            </div>

            {/* model picker — every model keyless + live */}
            <Select value={modelId} onValueChange={pickModel}>
              <SelectTrigger
                className="h-7 w-[150px] shrink-0 gap-1 border-border bg-background px-2 text-[10px] font-bold"
                aria-label={t("chatModel")}
              >
                <SelectValue placeholder={t("chatModel")} />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {Object.entries(byProvider).map(([pid, models]) => (
                  <SelectGroup key={pid}>
                    <SelectLabel className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                      {PROVIDER_LABELS[pid] ?? pid}
                    </SelectLabel>
                    {models.map((m) => (
                      <SelectItem
                        key={m.id}
                        value={m.id}
                        className="text-[11px]"
                        title={m.note}
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-up" aria-hidden />
                          <span className="font-semibold">{m.label}</span>
                          <span className="ml-auto font-mono text-[7px] font-black uppercase tracking-wider text-up/80">
                            live
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-down"
              onClick={() => void clearThread()}
              aria-label={t("chatClear")}
              title={t("chatClear")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* messages */}
          <div
            ref={listRef}
            className="slim-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3"
            aria-live="polite"
          >
            {messages.length === 0 && !sending && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <Bot className="h-8 w-8 text-primary/50" aria-hidden />
                <div className="text-xs font-bold text-foreground">{t("chatEmptyTitle")}</div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("chatEmptyHint")}
                </p>
              </div>
            )}

            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm border border-primary/40 bg-primary/15 px-3 py-2 text-[12px] leading-relaxed text-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[92%] rounded-lg rounded-bl-sm border border-border bg-card px-3 py-2">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="rounded border border-gold/40 bg-gold/10 px-1 py-px font-mono text-[7px] font-black uppercase tracking-wider text-gold">
                        {m.engineLabel ?? activeModelLabel(messages, m, modelsQ.data)}
                      </span>
                      {m.vision && (
                        <span
                          className="flex items-center gap-0.5 rounded border border-up/40 bg-up/10 px-1 py-px font-mono text-[7px] font-black uppercase tracking-wider text-up"
                          title={t("chatVisionBadgeHint")}
                        >
                          <ScanSearch className="h-2.5 w-2.5" aria-hidden />
                          {t("chatVisionBadge")}
                        </span>
                      )}
                    </div>
                    <div className="prose-chat text-[12px] leading-relaxed text-foreground/95 [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_ul]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-0.5 [&_strong]:font-bold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[10px]">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ),
            )}

            {sending && (
              <div className="flex items-center gap-2 px-1 py-1">
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-gold/40 bg-gold/10 text-gold">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                </span>
                <span className="flex gap-1" aria-hidden>
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:120ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:240ms]" />
                </span>
                <span className="text-[10px] font-semibold text-muted-foreground">
                  {elapsed >= 8
                    ? t("chatQueued").replace("{s}", String(elapsed))
                    : t("chatThinking")}
                </span>
              </div>
            )}
          </div>

          {/* composer */}
          <div className="shrink-0 border-t border-border bg-card/60 p-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              {/* the eye — vision on/off */}
              <button
                type="button"
                onClick={() => toggleVision(!vision)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-md border px-2 text-[10px] font-bold transition-colors",
                  visionActive
                    ? "border-up/40 bg-up/10 text-up"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={vision}
                aria-label={t("chatVisionToggle")}
                title={vision ? t("chatVisionOnHint") : t("chatVisionOffHint")}
              >
                {vision ? <Eye className="h-3 w-3" aria-hidden /> : <EyeOff className="h-3 w-3" aria-hidden />}
                {t("chatVisionToggle")}
              </button>
              {vision && !chartOnScreen && (
                <span className="truncate text-[9px] font-semibold text-muted-foreground/80">
                  {t("chatVisionNeedsChart")}
                </span>
              )}
            </div>
            <div className="flex items-end gap-2">
              <Textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={t("chatPlaceholder")}
                aria-label={t("chatPlaceholder")}
                className="max-h-28 min-h-[38px] flex-1 resize-none border-border bg-background text-[12px] leading-relaxed"
                rows={1}
                disabled={sending}
              />
              <Button
                size="sm"
                className="h-9 w-9 shrink-0 p-0"
                onClick={() => void send()}
                disabled={sending || !input.trim()}
                aria-label={t("chatSend")}
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Send className="h-4 w-4" aria-hidden />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** the badge for a message — the label of the model that wrote it (falls
 *  back to the raw id for old rows) */
function activeModelLabel(
  _messages: ChatMsgRow[],
  m: ChatMsgRow,
  catalog: ModelsPayload | undefined,
): string {
  if (catalog) {
    const found = catalog.models.find((x) => x.id === m.model);
    if (found) return found.label;
  }
  return m.model || "AI";
}
