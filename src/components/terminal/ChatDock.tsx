"use client";

/**
 * ChatDock — THE AI CHAT BOX (v23.0 · KEYLESS).
 *
 * অ্যাপের ভেতরে একটি AI চ্যাট বক্স, নির্দিষ্ট মডেল সিলেক্ট করে চ্যাট করার
 * সুবিধা সহ — a floating chat available on EVERY tab (bottom-right FAB):
 *
 *   · model picker — ALL models work WITHOUT any API key (v23): GLM native
 *     + DeepSeek / Alibaba Qwen / Moonshot Kimi through the built-in engine,
 *     each with its own persona; the badge on every reply shows which engine
 *     actually answered (native / GLM-engine / direct)
 *   · market-aware answers — every reply is grounded in the same live
 *     snapshot the AI Board reads (price, zones, patterns, board decision,
 *     news headlines); ask "এখন entry নেবো?" and get real levels
 *   · history persisted per symbol (survives reloads), markdown rendering,
 *     typing indicator, clear-thread, rate-limit-aware errors
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  MessageCircle, X, Send, Loader2, Trash2, Sparkles, Bot, Unlock,
} from "lucide-react";

interface ChatMsgRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string;
  createdAt: string;
  /** v23 — "DeepSeek V3 · GLM-engine" style badge (fresh replies only) */
  engineLabel?: string;
}

interface ModelsPayload {
  providers: { id: string; name: string; keyUrl: string; keyHint: string; hasKey: boolean; keyMasked: string | null }[];
  models: { id: string; provider: string; label: string; note: string; available: boolean; direct: boolean }[];
  chatModel: string;
  engine?: {
    coolingDown: boolean;
    cooldownRemainingMs: number;
    stats: { totalCalls: number; total429: number; lastError: string | null; lastOkAt: number | null };
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

export function ChatDock() {
  const { symbol } = useTerminal();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsgRow[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [modelId, setModelId] = useState<string>("");
  const [loadedThread, setLoadedThread] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
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
        body: JSON.stringify({ thread: symbol, message: text, model: modelId }),
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
        setMessages((prev) => [...prev, { ...data.assistantMessage, engineLabel: data.engineLabel }]);
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
      taRef.current?.focus();
    }
  }, [input, sending, modelId, symbol, t]);

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
              <div className="truncate font-mono text-[8px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {symbol} · {t("chatMarketAware")}
              </div>
            </div>

            {/* model picker — every model keyless (v23) */}
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
                          <span
                            className={cn(
                              "h-1.5 w-1.5 shrink-0 rounded-full",
                              m.provider === "builtin" || m.direct ? "bg-up" : "bg-gold",
                            )}
                            aria-hidden
                          />
                          <span className="font-semibold">{m.label}</span>
                          {m.provider !== "builtin" && !m.direct && (
                            <Unlock className="ml-auto h-3 w-3 text-gold/80" aria-hidden />
                          )}
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
                <span className="text-[10px] font-semibold text-muted-foreground">{t("chatThinking")}</span>
              </div>
            )}
          </div>

          {/* composer */}
          <div className="shrink-0 border-t border-border bg-card/60 p-2">
            <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-up/30 bg-up/5 px-2 py-1 text-[10px] font-semibold text-up">
              <Unlock className="h-3 w-3 shrink-0" aria-hidden />
              {t("chatKeylessNote")}
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
