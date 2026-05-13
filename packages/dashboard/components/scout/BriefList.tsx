import { BriefListItem } from "@/components/scout/BriefListItem";
import { EmptyState } from "@/components/ui/EmptyState";
import type { TrendBriefRow } from "@/lib/queries/types";

export function BriefList({ briefs }: { briefs: TrendBriefRow[] }) {
  if (briefs.length === 0) {
    return <EmptyState title="No briefs yet" hint="Scout runs at 02:00 UTC." />;
  }
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {briefs.map((b) => (
        <BriefListItem key={b.id} brief={b} />
      ))}
    </ul>
  );
}
