"use client";

/**
 * AiModelsCard — the AI MODELS & KEYS settings card (v22.0).
 *
 * Where the multi-provider brain is wired:
 *   · API keys — one row per external company (DeepSeek · Alibaba Qwen ·
 *     Moonshot Kimi). The key is pasted once, saved SERVER-SIDE only and
 *     shown back masked. A Test button fires a tiny real call.
 *   · Board agents — assign a model to each of the 6 board members (Trend,
 *     SMC, Risk, Skeptic, Volatility, CTO); every meeting then routes each
 *     agent's call to its own company's model.
 *   · Chat default — the model the AI Chat opens with.
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
  Cpu, KeyRound, Loader2, Check, X, ExternalLink, Save, Sparkles,
} from "lucide-react";

interface ModelsPayload {
  providers: {
    id: string; name: string; keyUrl: string; keyHint: string;
    hasKey: boolean; keyMasked: string | null;
  }[];
  models: { id: string; provider: string; label: string; note: string; available: boolean }[];
  boardAgents: string[];
  boardModels: Record<string, string>;
  chatModel: string;
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
          description: `${j.modelLabel ?? providerId} · ${j.latencyMs}ms`,
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

  const byProvider = data.models.reduce<Record<string, typeof data.models>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

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
        <p className="text-[10px] leading-relaxed text-muted-foreground">{t("aiModelsNote")}</p>

        {/* ── provider keys ── */}
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
                  disabled={testing === p.id || (!p.hasKey && !(keyDrafts[p.id] ?? "").trim())}
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

        {/* ── board agent assignment ── */}
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
                      {Object.entries(byProvider).map(([pid, models]) => (
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
                                    m.available ? "bg-up" : "bg-muted-foreground/40",
                                  )}
                                  aria-hidden
                                />
                                {m.label}
                                {!m.available && <KeyRound className="ml-auto h-3 w-3 text-amber-400" aria-hidden />}
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
              {Object.entries(byProvider).map(([pid, models]) => (
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
                            m.available ? "bg-up" : "bg-muted-foreground/40",
                          )}
                          aria-hidden
                        />
                        {m.label}
                        {!m.available && <KeyRound className="ml-auto h-3 w-3 text-amber-400" aria-hidden />}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
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
