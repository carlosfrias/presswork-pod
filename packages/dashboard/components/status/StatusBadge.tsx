import { cn } from "@/lib/cn";

const COLORS: Record<string, string> = {
  pending: "bg-(--accent-cool)/15 text-(--accent-cool) border-(--accent-cool)/30",
  needs_review: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  approved: "bg-(--accent-good)/15 text-(--accent-good) border-(--accent-good)/30",
  processing: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  done: "bg-(--accent-good)/15 text-(--accent-good) border-(--accent-good)/30",
  error: "bg-(--accent-bad)/15 text-(--accent-bad) border-(--accent-bad)/30",
  pending_publish: "bg-(--accent-warm)/15 text-(--accent-warm) border-(--accent-warm)/30",
  publishing: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  active: "bg-(--accent-good)/15 text-(--accent-good) border-(--accent-good)/30",
  logged: "bg-(--accent-good)/15 text-(--accent-good) border-(--accent-good)/30",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status ?? "unknown";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-medium tabular",
        COLORS[s] ?? "bg-(--surface-2) text-(--text-secondary) border-(--surface-line)",
      )}
    >
      {s}
    </span>
  );
}
