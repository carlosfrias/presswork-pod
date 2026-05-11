import { printifyFetch, PrintifyError, getSettings } from "@presswork/shared";

export { PrintifyError };

interface CreateProductInput {
  imageUrl: string;
  blueprintId: number;
  printProviderId: number;
  variantIds: number[];
  title: string;
}

// POST /v1/uploads/images.json — registers an image into the Printify media
// library and returns its upload id. That id is what print_areas[].placeholders[]
// .images[].id expects when creating a product. Passing the public URL directly
// into print_areas does NOT work (Printify rejects it as an unknown image id).
export async function uploadImageByUrl(
  imageUrl: string,
  fileName: string
): Promise<string> {
  const data = (await printifyFetch(
    "/uploads/images.json",
    { method: "POST", body: JSON.stringify({ file_name: fileName, url: imageUrl }) }
  )) as { id?: string };

  if (!data.id) {
    throw new PrintifyError("Printify upload returned no id");
  }
  return data.id;
}

function deriveFileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? last : "design.png";
  } catch {
    return "design.png";
  }
}

export interface PrintifyVariantOptions {
  id: number;
  values: string[];
}

export async function createHiddenProduct(
  input: CreateProductInput
): Promise<{ productId: string; mockupUrls: string[]; variants: PrintifyVariantOptions[] }> {
  const { PRINTIFY_SHOP_ID } = getSettings();

  // Two-step: register the image with Printify first, then reference its id
  // (not the URL) inside print_areas.
  const uploadId = await uploadImageByUrl(
    input.imageUrl,
    deriveFileNameFromUrl(input.imageUrl)
  );

  const body = {
    title: input.title,
    blueprint_id: input.blueprintId,
    print_provider_id: input.printProviderId,
    variants: input.variantIds.map((id) => ({
      id,
      // Printify requires variants.*.price > 0 (cents). The buyer-facing price
      // lives on the Etsy listing; this is a hidden Printify product so the
      // value is internal metadata only — but the API still validates it.
      price: 2499,
      is_enabled: true,
    })),
    print_areas: [
      {
        variant_ids: input.variantIds,
        placeholders: [
          {
            position: "front",
            images: [{ id: uploadId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
          },
        ],
      },
    ],
    is_visible: false,
  };

  const data = (await printifyFetch(
    `/shops/${PRINTIFY_SHOP_ID}/products.json`,
    { method: "POST", body: JSON.stringify(body) },
    { rateClass: "publishing" }
  )) as {
    id: string;
    images: Array<{ src: string }>;
    variants?: Array<{ id: number; title?: string; options?: number[] }>;
    options?: Array<{
      name?: string;
      type?: string;
      values: Array<{ id: number; title: string }>;
    }>;
  };

  const mockupUrls = (data.images ?? []).map((img) => img.src);
  if (mockupUrls.length === 0) {
    throw new PrintifyError("Printify returned no mockup images for the created product");
  }

  const variants = extractVariantOptions(data, input.variantIds);

  return { productId: data.id, mockupUrls, variants };
}

// Walk the product response's options[] → values[] tree to resolve each
// requested variant's option-value ids back to human labels (e.g. "S", "Black").
// We lowercase + sort so the stored representation matches what the Fulfillment
// resolver builds from a receipt's transaction.variations.
function extractVariantOptions(
  data: {
    variants?: Array<{ id: number; title?: string; options?: number[] }>;
    options?: Array<{ values: Array<{ id: number; title: string }> }>;
  },
  requestedVariantIds: number[]
): PrintifyVariantOptions[] {
  const valueIdToLabel = new Map<number, string>();
  for (const opt of data.options ?? []) {
    for (const v of opt.values ?? []) {
      valueIdToLabel.set(v.id, v.title);
    }
  }

  const variantById = new Map<number, { options: number[] | undefined; title: string | undefined }>();
  for (const v of data.variants ?? []) {
    variantById.set(v.id, { options: v.options, title: v.title });
  }

  const out: PrintifyVariantOptions[] = [];
  for (const variantId of requestedVariantIds) {
    const v = variantById.get(variantId);
    if (!v) continue;
    const labels: string[] = [];
    for (const valueId of v.options ?? []) {
      const label = valueIdToLabel.get(valueId);
      if (label) labels.push(label);
    }
    // Fall back to title-splitting (e.g. "S / Black") when options[] is absent,
    // which happens on some older Printify blueprint responses.
    if (labels.length === 0 && v.title) {
      labels.push(...v.title.split("/").map((s) => s.trim()).filter(Boolean));
    }
    out.push({
      id: variantId,
      values: labels.map((l) => l.toLowerCase()),
    });
  }
  return out;
}

export async function setProductVisible(productId: string): Promise<void> {
  const { PRINTIFY_SHOP_ID } = getSettings();

  await printifyFetch(
    `/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`,
    { method: "PUT", body: JSON.stringify({ is_visible: true }) },
    { rateClass: "publishing" }
  );
}
