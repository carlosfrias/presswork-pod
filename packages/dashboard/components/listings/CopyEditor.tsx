"use client";

import { useState } from "react";
// Import from the leaf "./constants" entry, NOT the package root. The root
// barrel re-exports modules that pull in pino → node:fs, which webpack can't
// bundle for the browser. This path is constants-only and tree-shake-safe.
import { AI_DISCLOSURE_TEXT } from "@presswork/shared/constants";
import { Button } from "@/components/ui/Button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import {
  updateActiveListingCopy,
  updateListingCopy,
} from "@/lib/actions/listings";
import { cn } from "@/lib/cn";

const TITLE_MAX = 140;
const TAGS_MAX = 13;
const TAG_LEN_MAX = 20;
// Mirrors GILDAN_64000_PRINT_COST_USD * 2.5 from the listing constants.
// Inlined here for the live floor-check display; the server action is the
// authoritative gate.
const DEFAULT_PRINT_COST_USD = 8.5;
const PRICING_FLOOR_MULTIPLIER = 2.5;

interface CopyEditorProps {
  listingId: string;
  initialTitle: string | null;
  initialDescription: string | null;
  initialTags: string[] | null;
  initialPriceUsd?: number | null;
  /**
   * Per-blueprint print cost used for the live floor check on the price
   * input. Defaults to Gildan 64000. The server action also enforces the
   * floor — this prop only drives the UI hint.
   */
  printCostUsd?: number;
  /** Compact rendering for inline use inside ReviewCard. */
  compact?: boolean;
  /**
   * "needs_review" → Save writes the listings row only; no Etsy call.
   *   This is the pre-publish flow.
   * "active" → Save writes the listings row only; a separate "Push to Etsy"
   *   button on the page handles the API call. Renders a banner explaining
   *   the two-step Save → Push UX so the operator isn't surprised that Save
   *   alone doesn't update the live listing.
   * "error" → Same backend as needs_review (updateListingCopy accepts both).
   *   Lets the operator fix the copy that broke the publisher (long tags,
   *   forbidden terms, low price) without first regenerating from Claude.
   */
  mode?: "needs_review" | "active" | "error";
  /**
   * When provided, renders an "Approve & publish" button inside this form
   * that submits via formAction to the given server action. This ensures any
   * unsaved edits are included when the operator approves — no separate Save
   * step required.
   */
  approveAction?: (formData: FormData) => Promise<void>;
}

/**
 * Inline editor for listing copy. Saves through a server action that runs
 * the same shared validators the publisher does — so the Save button
 * represents "this would publish" not just "this got persisted".
 *
 * Live counters and an AI-disclosure indicator give the operator immediate
 * feedback without waiting for a round-trip. Server-side validation is still
 * authoritative; client checks are advisory.
 */
