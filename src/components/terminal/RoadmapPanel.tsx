"use client";

import { useEffect, useState } from "react";
import { motion, type Variants } from "framer-motion";
import type { AnalysisResponse } from "@/lib/market/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Map,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Magnet,
  Target,
  Route,
} from "lucide-react";

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

function UpdatedAgo({ at }: { at: number | undefined }) {
  const { t } = useI18n();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!at) return null;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  const fresh = s < 35;
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 font-mono text-[9px] normal-case",
        fresh ? "text-up" : "text-muted-foreground",
      )}
      title={t("lastUpdate")}
    >
      <span
        className={cn("h-1 w-1 rounded-full", fresh ? "live-dot bg-up" : "bg-muted-foreground/50")}
        aria-hidden="true"
      />
      {t("lastUpdate")} · {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`}
    </span>
  );
}

export function RoadmapPanel({ analysis }: { analysis: AnalysisResponse | null }) {
  const { t } = useI18n();
  const rm = analysis?.roadmap;
  const digits = analysis?.digits ?? 2;

  const dirIcon =
    rm?.direction === "BULL" ? (
      <ArrowUpRight className="h-4 w-4" />
    ) : rm?.direction === "BEAR" ? (
      <ArrowDownRight className="h-4 w-4" />
    ) : (
      <Minus className="h-4 w-4" />
    );
  const dirClass =
    rm?.direction === "BULL" ? "text-up" : rm?.direction === "BEAR" ? "text-down" : "text-muted-foreground";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-bold uppercase tracking-wider">
        <Map className="h-3.5 w-3.5 text-gold" />
        {t("roadmap")}
        <UpdatedAgo at={analysis?.generatedAt} />
      </div>
      {rm ? (
        <ScrollArea className="slim-scroll min-h-0 flex-1">
          <motion.div
            variants={listVariants}
            initial="hidden"
            animate="show"
            className="space-y-3 p-3"
          >
          {/* direction verdict */}
          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-3">
            <div className="flex items-center gap-2">
              <span className={cn("flex items-center gap-1 text-lg font-black tracking-wider", dirClass)}>
                {dirIcon}
                {rm.direction}
              </span>
              <span className="ml-auto rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                {rm.runDir} · run {rm.run}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{rm.directionWhy}</p>
          </motion.div>

          {/* structure ladder */}
          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {t("runPhase")}
              </span>
              <span
                className={cn(
                  "rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase",
                  rm.phase === "reversal-confirmed"
                    ? "border-gold/40 bg-gold/10 text-gold"
                    : rm.phase === "extended"
                      ? "border-down/40 bg-down/10 text-down"
                      : "border-border bg-muted/50 text-muted-foreground",
                )}
              >
                {rm.phase}
              </span>
            </div>
            <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{t("reversalProb")}</span>
              <span className="tnum font-mono text-foreground">{(rm.pReversal * 100).toFixed(0)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-gold/60 to-gold"
                style={{ width: `${Math.round(rm.pReversal * 100)}%` }}
              />
            </div>
          </motion.div>

          {/* magnets */}
          {rm.magnets.length > 0 && (
            <motion.div variants={itemVariants}>
            <Section icon={<Magnet className="h-3 w-3" />} title={t("magnetLevels")}>
              {rm.magnets.map((m, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/40">
                  <span className="w-24 truncate text-[11px] text-muted-foreground">{m.label}</span>
                  <span className="tnum ml-auto font-mono text-[11px] font-bold text-gold">
                    {m.price.toFixed(digits)}
                  </span>
                  <span className="tnum w-14 text-right font-mono text-[10px] text-muted-foreground">
                    {m.distAtr.toFixed(1)} ATR
                  </span>
                </div>
              ))}
            </Section>
            </motion.div>
          )}

          {/* liquidity targets */}
          {rm.liquidity.length > 0 && (
            <motion.div variants={itemVariants}>
            <Section icon={<Target className="h-3 w-3" />} title={t("liquidityTargets")}>
              {rm.liquidity.map((l, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/40">
                  <span
                    className={cn(
                      "rounded border px-1 py-px font-mono text-[9px] font-bold",
                      l.side === "BSL" ? "border-down/30 text-down" : "border-up/30 text-up",
                    )}
                  >
                    {l.side}
                  </span>
                  <span className="tnum font-mono text-[11px] text-foreground">{l.price.toFixed(digits)}</span>
                  <span
                    className={cn(
                      "rounded bg-muted/60 px-1 py-px font-mono text-[9px]",
                      l.state === "swept" ? "text-gold" : l.state === "run" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {l.state}
                  </span>
                  <span className="tnum ml-auto font-mono text-[10px] text-muted-foreground">
                    {l.distAtr.toFixed(1)} ATR
                  </span>
                </div>
              ))}
            </Section>
            </motion.div>
          )}

          {/* projected path */}
          {rm.path && (
            <motion.div variants={itemVariants} className="rounded-lg border border-gold/25 bg-gold/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                <Route className="h-3 w-3" />
                {t("projectedPath")}
              </div>
              <p className="text-[11px] text-foreground">{rm.path.note}</p>
            </motion.div>
          )}

          {/* scenarios */}
          <motion.div variants={itemVariants} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ScenarioCard
              title={t("scenarioBull")}
              tone="up"
              entry={rm.bullScenario.entry}
              targets={rm.bullScenario.targets}
              note={rm.bullScenario.note}
              digits={digits}
            />
            <ScenarioCard
              title={t("scenarioBear")}
              tone="down"
              entry={rm.bearScenario.entry}
              targets={rm.bearScenario.targets}
              note={rm.bearScenario.note}
              digits={digits}
            />
          </motion.div>

          {/* key levels ladder */}
          <motion.div variants={itemVariants}>
          <Section icon={<Target className="h-3 w-3" />} title={t("keyLevels")}>
            {rm.keyLevels
              .slice()
              .sort((a, b) => b.price - a.price)
              .map((k, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-sm",
                      k.tone === "bull" ? "bg-up" : k.tone === "bear" ? "bg-down" : k.tone === "gold" ? "bg-gold" : "bg-muted-foreground/50",
                    )}
                  />
                  <span className="flex-1 truncate text-[11px] text-muted-foreground">{k.label}</span>
                  <span className="tnum font-mono text-[11px] font-bold text-foreground">
                    {k.price.toFixed(digits)}
                  </span>
                </div>
              ))}
          </Section>
          </motion.div>
          </motion.div>
        </ScrollArea>
      ) : (
        <ScrollArea className="slim-scroll min-h-0 flex-1">
          <div className="space-y-3 p-3" aria-busy="true">
            <span className="sr-only">{t("loading")}</span>
            {/* 1 · direction verdict */}
            <div className="animate-pulse rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2">
                <div className="h-5 w-28 rounded bg-muted" />
                <div className="ml-auto h-3.5 w-20 rounded bg-muted" />
              </div>
              <div className="mt-2.5 h-2.5 w-3/4 rounded bg-muted" />
              <div className="mt-1.5 h-2.5 w-1/2 rounded bg-muted" />
            </div>
            {/* 2 · run phase ladder */}
            <div className="animate-pulse rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex items-center justify-between">
                <div className="h-2.5 w-20 rounded bg-muted" />
                <div className="h-3.5 w-28 rounded bg-muted" />
              </div>
              <div className="mt-3 h-2 w-14 rounded bg-muted" />
              <div className="mt-2 h-1.5 w-full rounded-full bg-muted" />
            </div>
            {/* 3 · magnet / liquidity rows */}
            <div className="animate-pulse rounded-lg border border-border bg-muted/40 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-1 py-1.5">
                  <div className="h-2.5 w-24 rounded bg-muted" />
                  <div className="ml-auto h-2.5 w-12 rounded bg-muted" />
                  <div className="h-2.5 w-10 rounded bg-muted" />
                </div>
              ))}
            </div>
            {/* 4 · scenario cards */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
              <div className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-2">
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function ScenarioCard({
  title,
  tone,
  entry,
  targets,
  note,
  digits,
}: {
  title: string;
  tone: "up" | "down";
  entry: number;
  targets: number[];
  note: string;
  digits: number;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2.5",
        tone === "up" ? "border-up/25 bg-up/5" : "border-down/25 bg-down/5",
      )}
    >
      <div
        className={cn(
          "mb-1.5 text-[10px] font-bold uppercase tracking-wider",
          tone === "up" ? "text-up" : "text-down",
        )}
      >
        {title}
      </div>
      <div className="tnum mb-1 font-mono text-[10px] text-muted-foreground">
        pivot ≈ {entry.toFixed(digits)}
      </div>
      <div className="space-y-0.5">
        {targets.map((tp, i) => (
          <div key={i} className="tnum font-mono text-[11px] font-bold text-foreground">
            T{i + 1} {tp.toFixed(digits)}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground/70">{note}</p>
    </div>
  );
}
