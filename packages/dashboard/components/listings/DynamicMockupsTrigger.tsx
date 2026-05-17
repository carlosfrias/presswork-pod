import { dynamicMockupsTemplate } from "@presswork/shared";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { generateDynamicMockups } from "@/lib/actions/listings";

/**
 * Per-listing trigger to swap mockup_urls for a fresh render from Dynamic
 * Mockups. The default mockups come from Printify's product creation; this
 * button is the operator's escape hatch when those don't look right.
 *
 * Server component — reads process.env.DYNAMIC_MOCKUPS_API_KEY directly to
 * decide whether to render the form enabled. Disabled with helper text when:
 *   - DYNAMIC_MOCKUPS_API_KEY is not in .env
 *   - The design has no printify_blueprint_id
 *   - No template is registered in DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT
 *     for that blueprint (operator needs to paste mockup_uuid +
 *     smart_object_uuid in dynamic-mockups.ts)
 *
 * Used on the listings detail page AND inline inside ReviewCard so the
 * option shows wherever the operator is reviewing or editing a listing.
 */
export function DynamicMockupsTrigger({
  listingId,
  blueprintId,
}: {
  listingId: string;
  blueprintId: number | null;
}) {
  const template = blueprintId ? dynamicMockupsTemplate(blueprintId) : undefined;
  const apiKeyConfigured = Boolean(process.env.DYNAMIC_MOCKUPS_API_KEY);
  const helper = !apiKeyConfigured
    ? "DYNAMIC_MOCKUPS_API_KEY is not set in .env."
    : !blueprintId
      ? "Design has no printify_blueprint_id."
      : !template
        ? `No template registered for blueprint ${blueprintId}. Add one to dynamic-mockups.ts.`
        : "Replaces mockup_urls with a fresh render from Dynamic Mockups.";

  const enabled = apiKeyConfigured && Boolean(template);

  return (
    <form
      action={generateDynamicMockups}
      className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) p-3"
    >
      <input type="hidden" name="id" value={listingId} />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-(--text-primary)">
            Generate Dynamic Mockups
          </p>
          <p className="text-xs text-(--text-muted)">{helper}</p>
        </div>
        <SubmitButton
          variant="secondary"
          size="sm"
          idleLabel="Generate"
          pendingLabel="Rendering…"
          disabled={!enabled}
        />
      </div>
    </form>
  );
}
