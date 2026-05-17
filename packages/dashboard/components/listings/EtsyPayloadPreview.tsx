import type { EtsyPayloadPreview as Preview } from "@/lib/queries/etsy-preview";

/**
 * Renders the full set of Etsy payloads that would be sent on approval —
 * createDraftListing body, updateListingInventory body, per-image upload
 * facts, and the activate PATCH. Highlights mock-mode status so the
 * operator knows whether this would hit real Etsy.
 *
 * The component itself is pure; data is assembled server-side by
 * getEtsyPayloadPreview() and passed in.
 */
export function EtsyPayloadPreview({ preview }: { preview: Preview }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-(--radius-sm) px-2 py-0.5 text-xs font-mono ${
            preview.mockMode
              ? "bg-(--accent-warm)/15 text-(--accent-warm)"
              : "bg-(--accent-bad)/15 text-(--accent-bad)"
          }`}
        >
          {preview.mockMode ? "ETSY_MOCK_MODE = true" : "ETSY_MOCK_MODE = false"}
        </span>
        <span className="text-xs text-(--text-muted)">
          {preview.mockMode
            ? "Approval will hit canned fixtures, not Etsy."
            : "Approval will hit real Etsy."}
        </span>
      </div>

      {!preview.ok ? (
        <p className="text-sm text-(--accent-bad)">
          Preview unavailable: {preview.reason ?? "unknown"}
        </p>
      ) : (
        <>
          <PayloadBlock
            label="POST /v3/application/shops/{shop_id}/listings"
            body={preview.createListing}
          />
          <PayloadBlock
            label="PUT /v3/application/listings/{listing_id}/inventory"
            body={preview.inventory}
          />
          <PayloadBlock
            label="POST /v3/application/shops/{shop_id}/listings/{listing_id}/images (×N)"
            body={preview.images}
          />
          <PayloadBlock
            label="PATCH /v3/application/shops/{shop_id}/listings/{listing_id}"
            body={preview.activate}
          />
        </>
      )}
    </div>
  );
}

function PayloadBlock({ label, body }: { label: string; body: unknown }) {
  return (
    <details className="rounded-(--radius-sm) border border-(--surface-line)">
      <summary className="cursor-pointer p-2 text-xs text-(--text-secondary) font-mono">
        {label}
      </summary>
      <pre className="overflow-x-auto border-t border-(--surface-line) bg-(--surface-2) p-3 text-xs text-(--text-primary)">
        {JSON.stringify(body, null, 2)}
      </pre>
    </details>
  );
}