export function CopyEditor({
  listingId,
  initialTitle,
  initialDescription,
  initialTags,
  initialPriceUsd = null,
  printCostUsd = DEFAULT_PRINT_COST_USD,
  compact = false,
  mode = "needs_review",
  approveAction,
}: CopyEditorProps) {
  // Active listings push edits to Etsy via a separate action; everything else
  // (needs_review + error) routes to the same updateListingCopy that gates
  // on either status.
  const action =
    mode === "active" ? updateActiveListingCopy : updateListingCopy;
  const initialTagsString = (initialTags ?? []).join(", ");
  const initialPriceString = initialPriceUsd != null ? String(initialPriceUsd) : "";
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [tagsString, setTagsString] = useState(initialTagsString);
  const [priceString, setPriceString] = useState(initialPriceString);

  const tags = tagsString
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const titleOver = title.length > TITLE_MAX;
  const titleAllCaps = title.length > 1 && title === title.toUpperCase();
  const tooManyTags = tags.length > TAGS_MAX;
  const longTags = tags.filter((t) => t.length > TAG_LEN_MAX);
  const hasDisclosure = description.includes(AI_DISCLOSURE_TEXT);
  const priceFloor = printCostUsd * PRICING_FLOOR_MULTIPLIER;
  const priceParsed = priceString.trim() === "" ? null : Number(priceString);
  const priceBelowFloor =
    priceParsed != null && Number.isFinite(priceParsed) && priceParsed < priceFloor;
  const dirty =
    title !== (initialTitle ?? "") ||
    description !== (initialDescription ?? "") ||
    tagsString !== initialTagsString ||
    priceString !== initialPriceString;

  function reset() {
    setTitle(initialTitle ?? "");
    setDescription(initialDescription ?? "");
    setTagsString(initialTagsString);
    setPriceString(initialPriceString);
  }

  function appendDisclosure() {
    setDescription((prev) => {
      const trimmed = prev.trimEnd();
      const sep = trimmed.length > 0 ? " " : "";
      return `${trimmed}${sep}${AI_DISCLOSURE_TEXT}`;
    });
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={listingId} />

      {mode === "active" && (
        <p className="rounded-(--radius-sm) border border-(--accent-warm)/40 bg-(--accent-warm)/10 px-3 py-2 text-xs leading-relaxed text-(--accent-warm)">
          This is a live Etsy listing. Save updates the dashboard only — use
          the Push to Etsy button below to send the changes to the live
          listing.
        </p>
      )}
      {mode === "error" && (
        <p className="rounded-(--radius-sm) border border-(--accent-bad)/30 bg-(--accent-bad)/5 px-3 py-2 text-xs leading-relaxed text-(--text-secondary)">
          This listing failed validation. Fix the copy or price below and Save
          (this clears the error_message). Then click Retry from error to put
          it back in the queue.
        </p>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor={`title-${listingId}`} className="text-xs text-(--text-muted)">
            Title
          </label>
          <span
            className={cn(
              "tabular text-xs",
              titleOver ? "text-(--accent-bad)" : "text-(--text-muted)",
            )}
          >
            {title.length}/{TITLE_MAX}
            {titleAllCaps && (
              <span className="ml-2 text-(--accent-bad)">all-caps</span>
            )}
          </span>
        </div>
        <input
          id={`title-${listingId}`}
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1.5 text-sm text-(--text-primary)"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label
            htmlFor={`description-${listingId}`}
            className="text-xs text-(--text-muted)"
          >
            Description
          </label>
          <span className="flex items-center gap-2 text-xs">
            {hasDisclosure ? (
              <span className="tabular text-(--accent-good)">
                AI disclosure ✓
              </span>
            ) : (
              <span className="tabular text-(--text-muted)">
                AI disclosure auto-appended on save
              </span>
            )}
            {!hasDisclosure && (
              <button
                type="button"
                onClick={appendDisclosure}
                className="rounded-(--radius-sm) bg-(--surface-2) px-2 py-0.5 text-xs text-(--text-secondary) hover:text-(--text-primary)"
                title="Add the disclosure to the textarea now (preview); save also auto-appends if you don't."
              >
                Add now
              </button>
            )}
          </span>
        </div>
        <textarea
          id={`description-${listingId}`}
          name="description"
          rows={compact ? 5 : 8}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1.5 text-sm text-(--text-primary) leading-relaxed"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor={`tags-${listingId}`} className="text-xs text-(--text-muted)">
            Tags (comma-separated)
          </label>
          <span
            className={cn(
              "tabular text-xs",
              tooManyTags || longTags.length > 0
                ? "text-(--accent-bad)"
                : "text-(--text-muted)",
            )}
          >
            {tags.length}/{TAGS_MAX}
            {longTags.length > 0 && (
              <span className="ml-2">
                {longTags.length} over {TAG_LEN_MAX} chars
              </span>
            )}
          </span>
        </div>
        <input
          id={`tags-${listingId}`}
          name="tags"
          value={tagsString}
          onChange={(e) => setTagsString(e.target.value)}
          className="w-full rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1.5 text-sm text-(--text-primary) font-mono"
        />
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t, i) => (
              <span
                key={`${t}-${i}`}
                className={cn(
                  "rounded-(--radius-sm) px-2 py-0.5 text-xs",
                  t.length > TAG_LEN_MAX
                    ? "bg-(--accent-bad)/15 text-(--accent-bad)"
                    : "bg-(--surface-2) text-(--text-secondary)",
                )}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor={`price-${listingId}`} className="text-xs text-(--text-muted)">
            Price (USD)
          </label>
          <span
            className={cn(
              "tabular text-xs",
              priceBelowFloor ? "text-(--accent-bad)" : "text-(--text-muted)",
            )}
          >
            floor ${priceFloor.toFixed(2)} (print cost ${printCostUsd.toFixed(2)} × {PRICING_FLOOR_MULTIPLIER})
          </span>
        </div>
        <input
          id={`price-${listingId}`}
          name="price"
          type="number"
          step="0.01"
          min="0"
          value={priceString}
          onChange={(e) => setPriceString(e.target.value)}
          placeholder={initialPriceString || "24.99"}
          className={cn(
            "w-full rounded-(--radius-sm) border bg-(--surface-1) px-2 py-1.5 text-sm tabular text-(--text-primary)",
            priceBelowFloor
              ? "border-(--accent-bad)/40"
              : "border-(--surface-line)",
          )}
        />
        {priceBelowFloor && (
          <p className="mt-1 text-xs text-(--accent-bad)">
            Below floor — Save will be rejected.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {approveAction && (
          <SubmitButton
            // formAction overrides the form's default action for this button
            // only — submits all copy fields + id to approveListingWithCopy so
            // unsaved edits are never silently discarded on approve.
            formAction={approveAction}
            variant="primary"
            size={compact ? "sm" : "md"}
            idleLabel="Approve & publish"
            pendingLabel="Approving…"
            disabled={priceBelowFloor}
          />
        )}
        <SubmitButton
          variant="secondary"
          size={compact ? "sm" : "md"}
          idleLabel="Save edits"
          pendingLabel="Saving…"
          disabled={!dirty || priceBelowFloor}
        />
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            size={compact ? "sm" : "md"}
            onClick={reset}
          >
            Reset
          </Button>
        )}
        {!dirty && (
          <span className="text-xs text-(--text-faint)">No unsaved changes</span>
        )}
      </div>
    </form>
  );
}
