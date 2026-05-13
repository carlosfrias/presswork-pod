import { cn } from "@/lib/cn";
import type { HTMLAttributes, ReactNode } from "react";

interface SurfaceCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  level?: 1 | 2;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}

export function SurfaceCard({
  level = 1,
  title,
  subtitle,
  action,
  className,
  children,
  ...rest
}: SurfaceCardProps) {
  const bg = level === 1 ? "bg-(--surface-1)" : "bg-(--surface-2)";
  return (
    <section
      className={cn(
        "rounded-(--radius-lg) border border-(--surface-line)",
        bg,
        "p-5",
        className,
      )}
      {...rest}
    >
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-medium tracking-wide text-(--text-secondary) uppercase">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-xs text-(--text-muted)">{subtitle}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
