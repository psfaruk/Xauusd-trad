"use client";

/**
 * AiModelsCard — the AI MODELS control center (v23.0 · KEYLESS-FIRST).
 *
 * The v23 truth: EVERY model runs WITHOUT any API key — the built-in engine
 * serves GLM natively and every other company's model (DeepSeek · Qwen ·
 * Kimi) through its persona, serialized + 429-retried by the gate. This card
 * shows:
 *   · engine health — calls served, rate-limit hits, cooling-down state
 *   · the model catalog — each model badged native / keyless / direct
 *   · board agents — assign any model to each of the 6 members
 *   · chat default — the model the AI Chat opens with
 *   · OPTIONAL keys — paste a provider key to upgrade that company to
 *     direct first-party calls (more quota); everything still works keyless
 */

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Cpu, KeyRound, Loader2, Check, X, ExternalLink, Save, Sparkles, Unlock, Zap, Gauge, Infinity as InfinityIcon, Star,
} from "lucide-react";

interface ModelsPayload {
  providers: {
    id: string; name: string; keyUrl: string; keyHint: string;
    hasKey: boolean; keyMasked: string | null;
  }[];
  models: { id: string; provider: string; label: string; note: string; tier: "standard" | "special"; available: boolean; direct: boolean }[];
  boardAgents: string[];
  boardModels: Record<string, string>;
  chatModel: string;
  engine?: {
    coolingDown: boolean;
    cooldownRemainingMs: number;
    queuedBehind: number;
    queuedUser: number;
    spacingMs: number;
    minSpacingMs: number;
    stats: { totalCalls: number; total429: number; servedChat: number; servedVision: number; servedBoard: number; lastError: string | null; lastErrorAt: number | null; lastOkAt: number | null };
  };
}

const AGENT_LABELS: Record<string, { bn: string; en: string }> = {
  trend: { bn: "ট্রেন্ড ও ইন্ডিকেটর বিশ্লেষক", en: "Trend & Indicators" },
  smc: { bn: "SMC ও প্রাইস অ্যাকশন বিশেষজ্ঞ", en: "SMC & Price Action" },
  risk: { bn: "রিস্ক ও মানি ম্যানেজার", en: "Risk & Money" },
  skeptic: { bn: "রিস্ক অডিটর (সংশয়বাদী)", en: "Risk Auditor" },
  volatility: { bn: "ভোলাটিলিটি ও নিউজ ফিল্টার", en: "Volatility & News" },
  cto: { bn: "চিফ ট্রেডিং অফিসার", en: "Chief Trading Officer" },
};

const PROVIDER_LABELS: Record<string, string> = {
  builtin: "GLM · built-in",
  deepseek: "DeepSeek",
  qwen: "Alibaba Qwen",
  moonshot: "Moonshot Kimi",
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  google: "Google Gemini",
  xai: "xAI Grok",
};

