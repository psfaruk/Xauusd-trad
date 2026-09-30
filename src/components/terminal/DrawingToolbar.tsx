"use client";

import { cn } from "@/lib/utils";
import { useTerminal, type ToolId } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import {
  MousePointer2,
  TrendingUp,
  MoveUpRight,
  Minus,
  SeparatorVertical,
  Square,
  Percent,
  Type,
  Ruler,
  Eraser,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const TOOLS: { id: ToolId; icon: any; key: string }[] = [
  { id: "cursor", icon: MousePointer2, key: "toolCursor" },
  { id: "trendline", icon: TrendingUp, key: "toolTrendline" },
  { id: "ray", icon: MoveUpRight, key: "toolRay" },
  { id: "hline", icon: Minus, key: "toolHline" },
  { id: "vline", icon: SeparatorVertical, key: "toolVline" },
  { id: "rect", icon: Square, key: "toolRect" },
  { id: "fib", icon: Percent, key: "toolFib" },
  { id: "text", icon: Type, key: "toolText" },
  { id: "measure", icon: Ruler, key: "toolMeasure" },
];

export function DrawingToolbar({
  variant = "vertical",
  onClearAll,
}: {
  variant?: "vertical" | "horizontal";
  onClearAll?: () => void;
}) {
  const { tool, setTool } = useTerminal();
  const { t } = useI18n();

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          "flex gap-0.5 rounded-lg border border-border bg-card/95 p-1 backdrop-blur",
          variant === "vertical"
            ? "flex-col"
            : "flex-row flex-wrap justify-center sm:flex-nowrap",
        )}
        role="toolbar"
        aria-label={t("drawingTools")}
      >
        {TOOLS.map(({ id, icon: Icon, key }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setTool(id)}
                aria-pressed={tool === id}
                aria-label={t(key)}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                  tool === id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={variant === "vertical" ? "right" : "top"} className="text-[10px]">
              {t(key)}
            </TooltipContent>
          </Tooltip>
        ))}
        {onClearAll && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onClearAll}
                aria-label={t("clearDrawings")}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <Eraser className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={variant === "vertical" ? "right" : "top"} className="text-[10px]">
              {t("clearDrawings")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
