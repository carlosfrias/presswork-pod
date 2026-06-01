"use client";

import { cn } from "@/lib/cn";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/scout", label: "Scout" },
  { href: "/builder", label: "Builder" },
  { href: "/design", label: "Design" },
  { href: "/listings", label: "Listings" },
  { href: "/ledger", label: "Ledger" },
  { href: "/errors", label: "Errors" },
] as const;

export function Nav({ email }: { email: string }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 border-b border-(--surface-line) bg-(--surface-0)/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="font-display text-sm font-semibold tracking-wide text-(--text-primary)">
            <span className="text-(--accent-warm)">Presswork</span>{" "}
          </span>
          <nav className="flex gap-1">
            {ITEMS.map((it) => {
              const active =
                it.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={cn(
                    "rounded-(--radius-sm) px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-(--surface-2) text-(--text-primary)"
                      : "text-(--text-muted) hover:text-(--text-primary) hover:bg-(--surface-2)",
                  )}
                >
                  {it.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-(--text-muted)">
          <span className="hidden sm:inline">{email}</span>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-(--radius-sm) px-2 py-1 hover:bg-(--surface-2) hover:text-(--text-primary)"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
