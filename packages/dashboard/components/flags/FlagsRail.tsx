import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { FlagToggle } from "./FlagToggle";
import { getRuntimeFlags } from "@/lib/queries/overview";
import type { ReactNode } from "react";

interface FlagsRailProps {
  /** Show only these flag keys; if omitted, shows all. */
  keys?: string[];
  title?: string;
  emptyHint?: ReactNode;
}

const NUMERIC = new Set(["margin_warning_threshold_usd"]);
const ENUMS: Record<string, string[]> = {
  // Two-way background-removal selector. Both are fal.ai-hosted, same I/O.
  // "bria" is the current default (commercially-licensed training data,
  // ~$0.018/call); "birefnet" is the matting-quality alternative.
  background_removal_mode: ["bria", "birefnet"],
};

export async function FlagsRail({ keys, title = "Flags", emptyHint }: FlagsRailProps) {
  const flags = await getRuntimeFlags();
  const filtered = keys ? flags.filter((f) => keys.includes(f.key)) : flags;

  if (filtered.length === 0) {
    return (
      <SurfaceCard title={title}>
        <p className="text-xs text-(--text-muted)">{emptyHint ?? "No flags defined."}</p>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard title={title}>
      <div className="flex flex-col gap-3">
        {filtered.map((f) => (
          <FlagToggle
            key={f.key}
            flagKey={f.key}
            currentValue={f.value}
            description={f.description}
            options={ENUMS[f.key]}
            numeric={NUMERIC.has(f.key) ? { step: 0.5, min: 0 } : undefined}
          />
        ))}
      </div>
    </SurfaceCard>
  );
}
