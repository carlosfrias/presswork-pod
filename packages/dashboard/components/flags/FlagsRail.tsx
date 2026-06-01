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
// Copy generation no longer has a selectable model — it always uses the latest
// flagship Claude (see COPYWRITER_MODEL in packages/listing/src/copywriter.ts),
// so there is intentionally no copywriter_model enum here.
const ENUMS: Record<string, string[]> = {};

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
