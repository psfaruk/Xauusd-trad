"use client";

/**
 * TopBar — the single global header (identical on mobile & desktop):
 * brand · symbol picker · live quote · connection · theme · language.
 *
 * Chart-specific controls (view folders · timeframe · layers · drawings)
 * live inside the ChartWorkspace strip — nothing is duplicated here.
 */

import { useTheme } from "next-themes";
import { useQuote, useSymbolList, useStatus } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SymbolPicker } from "./SymbolPicker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Sun, Moon, MonitorSmartphone, Languages, Maximize2, Layers } from "lucide-react";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="1" y="7" width="3" height="7" rx="0.5" fill="var(--color-down)" opacity="0.9" />
        <line x1="2.5" y1="4" x2="2.5" y2="17" stroke="var(--color-down)" strokeWidth="0.8" opacity="0.9" />
        <rect x="8" y="4" width="3" height="9" rx="0.5" fill="var(--color-up)" />
        <line x1="9.5" y1="1.5" x2="9.5" y2="15.5" stroke="var(--color-up)" strokeWidth="0.8" />
        <rect x="15" y="8" width="3" height="6" rx="0.5" fill="var(--color-gold)" opacity="0.95" />
        <line x1="16.5" y1="5.5" x2="16.5" y2="18" stroke="var(--color-gold)" strokeWidth="0.8" opacity="0.95" />
      </svg>
      <span className="text-sm font-black tracking-[0.14em] text-foreground">
        AURUM<span className="text-primary">·</span>T
      </span>
    </span>
  );
}

/** chart layer toggles — used by the ChartWorkspace strip (price view only) */
export function LayersPopover() {
  const { layers, toggleLayer } = useTerminal();
  const { t } = useI18n();
  const items: { key: keyof typeof layers; label: string }[] = [
    { key: "setup", label: t("layerSetup") },
    { key: "zones", label: t("layerZones") },
    { key: "levels", label: t("layerLevels") },
    { key: "structure", label: t("layerStructure") },
    { key: "ema", label: t("layerEma") },
    { key: "killzones", label: t("layerKillzones") },
    { key: "volume", label: t("layerVolume") },
    { key: "signals", label: t("layerSignals") },
    { key: "ai", label: t("layerAi") },
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 w-7 p-0" aria-label={t("layers")}>
          <Layers className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
          {t("layers")}
        </div>
        {items.map(({ key, label }) => (
          <label key={key} className="flex cursor-pointer items-center justify-between rounded px-1.5 py-1.5 hover:bg-muted/60">
            <span className="text-[11px]">{label}</span>
            <Switch checked={layers[key]} onCheckedChange={() => toggleLayer(key)} />
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function ConnectionChip() {
  const status = useStatus();
  const { t } = useI18n();
  const source = status?.source ?? "mt5";
  const connected = status?.connected ?? false;
  const offline = source === "disconnected" && !connected;
  const label = connected ? t("live") : offline ? t("mt5Offline") : t("connecting");
  const cls = offline
    ? "border-red-500/40 bg-red-500/10 text-red-500"
    : connected
      ? "border-up/40 bg-up/10 text-up"
      : "border-amber-500/40 bg-amber-500/10 text-amber-500";
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider",
        cls,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          connected ? "bg-up live-dot" : offline ? "bg-red-500" : "bg-amber-500 live-dot",
        )}
      />
      {label}
    </span>
  );
}

/** theme cycles dark → light → system (full control lives in Settings) */
export function ThemeCycleButton() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : MonitorSmartphone;
  const label = theme === "dark" ? t("themeDark") : theme === "light" ? t("themeLight") : t("themeSystem");
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0"
      onClick={() => setTheme(next)}
      aria-label={`${t("theme")} → ${label}`}
      title={`${label} →`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}

export function LanguageButton() {
  const { locale, setLocale } = useI18n();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1 px-1.5 font-mono text-[10px] font-bold"
      onClick={() => setLocale(locale === "en" ? "bn" : "en")}
      aria-label="language"
    >
      <Languages className="h-4 w-4" />
      {locale === "en" ? "EN" : "বাং"}
    </Button>
  );
}

export function TopBar() {
  const { symbol } = useTerminal();
  const quote = useQuote(symbol);
  const symbols = useSymbolList();
  const digits = symbols.find((s) => s.name === symbol)?.digits ?? quote?.digits ?? 2;
  const up = (quote?.change ?? 0) >= 0;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 backdrop-blur">
      <BrandMark className="text-foreground" />
      <div className="mx-1 h-5 w-px bg-border" />
      <SymbolPicker compact />
      {quote && (
        <div className="hidden items-center gap-1.5 sm:flex">
          <span className={cn("tnum font-mono text-sm font-bold", up ? "text-up" : "text-down")}>
            {quote.mid.toFixed(digits)}
          </span>
          <span className={cn("tnum font-mono text-[10px]", up ? "text-up" : "text-down")}>
            {up ? "+" : ""}
            {quote.change.toFixed(digits)} ({up ? "+" : ""}
            {quote.changePct.toFixed(2)}%)
          </span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        <ConnectionChip />
        <ThemeCycleButton />
        <LanguageButton />
        <Button
          variant="ghost"
          size="sm"
          className="hidden h-8 w-8 p-0 lg:inline-flex"
          onClick={toggleFullscreen}
          aria-label="fullscreen"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
