import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

interface KpiTileProps {
  label: string;
  value: ReactNode;
  delta?: { value: string; direction: "up" | "down" | "flat" };
  hint?: ReactNode;
  size?: "md" | "lg" | "xl";
  accent?: "warm" | "good" | "bad" | "cool" | "neutral";
}

const accentMap: Record<NonNullable<KpiTileProps["accent"]>, string> = {
  warm: "text-(--accent-warm)",
  good: "text-(--accent-good)",
  bad: "text-(--accent-bad)",
  cool: "text-(--accent-cool)",
  neutral: "text-(--text-primary)",
};

const sizeMap: Record<NonNullable<KpiTileProps["size"]>, string> = {
  md: "text-2xl",
  lg: "text-3xl",
  xl: "text-(length:--text-3xl)",
};

export function KpiTile({
  label,
  value,
  delta,
  hint,
  size = "lg",
  accent = "neutral",
}: KpiTileProps) {
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
      <div className="text-xs font-medium tracking-wider text-(--text-muted) uppercase">
        {label}
      </div>
      <div
        className={cn(
          "font-display font-semibold leading-none tabular",
          sizeMap[size],
          accentMap[accent],
        )}
      >
        {value}
      </div>
      {(delta || hint) && (
        <div className="flex items-center gap-2 text-xs text-(--text-muted)">
          {delta && (
            <span
              className={cn(
                "tabular",
                delta.direction === "up" && "text-(--accent-good)",
                delta.direction === "down" && "text-(--accent-bad)",
              )}
            >
              {delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "—"}{" "}
              {delta.value}
            </span>
          )}
          {hint}
        </div>
      )}
    </div>
  );
}
