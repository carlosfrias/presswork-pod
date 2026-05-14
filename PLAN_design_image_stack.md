# Plan — Design Image Stack + Reopen

Branch off `main`. One PR.

## Problem

Each Design row has exactly one masked + one unmasked image. Every full Regen overwrites both at constant storage paths (`{id}.png`, `{id}-unmasked.png`). The operator can't step back to a prior generation they liked better — they have to pay for a full regen and hope the model returns to that direction.

After approval, the only way to "tweak settings" on an approved design is `Regenerate`, which throws away the chosen image and runs a fresh agent pass. There's no zero-cost path to re-enter the review queue.

## Decisions (locked)

1. **Stack lives in `design_packages.metadata.image_versions`** — the existing JSONB array used by hand-edit replace (`kind: "ai_original" | "hand_edit"`). Add a new `kind: "regen"` for AI-generated iterations. Keeps all iteration history in one place; no new column needed.
2. **Each entry stores both masked + unmasked URLs**, plus a snapshot of the prompt + image_model + image_quality + bg_removal_mode in effect at generation time. Lets the operator see *why* each version differs.
3. **Backfill on first interaction**: when the Python agent writes a new iteration, if `image_versions` is empty AND the row has a current `image_url`, prepend a `kind: "regen"` entry capturing the existing pair (using the row's current `fal_prompt` etc.) before appending the new one. No SQL backfill — older designs only grow a stack when they're regenerated.
4. **Reopen refuses** if any listing referencing this design is in a non-error status. Mirrors the existing `deleteDesign` guard. Operator must reject the listing first.
5. **UI**: prev/next arrows + counter (`3 / 5`) overlaid on the image. Arrow keys when the card has focus. No thumbnail strip.

## Schema

No SQL migration. The `metadata` JSONB column already exists (used by `replaceDesignImage`). New entry shape extends the existing `ImageVersion` type:

```ts
type ImageVersion =
  | { url: string; kind: "ai_original" | "hand_edit"; uploaded_at: string; uploaded_by?: string }
  | {
      kind: "regen";
      masked_url: string;          // current image_url at the moment this iteration completed
      unmasked_url: string | null; // current image_url_unmasked; null for legacy/no-bg-removal flows
      created_at: string;          // ISO timestamp
      prompt: string | null;       // fal_prompt at generation time
      image_model: string | null;  // e.g. "fal_gpt_image_2"
      image_quality: string | null;// "low"|"medium"|"high" or null for FLUX
      bg_removal_mode: string | null;
    };
```

Existing readers of `metadata.image_versions` (only `replaceDesignImage` reads it today) keep working — we discriminate by `kind`. A new helper `extractRegenStack()` filters to the regen entries for the UI.

## Files to change

### Python — `packages/design/`

- **`storage.py`** — Add a `versioned: bool = False` parameter to `upload_design`. When true, the storage path becomes `{design_id}-{iso-timestamp}-{rand}.png` (and `…-unmasked.png` for the unmasked variant). Returns the public URL as today. Keeps the legacy non-versioned path as the default so other callers don't change.
- **`main.py`** — In the post-image-gen DB write (where `image_url` and `image_url_unmasked` get persisted at the end of a successful Design run):
  1. Upload BOTH the new masked and the new unmasked using `versioned=True` so previous PNGs in storage are not overwritten.
  2. Read the row's current `metadata` and `image_url` / `image_url_unmasked` / `fal_prompt` etc. *before* the write.
  3. Build the new `metadata.image_versions` array:
     - If empty AND the row already has an `image_url`, push a backfill entry capturing the previous pair (kind=`regen`, with whatever prompt/model/quality the row currently has).
     - Push the new iteration entry (kind=`regen`, with the just-uploaded URLs and the prompt/model/quality the agent just used).
     - Cap at last N (suggest **N=8**) to keep the metadata blob bounded; older entries drop off the front. Their storage objects stay in the bucket — we accept the slow leak; storage cost is negligible vs. agent cost. (A future cleanup cron can sweep.)
  4. Write `image_url`, `image_url_unmasked`, `metadata` together so the row's "current pointer" matches the latest stack entry.
- **`main.py` — re-mask path** — Re-mask reuses the existing unmasked, only producing a new masked. It does **not** add a new stack entry (this matches the user's "stack of unmasked" framing — re-mask doesn't change the unmasked). Instead, re-mask just overwrites `image_url` as it does today. The currently-pointed stack entry's `masked_url` would now diverge from `image_url`, so re-mask additionally rewrites the *current* (most-recent) stack entry's `masked_url` to point at the new mask. This keeps "step back to here = restore both URLs" coherent.

### TypeScript — `packages/dashboard/`

- **`lib/queries/types.ts`** — Add `ImageVersion` type union exported alongside `DesignPackageRow`. The shared shape used by both server queries and client cards.
- **`lib/queries/design.ts`** — `DesignReviewItem` already gets `metadata` via `select *`. Add a derived `regen_stack: ImageVersion[]` projection (newest-last, filtered to `kind === "regen"`) so the card doesn't have to discriminate.
- **`components/design/DesignReviewCard.tsx`** — Replace the masked/pre-mask toggle UI with a stack-aware viewer:
  - Internal state: `stackIndex` (default = stack length - 1, i.e. newest), `showMask` (still toggles between unmasked/masked of the *current* stack entry).
  - Prev/Next arrow buttons overlaid on the image; counter `n / total` in the corner. Disabled at edges.
  - Keyboard: `ArrowLeft` / `ArrowRight` when the image button has focus (or use a wrapping `div` with `tabIndex={0}` and key handler).
  - The displayed image becomes `stack[stackIndex].masked_url` or `unmasked_url` based on `showMask`.
  - The mask-flip button only enables when the active entry has a non-null `unmasked_url`.
  - "Approve" submits the *currently displayed* stack entry's masked_url as the canonical image_url. Action: see `approveDesign` change below.
  - "Re-mask only" runs against the currently displayed entry's `unmasked_url` — passes a new `version_index` field so the server knows which entry to re-mask from.
  - Show the per-iteration prompt/model snapshot in a small caption under the image when stepping through history (read-only — not the editable textarea).
- **`lib/actions/design.ts`**:
  - `approveDesign` — accept optional `version_index` form field. If present, look up the indexed entry in `metadata.image_versions` and write its `masked_url` / `unmasked_url` to `image_url` / `image_url_unmasked` *before* the status flip to `approved`. Atomic in a single update. If absent, behave as today (approve current pointer).
  - `remaskDesign` — accept optional `version_index`. If present, copy that entry's `unmasked_url` into the row's `image_url_unmasked` first, so the Python re-mask sweep operates on the chosen historical unmasked. (Without this, re-mask would always run against the row's current `image_url_unmasked`, ignoring the operator's stack selection.)
  - **New `reopenDesign(formData)` action**:
    - Status guard: refuse unless `design.status === 'approved'`.
    - Listing guard: count listings where `design_package_id = id AND status != 'error'`. Refuse with a clear message if any exist.
    - Update: `status = 'needs_review'`, `error_message = null`. No agent spawn. No image clearing. No metadata changes.
    - `revalidatePath('/design')`, `revalidatePath('/listings')`.
- **`components/design/DesignGrid.tsx`** — When `d.status === 'approved'`, render `Reopen` instead of `Regenerate`. Small text on hover/title: "Move back to review without regenerating." Keep the `Regenerate` button for all other statuses (pending / error / needs_review / done).
- **`lib/queries/types.ts`** — `DesignPackageRow.metadata` is already typed as `unknown` / Json; add an `image_versions?: ImageVersion[]` narrowing helper used by callers.

### Tests

- **Python (`packages/design/test_main.py`)**:
  - Versioned storage path: two consecutive runs produce two distinct objects in storage.
  - Stack append: after second regen on the same row, `metadata.image_versions` has 2 entries (or 3 if backfill kicked in for legacy state); newest entry's URLs match the row's current `image_url` / `image_url_unmasked`.
  - Stack cap at N=8: simulating 10 sequential regens trims to the most recent 8 entries.
  - Re-mask updates the most-recent entry's `masked_url` rather than appending.
- **TypeScript (`packages/dashboard/lib/actions/design.test.ts` if it exists, else add)**:
  - `approveDesign` with `version_index` rewrites `image_url` / `image_url_unmasked` to the indexed entry, then flips to `approved` (single update, status guard intact).
  - `approveDesign` without `version_index` behaves identically to today.
  - `reopenDesign` happy path: approved → needs_review.
  - `reopenDesign` refuses when status != approved.
  - `reopenDesign` refuses when a non-error listing references the design.
  - `reopenDesign` allowed when only error-status listings reference the design.

## Out of scope (for this PR)

- Storage cleanup of dropped-off stack entries (>N=8). Accept the slow leak.
- Sharing stack across designs / cross-design version comparison.
- Editing past-iteration prompts in place (snapshots are read-only; user has to regen to make a new entry).
- A "delete this version" button. Could be added later; for now the cap handles it.

## Rollout

- No schema migration → no `supabase db push` needed.
- Non-breaking for existing designs: stack is empty until the next regen, at which point the backfill seeds it with the current pair before adding the new one.
- Re-running an in-flight design while this PR is deploying is safe — the Python `versioned=True` flag is the only behavior change in storage; if a row was mid-write under the old code path, the new code overwrites it cleanly on the next run.
