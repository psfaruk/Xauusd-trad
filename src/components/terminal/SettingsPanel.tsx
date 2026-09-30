"use client";

/** SettingsPanel — appearance, language, data diagnostics, about.
 *
 *  Binance-style settings: every option is a full-width row with a clear
 *  label + current value; the theme picker supports all 3 modes
 *  (dark / light / system) with instant preview.
 */

import { useTheme } from "next-themes";
import { useStatus } from "@/hooks/useFeed";
import { useI18n, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sun, Moon, MonitorSmartphone, Languages, Database, Info, RefreshCw } from "lucide-react";

const THEMES = [
  { value: "dark", icon: Moon, key: "themeDark" },
  { value: "light", icon: Sun, key: "themeLight" },
  { value: "system", icon: MonitorSmartphone, key: "themeSystem" },
] as const;

export function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();
  const status = useStatus();

  return (
    <div className="slim-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        {/* ── appearance ── */}
        <Card className="border-border bg-card">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Sun className="h-3.5 w-3.5 text-primary" />
              {t("appearance")}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-3">
            <div className="mb-2 text-[11px] text-muted-foreground">{t("themeMode")}</div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("themeMode")}>
              {THEMES.map(({ value, icon: Icon, key }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTheme(value)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-[11px] font-semibold transition-colors",
                      active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {t(key)}
                  </button>
                );
              })}
            </div>

            <div className="mb-2 mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Languages className="h-3.5 w-3.5" />
              {t("language")}
            </div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("language")}>
              {([["en", "English"], ["bn", "বাংলা"]] as [Locale, string][]).map(([v, label]) => {
                const active = locale === v;
                return (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setLocale(v)}
                    className={cn(
                      "rounded-lg border p-2.5 text-[11px] font-semibold transition-colors",
                      active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── data & connection ── */}
        <Card className="border-border bg-card">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Database className="h-3.5 w-3.5 text-primary" />
              {t("dataConnection")}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-1">
            {[
              [t("dataSource"), status?.source === "mt5" ? "MetaTrader 5 (direct WS)" : status?.source === "sim" ? t("simulated") : "—"],
              [t("server"), status?.server ?? "Exness-MT5Trial6"],
              [t("connection"), status?.connected ? t("live") : t("connecting")],
              [t("latency"), status?.latencyMs != null ? `${status.latencyMs} ms` : "—"],
              [t("symbolsWatched"), String(status?.symbols ?? "—")],
              [t("serverTime"), status ? `${new Date(status.serverTime * 1000).toISOString().slice(11, 19)} UTC` : "—"],
            ].map(([k, v], i, arr) => (
              <div
                key={k as string}
                className={cn(
                  "flex items-center justify-between py-2 text-[11px]",
                  i < arr.length - 1 && "border-b border-border/60",
                )}
              >
                <span className="text-muted-foreground">{k}</span>
                <span className="tnum font-mono font-semibold text-foreground">{v}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 py-2 text-[10px] text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
              {t("liveSocketNote")}
            </div>
          </CardContent>
        </Card>

        {/* ── about ── */}
        <Card className="border-border bg-card">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Info className="h-3.5 w-3.5 text-primary" />
              {t("about")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 py-3 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>AURUM Terminal</span>
              <span className="font-mono text-foreground">v2.0 · Binance edition</span>
            </div>
            <div className="flex items-center justify-between">
              <span>{t("brainModel")}</span>
              <span className="font-mono text-foreground">GLM (LLM judge)</span>
            </div>
            <div>{t("aboutNote")}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
