"use client";

/** MainNav — the 4 primary tabs (Binance-style), used twice:
 *  • mobile: bottom navigation bar
 *  • desktop: horizontal tab strip under the top bar
 * Same state, same order, same icons — one mental model on every device. */

import { useTerminal, type MainTab } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Home, CandlestickChart, Bot, Settings2 } from "lucide-react";

const TABS: { id: MainTab; icon: any; key: string }[] = [
  { id: "home", icon: Home, key: "tabHome" },
  { id: "chart", icon: CandlestickChart, key: "tabChart" },
  { id: "auto", icon: Bot, key: "tabAutoSignals" },
  { id: "settings", icon: Settings2, key: "tabSettings" },
];

/** desktop: horizontal strip */
export function DesktopTabStrip() {
  const { mainTab, setMainTab } = useTerminal();
  const { t } = useI18n();
  return (
    <nav className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-card/60 px-3" aria-label="primary">
      {TABS.map(({ id, icon: Icon, key }) => {
        const active = mainTab === id;
        return (
          <button
            key={id}
            onClick={() => setMainTab(id)}
            aria-current={active ? "page" : undefined}
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
    </nav>
  );
}

/** mobile: bottom bar (thumb-reachable, safe-area aware) */
export function MobileNav() {
  const { mainTab, setMainTab } = useTerminal();
  const { t } = useI18n();
  return (
    <nav
      className="flex h-16 shrink-0 items-stretch border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      aria-label="primary"
    >
      {TABS.map(({ id, icon: Icon, key }) => {
        const active = mainTab === id;
        return (
          <button
            key={id}
            onClick={() => setMainTab(id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 transition-colors",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                active && "bg-primary/15",
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="whitespace-nowrap text-[10px] font-semibold">{t(key)}</span>
          </button>
        );
      })}
    </nav>
  );
}
