import type { ReactNode } from "react";

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm text-(--text-secondary)">{title}</p>
      {hint && <p className="text-xs text-(--text-muted)">{hint}</p>}
    </div>
  );
}
