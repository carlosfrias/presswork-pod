"use client";

import { useState, useCallback } from "react";
import type { EtsyListingImage } from "@presswork/shared";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Button } from "@/components/ui/Button";

// ── Types ──────────────────────────────────────────────────────────────────────

// Single source of truth lives in @presswork/shared; alias keeps local usages terse
// and prevents the panel's shape from silently diverging from the API response.
type EtsyImage = EtsyListingImage;

interface EtsyImagePanelProps {
  /** Internal UUID of the listing row in our DB. */
  listingId: string;
  /** Numeric Etsy listing ID. Panel is only rendered when this is set. */
  etsyListingId: number;
  /** URL of the design PNG stored in Supabase Storage. */
  designImageUrl: string | null;
  /** Array of Printify mockup CDN URLs. */
  mockupUrls: string[] | null;
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchImages(listingId: string): Promise<EtsyImage[]> {
  const res = await fetch(`/api/listings/${listingId}/etsy-images`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const msg =
      data !== null &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const json: unknown = await res.json();
  if (
    typeof json !== "object" ||
    json === null ||
    !("images" in json) ||
    !Array.isArray((json as { images: unknown }).images)
  ) {
    throw new Error("Unexpected response shape from /etsy-images");
  }
  return (json as { images: EtsyImage[] }).images;
}

async function addImage(
  listingId: string,
  imageUrl: string
): Promise<void> {
  const res = await fetch(`/api/listings/${listingId}/etsy-images`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl }),
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const msg =
      data !== null &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
}

async function removeImage(
  listingId: string,
  imageId: number
): Promise<void> {
  const res = await fetch(
    `/api/listings/${listingId}/etsy-images/${imageId}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const msg =
      data !== null &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface LiveImageRowProps {
  image: EtsyImage;
  onDelete: (imageId: number) => Promise<void>;
}

function LiveImageRow({ image, onDelete }: LiveImageRowProps) {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDeleteClick = useCallback(() => {
    setConfirming(true);
  }, []);

  const handleConfirm = useCallback(async () => {
    setConfirming(false);
    setPending(true);
    setError(null);
    try {
      await onDelete(image.listing_image_id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setPending(false);
    }
  }, [image.listing_image_id, onDelete]);

  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  return (
    <li className="flex items-center gap-3 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) p-2">
      {/* Thumbnail */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url_570xN}
        alt={image.alt_text ?? `Etsy image rank ${image.rank}`}
        className="h-14 w-14 shrink-0 rounded-(--radius-sm) object-cover"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-(--text-muted)">Rank {image.rank}</p>
        {image.alt_text && (
          <p className="mt-0.5 truncate text-xs text-(--text-secondary)">
            {image.alt_text}
          </p>
        )}
        {error && (
          <p className="mt-0.5 text-xs text-(--accent-bad)">{error}</p>
        )}
      </div>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="danger"
            size="sm"
            onClick={handleConfirm}
            aria-label={`Confirm delete of Etsy image rank ${image.rank}`}
          >
            Confirm
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCancel}
            aria-label="Cancel delete"
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="danger"
          size="sm"
          onClick={handleDeleteClick}
          disabled={pending}
          aria-label={`Delete Etsy image rank ${image.rank}`}
        >
          {pending ? "Deleting…" : "Delete"}
        </Button>
      )}
    </li>
  );
}

const ETSY_IMAGE_LIMIT = 10;

interface AvailableImageRowProps {
  url: string;
  label: string;
  atLimit: boolean;
  onAdd: (url: string) => Promise<void>;
}

function AvailableImageRow({ url, label, atLimit, onAdd }: AvailableImageRowProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await onAdd(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setPending(false);
    }
  }, [url, onAdd]);

  return (
    <li className="flex items-center gap-3 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={label}
        className="h-14 w-14 shrink-0 rounded-(--radius-sm) object-cover"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-(--text-secondary)">{label}</p>
        {error && (
          <p className="mt-0.5 text-xs text-(--accent-bad)">{error}</p>
        )}
      </div>
      <Button
        variant="success"
        size="sm"
        onClick={handleAdd}
        disabled={pending || atLimit}
        aria-label={`Add ${label} to Etsy listing`}
      >
        {pending ? "Adding…" : "Add to Etsy"}
      </Button>
    </li>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function EtsyImagePanel({
  listingId,
  designImageUrl,
  mockupUrls,
}: EtsyImagePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [liveImages, setLiveImages] = useState<EtsyImage[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Build the available sources list: design PNG first, then mockups.
  const availableSources: Array<{ url: string; label: string }> = [];
  if (designImageUrl) {
    availableSources.push({ url: designImageUrl, label: "Design PNG" });
  }
  (mockupUrls ?? []).forEach((url, i) => {
    availableSources.push({ url, label: `Mockup ${i + 1}` });
  });

  // True once we know the live count is at the Etsy maximum.
  const atLimit = liveImages !== null && liveImages.length >= ETSY_IMAGE_LIMIT;

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const images = await fetchImages(listingId);
      setLiveImages(images);
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : "Failed to load images");
    } finally {
      setLoading(false);
    }
  }, [listingId]);

  const handleExpand = useCallback(async () => {
    if (!expanded) {
      setExpanded(true);
      await load();
    } else {
      setExpanded(false);
    }
  }, [expanded, load]);

  const handleDelete = useCallback(
    async (imageId: number) => {
      await removeImage(listingId, imageId);
      // Optimistic: remove from local list immediately, then re-fetch for
      // accurate rank ordering after Etsy reassigns ranks.
      await load();
    },
    [listingId, load]
  );

  const handleAdd = useCallback(
    async (imageUrl: string) => {
      await addImage(listingId, imageUrl);
      await load();
    },
    [listingId, load]
  );

  return (
    <SurfaceCard
      title="Etsy listing images"
      subtitle="Images currently live on Etsy and available sources from your design files."
    >
      <div className="flex flex-col gap-4">
        {/* Expand / collapse toggle */}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleExpand}
          className="self-start"
        >
          {expanded ? "Collapse" : "Load images from Etsy"}
        </Button>

        {expanded && (
          <>
            {/* Atomic-swap notice */}
            <p className="text-xs text-(--text-muted) rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-3 py-2">
              Note: adds and deletes are individual API calls — the Etsy listing
              may briefly show fewer images during a swap. Reorder is not
              supported here; use Etsy&apos;s shop manager to change image order.
            </p>

            {/* Loading / error state */}
            {loading && (
              <p className="text-xs text-(--text-muted)">Loading…</p>
            )}
            {fetchError && (
              <p className="text-xs text-(--accent-bad)">{fetchError}</p>
            )}

            {/* Live images */}
            {liveImages !== null && (
              <section aria-label="Live Etsy images">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-(--text-secondary)">
                  Live on Etsy ({liveImages.length})
                </h3>
                {liveImages.length === 0 ? (
                  <p className="text-xs text-(--text-muted)">
                    No images on this listing yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {liveImages.map((img) => (
                      <LiveImageRow
                        key={img.listing_image_id}
                        image={img}
                        onDelete={handleDelete}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* Available source images */}
            {availableSources.length > 0 && (
              <section aria-label="Available source images">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-(--text-secondary)">
                  Available images ({availableSources.length})
                </h3>
                {atLimit && (
                  <p className="mb-2 text-xs text-(--text-muted)">
                    Etsy allows a maximum of {ETSY_IMAGE_LIMIT} images. Remove an image before adding another.
                  </p>
                )}
                <ul className="flex flex-col gap-2">
                  {availableSources.map(({ url, label }) => (
                    <AvailableImageRow
                      key={url}
                      url={url}
                      label={label}
                      atLimit={atLimit}
                      onAdd={handleAdd}
                    />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </SurfaceCard>
  );
}
