"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRuntimeFlag } from "@/lib/actions/flags";
import { cn } from "@/lib/cn";

interface FlagToggleProps {
  flagKey: string;
  currentValue: unknown;
  description?: string | null;
  /** When the flag is a string-enum, pass the allowed values to render a select. */
  options?: string[];
  /** When the flag is a number, pass step + min/max to render a numeric input. */
  numeric?: { min?: number; max?: number; step?: number };
}

export function FlagToggle({
  flagKey,
  currentValue,
  description,
  options,
  numeric,
}: FlagToggleProps) {
  const isBool = typeof currentValue === "boolean";
  const isEnum = !!options && options.length > 0;
  const isNumber = !isBool && !isEnum && (typeof currentValue === "number" || !!numeric);

  // Bool toggles auto-submit on click — there's no explicit Save step.
  // Enum and numeric keep the Save workflow because the operator may want
  // to back out of a typed value before committing.
  return (
    <div className="flex flex-col gap-2 rounded-(--radius) border border-(--surface-line) bg-(--surface-2) p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-(--text-primary)">{flagKey}</div>
          {description && (
            <div className="mt-0.5 text-xs text-(--text-muted)">{description}</div>
          )}
        </div>
        {isBool && (
          <BoolToggle flagKey={flagKey} initial={currentValue as boolean} />
        )}
        {isEnum && (
          <EnumOrNumberForm flagKey={flagKey}>
            <select
              name="value"
              defaultValue={JSON.stringify(currentValue)}
              className="h-8 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 text-xs text-(--text-primary)"
            >
              {options!.map((opt) => (
                <option key={opt} value={JSON.stringify(opt)}>
                  {opt}
                </option>
              ))}
            </select>
          </EnumOrNumberForm>
        )}
        {isNumber && (
          <EnumOrNumberForm flagKey={flagKey}>
            <input
              type="number"
              name="value"
              step={numeric?.step ?? 0.01}
              min={numeric?.min}
              max={numeric?.max}
              defaultValue={String(currentValue ?? 0)}
              className="h-8 w-24 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 text-right text-xs tabular text-(--text-primary)"
            />
          </EnumOrNumberForm>
        )}
      </div>
    </div>
  );
}

function BoolToggle({
  flagKey,
  initial,
}: {
  flagKey: string;
  initial: boolean;
}) {
  // Optimistic local state: the visible highlight flips immediately on click,
  // then we kick off the server action. If the server roundtrips a different
  // value (revalidatePath in setRuntimeFlag) the parent re-renders with the
  // new `initial` and the sync effect below adopts it.
  const [selected, setSelected] = useState(initial);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setSelected(initial);
  }, [initial]);

  const handleClick = (next: boolean) => {
    if (next === selected || pending) return;
    setSelected(next);
    // Defer the form submit to the next tick so the local state paint lands
    // first — otherwise the optimistic style change can feel laggy on slow
    // server responses.
    startTransition(() => {
      formRef.current?.requestSubmit();
      router.refresh();
    });
  };

  return (
    <form ref={formRef} action={setRuntimeFlag}>
      <input type="hidden" name="key" value={flagKey} />
      <input type="hidden" name="value" value={String(selected)} />
      <div
        role="radiogroup"
        aria-label={flagKey}
        className={cn(
          "flex gap-1 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) p-0.5",
          pending && "opacity-70",
        )}
      >
        <button
          type="button"
          role="radio"
          aria-checked={selected === true}
          onClick={() => handleClick(true)}
          disabled={pending}
          className={cn(
            "cursor-pointer rounded-[6px] px-2 py-1 text-xs transition-colors",
            selected
              ? "bg-(--accent-good)/20 text-(--accent-good)"
              : "text-(--text-muted) hover:text-(--text-primary)",
          )}
        >
          on
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={selected === false}
          onClick={() => handleClick(false)}
          disabled={pending}
          className={cn(
            "cursor-pointer rounded-[6px] px-2 py-1 text-xs transition-colors",
            !selected
              ? "bg-(--accent-bad)/20 text-(--accent-bad)"
              : "text-(--text-muted) hover:text-(--text-primary)",
          )}
        >
          off
        </button>
      </div>
    </form>
  );
}

function EnumOrNumberForm({
  flagKey,
  children,
}: {
  flagKey: string;
  children: React.ReactNode;
}) {
  return (
    <form action={setRuntimeFlag} className="flex items-center gap-2">
      <input type="hidden" name="key" value={flagKey} />
      {children}
      <button
        type="submit"
        className={cn(
          "rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1 text-xs font-medium",
          "hover:bg-(--surface-3) hover:text-(--text-primary)",
        )}
      >
        Save
      </button>
    </form>
  );
}