async function fetchModels(): Promise<ModelsPayload> {
  const res = await fetch("/api/ai/models", { cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  return res.json();
}

export function AiModelsCard() {
  const { t } = useI18n();
  const modelsQ = useQuery({
    queryKey: ["ai-models"],
    queryFn: fetchModels,
    staleTime: 30_000,
    retry: 1,
  });
  const data = modelsQ.data;

  // per-provider key input + busy state
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [savingAssign, setSavingAssign] = useState(false);

  // live assignment copy (saved on change)
  const [boardModels, setBoardModels] = useState<Record<string, string>>({});
  const [chatModel, setChatModel] = useState<string>("");

  useEffect(() => {
    if (!data) return;
    setBoardModels(data.boardModels);
    setChatModel(data.chatModel);
  }, [data]);

  const saveKey = useCallback(async (providerId: string) => {
    const key = (keyDrafts[providerId] ?? "").trim();
    if (!key) return;
    setSavingKey(providerId);
    try {
      const res = await fetch("/api/ai/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setKey: { provider: providerId, key } }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setKeyDrafts((prev) => ({ ...prev, [providerId]: "" }));
      toast({ title: `✅ ${t("aiKeySaved")}` });
      await modelsQ.refetch();
    } catch (e) {
      toast({
        title: t("aiKeySaveFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSavingKey(null);
    }
  }, [keyDrafts, t, modelsQ]);

  const clearKey = useCallback(async (providerId: string) => {
    setSavingKey(providerId);
    try {
      await fetch("/api/ai/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearKey: providerId }),
      });
      toast({ title: `🗑️ ${t("aiKeyCleared")}` });
      await modelsQ.refetch();
    } catch {
      toast({ title: t("aiKeySaveFailed"), variant: "destructive" });
    } finally {
      setSavingKey(null);
    }
  }, [t, modelsQ]);

  const testKey = useCallback(async (providerId: string) => {
    setTesting(providerId);
    try {
      const override = (keyDrafts[providerId] ?? "").trim();
      const res = await fetch("/api/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, ...(override ? { key: override } : {}) }),
      });
      const j = await res.json();
      if (j.ok) {
        toast({
          title: `✅ ${t("aiTestOk")}`,
          description: `${j.modelLabel ?? providerId} · ${j.route ?? ""} · ${j.latencyMs}ms`,
        });
      } else {
        toast({
          title: `⚠️ ${t("aiTestFail")}`,
          description: j.error ?? "unknown error",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: t("aiTestFail"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setTesting(null);
    }
  }, [keyDrafts, t]);

  const saveAssignments = useCallback(async (next: {
    boardModels?: Record<string, string>;
    chatModel?: string;
  }) => {
    setSavingAssign(true);
    try {
      const res = await fetch("/api/ai/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await modelsQ.refetch();
      toast({ title: `✅ ${t("aiAssignSaved")}` });
    } catch (e) {
      toast({
        title: t("aiAssignSaveFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSavingAssign(false);
    }
  }, [t, modelsQ]);

  if (modelsQ.isLoading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t("aiModelsLoading")}
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const engine = data.engine;
  const directCount = data.models.filter((m) => m.direct).length;
  // v25 — the flagship generation: gold ★ tier, rendered first everywhere
  const specialModels = data.models.filter((m) => m.tier === "special");
  const standardModels = data.models.filter((m) => m.tier !== "special");
  const catalog = [...specialModels, ...standardModels];

  return (
    <Card className="border-border bg-card">
      <CardHeader className="border-b border-border py-3">
        <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
          <Cpu className="h-3.5 w-3.5 text-primary" />
          {t("aiModelsCard")}
          {savingAssign && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />}
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 py-3">
        {/* ── keyless banner + engine health ── */}
        <div className="rounded-lg border border-up/30 bg-up/5 p-2.5">
          <div className="flex items-center gap-2">
            <Unlock className="h-4 w-4 shrink-0 text-up" aria-hidden />
            <span className="text-[11px] font-bold text-foreground">{t("aiKeylessTitle")}</span>
            <span className="ml-auto rounded border border-up/40 bg-up/10 px-1.5 py-px font-mono text-[8px] font-black uppercase tracking-wider text-up">
              {data.models.length} models · all live
            </span>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {t("aiKeylessNote")}
          </p>

          {/* v25 — the flagship strip: the special generation, gold and proud */}
          {specialModels.length > 0 && (
            <div className="mt-2 rounded-md border border-gold/40 bg-gold/5 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <Star className="h-3 w-3 shrink-0 fill-gold text-gold" aria-hidden />
                <span className="text-[10px] font-black uppercase tracking-wide text-gold">
                  {t("aiSpecialTier")}
                </span>
                <span className="ml-auto rounded border border-gold/40 bg-gold/10 px-1 py-px font-mono text-[8px] font-black uppercase tracking-wider text-gold">
                  {specialModels.length} flagship
                </span>
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                {t("aiSpecialNote")}
              </p>
            </div>
          )}

          {/* v24 — the unlimited promise: how the queue protects the user */}
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5">
            <InfinityIcon className="mt-px h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <p className="text-[9px] leading-relaxed text-muted-foreground">{t("aiUnlimitedNote")}</p>
          </div>

          {/* engine stats strip — served counts, not scary errors */}
          {engine && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-up/20 pt-2 text-[9px] font-semibold text-muted-foreground">
              <span className="flex items-center gap-1">
                <Gauge className="h-3 w-3 text-primary" aria-hidden />
                {t("aiEngineHealth")}
              </span>
              <span className="tnum font-mono" title={t("aiServedChatHint")}>
                💬 {engine.stats.servedChat}
              </span>
              <span className="tnum font-mono" title={t("aiServedVisionHint")}>
                👁 {engine.stats.servedVision}
              </span>
              <span className="tnum font-mono" title={t("aiServedBoardHint")}>
                🏛 {engine.stats.servedBoard}
              </span>
              {engine.queuedBehind > 0 && (
                <span className="tnum font-mono text-primary">⏳ {engine.queuedBehind}</span>
              )}
              {engine.coolingDown ? (
                <span className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase text-amber-400">
                  <Zap className="h-2.5 w-2.5" aria-hidden />
                  {t("aiEngineCooling")} {Math.ceil(engine.cooldownRemainingMs / 1000)}s
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded border border-up/40 bg-up/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase text-up">
                  <Check className="h-2.5 w-2.5" aria-hidden />
                  {t("aiEngineReady")}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── the catalog — every model, its route ── */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden />
            {t("aiCatalogTitle")}
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {catalog.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border bg-background px-2 py-1.5",
                  m.tier === "special" ? "border-gold/40 bg-gold/5" : "border-border",
                )}
                title={m.note}
              >
                {m.tier === "special" ? (
                  <Star className="h-2.5 w-2.5 shrink-0 fill-gold text-gold" aria-hidden />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-up" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[10px] font-bold", m.tier === "special" ? "text-gold" : "text-foreground")}>
                    {m.label}
                  </span>
                  <span className="block truncate text-[8px] text-muted-foreground">
                    {PROVIDER_LABELS[m.provider] ?? m.provider}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded border px-1 py-px font-mono text-[7px] font-black uppercase tracking-wider",
                    m.direct
                      ? "border-up/40 bg-up/10 text-up"
                      : m.tier === "special"
                        ? "border-gold/40 bg-gold/10 text-gold"
                        : "border-gold/40 bg-gold/10 text-gold",
                  )}
                >
                  {m.direct ? "direct" : m.tier === "special" ? "flagship" : "live"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── board agent assignment — every model selectable ── */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-foreground">
            <Cpu className="h-3.5 w-3.5 text-primary" aria-hidden />
            {t("aiAssignTitle")}
          </div>
          <p className="mb-2 text-[9px] leading-snug text-muted-foreground/80">{t("aiAssignNote")}</p>
          <div className="flex flex-col gap-1.5">
            {data.boardAgents.map((agent) => {
              const label = AGENT_LABELS[agent] ?? { bn: agent, en: agent };
              return (
                <div key={agent} className="flex items-center gap-2">
                  <Label htmlFor={`agent-${agent}`} className="w-full max-w-[180px] shrink-0 truncate text-[10px] font-semibold text-muted-foreground">
                    {label.bn}
                    <span className="ml-1 text-[8px] uppercase tracking-wider text-muted-foreground/60">
                      {label.en}
                    </span>
                  </Label>
                  <Select
                    value={boardModels[agent] ?? "glm-4.6"}
                    onValueChange={(v) => {
                      const next = { ...boardModels, [agent]: v };
                      setBoardModels(next);
                      void saveAssignments({ boardModels: next });
                    }}
                  >
                    <SelectTrigger
                      id={`agent-${agent}`}
                      className="h-8 flex-1 border-border bg-background text-[10px] font-bold"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {/* ★ flagship tier first */}
                      {specialModels.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="text-[9px] font-black uppercase tracking-wider text-gold">
                            ★ {t("aiSpecialTier")}
                          </SelectLabel>
                          {specialModels.map((m) => (
                            <SelectItem key={m.id} value={m.id} className="text-[11px]" title={m.note}>
                              <span className="flex w-full items-center gap-1.5">
                                <Star className="h-2.5 w-2.5 shrink-0 fill-gold text-gold" aria-hidden />
                                {m.label}
                                {m.direct && (
                                  <span className="ml-auto font-mono text-[7px] font-black uppercase text-up">direct</span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {Object.entries(
                        standardModels.reduce<Record<string, typeof data.models>>((acc, m) => {
                          (acc[m.provider] ??= []).push(m);
                          return acc;
                        }, {}),
                      ).map(([pid, models]) => (
                        <SelectGroup key={pid}>
                          <SelectLabel className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                            {PROVIDER_LABELS[pid] ?? pid}
                          </SelectLabel>
                          {models.map((m) => (
                            <SelectItem key={m.id} value={m.id} className="text-[11px]" title={m.note}>
                              <span className="flex w-full items-center gap-1.5">
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                    m.provider === "builtin" || m.direct ? "bg-up" : "bg-gold",
                                  )}
                                  aria-hidden
                                />
                                {m.label}
                                {m.direct && (
                                  <span className="ml-auto font-mono text-[7px] font-black uppercase text-up">direct</span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── chat default model ── */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden />
            {t("aiChatDefault")}
          </div>
          <Select
            value={chatModel}
            onValueChange={(v) => {
              setChatModel(v);
              void saveAssignments({ chatModel: v });
            }}
          >
            <SelectTrigger className="h-8 border-border bg-background text-[10px] font-bold" aria-label={t("aiChatDefault")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {/* ★ flagship tier first */}
              {specialModels.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[9px] font-black uppercase tracking-wider text-gold">
                    ★ {t("aiSpecialTier")}
                  </SelectLabel>
                  {specialModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-[11px]" title={m.note}>
                      <span className="flex w-full items-center gap-1.5">
                        <Star className="h-2.5 w-2.5 shrink-0 fill-gold text-gold" aria-hidden />
                        {m.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {Object.entries(
                standardModels.reduce<Record<string, typeof data.models>>((acc, m) => {
                  (acc[m.provider] ??= []).push(m);
                  return acc;
                }, {}),
              ).map(([pid, models]) => (
                <SelectGroup key={pid}>
                  <SelectLabel className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                    {PROVIDER_LABELS[pid] ?? pid}
                  </SelectLabel>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-[11px]" title={m.note}>
                      <span className="flex w-full items-center gap-1.5">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            m.provider === "builtin" || m.direct ? "bg-up" : "bg-gold",
                          )}
                          aria-hidden
                        />
                        {m.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* ── optional keys (direct upgrade) ── */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-foreground">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {t("aiOptionalKeysTitle")}
            {directCount > 0 && (
              <span className="rounded border border-up/40 bg-up/10 px-1 py-px font-mono text-[7px] font-black uppercase text-up">
                {directCount} direct
              </span>
            )}
          </div>
          <p className="mb-2 text-[9px] leading-snug text-muted-foreground/80">{t("aiOptionalKeysNote")}</p>
          <div className="flex flex-col gap-3">
            {data.providers.map((p) => (
              <div key={p.id} className="rounded-lg border border-border bg-background p-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      p.hasKey ? "bg-up" : "bg-muted-foreground/40",
                    )}
                    aria-hidden
                  />
                  <span className="text-[11px] font-bold text-foreground">{p.name}</span>
                  {p.hasKey && p.keyMasked && (
                    <span className="rounded border border-border bg-muted/50 px-1 py-px font-mono text-[8px] font-bold text-muted-foreground">
                      {p.keyMasked}
                    </span>
                  )}
                  <a
                    href={p.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto flex items-center gap-1 text-[9px] font-semibold text-primary hover:underline"
                  >
                    {t("aiGetKey")}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </div>

                <div className="mt-2 flex items-center gap-1.5">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={p.hasKey ? t("aiKeyReplace") : "sk-…"}
                    aria-label={`${p.name} API key`}
                    className="h-8 flex-1 text-[11px]"
                    value={keyDrafts[p.id] ?? ""}
                    onChange={(e) => setKeyDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    disabled={savingKey === p.id}
                  />
                  <Button
                    size="sm"
                    className="h-8 gap-1 px-2.5 text-[10px] font-bold"
                    onClick={() => void saveKey(p.id)}
                    disabled={savingKey === p.id || !(keyDrafts[p.id] ?? "").trim()}
                  >
                    {savingKey === p.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <KeyRound className="h-3 w-3" aria-hidden />
                    )}
                    {t("aiKeySave")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 px-2.5 text-[10px] font-bold"
                    onClick={() => void testKey(p.id)}
                    disabled={testing === p.id}
                  >
                    {testing === p.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="h-3 w-3" aria-hidden />
                    )}
                    {t("aiKeyTest")}
                  </Button>
                  {p.hasKey && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-down"
                      onClick={() => void clearKey(p.id)}
                      disabled={savingKey === p.id}
                      aria-label={t("aiKeyClear")}
                      title={t("aiKeyClear")}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </Button>
                  )}
                </div>
                <p className="mt-1.5 text-[9px] leading-snug text-muted-foreground/80">{p.keyHint}</p>
              </div>
            ))}
          </div>
        </div>

        {/* status line */}
        <div className="flex items-center gap-2 border-t border-border/60 pt-2.5 text-[9px] text-muted-foreground">
          {savingAssign ? (
            <><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t("aiSaving")}</>
          ) : (
            <><Check className="h-3 w-3 text-up" aria-hidden />
            {t("aiKeysServerNote")}
            <Save className="ml-auto h-3 w-3" aria-hidden /></>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
