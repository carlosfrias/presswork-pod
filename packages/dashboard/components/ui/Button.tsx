import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success";
  size?: "sm" | "md";
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-(--radius-sm) font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const sizes = {
    sm: "h-7 px-3 text-xs",
    md: "h-9 px-4 text-sm",
  } as const;
  const variants = {
    primary:
      "bg-(--accent-warm) text-(--surface-0) hover:bg-(--accent-warn) focus-visible:ring-(--accent-warm)",
    secondary:
      "bg-(--surface-2) text-(--text-primary) border border-(--surface-line) hover:bg-(--surface-3)",
    ghost:
      "text-(--text-secondary) hover:bg-(--surface-2) hover:text-(--text-primary)",
    danger:
      "bg-(--accent-bad) text-(--surface-0) hover:opacity-90",
    success:
      "bg-(--accent-good) text-(--surface-0) hover:opacity-90 focus-visible:ring-(--accent-good)",
  } as const;
  return (
    <button
      className={cn(base, sizes[size], variants[variant], className)}
      {...rest}
    />
  );
}
