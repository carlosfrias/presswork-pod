import retry from "async-retry";
import { getSettings } from "@presswork/shared";

export class PrintifyError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PrintifyError";
  }
}

interface CreateProductInput {
  imageUrl: string;
  blueprintId: number;
  printProviderId: number;
  variantIds: number[];
  title: string;
}

async function printifyFetch(
  path: string,
  init: RequestInit,
  apiToken: string
): Promise<unknown> {
  return retry(
    async (bail) => {
      const res = await fetch(`https://api.printify.com/v1${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      });

      if (!res.ok) {
        const body = await res.text();
        // Don't retry 4xx errors
        if (res.status < 500) {
          bail(new PrintifyError(`Printify ${res.status}: ${body}`, res.status));
          return;
        }
        throw new PrintifyError(`Printify ${res.status}: ${body}`, res.status);
      }

      return res.json();
    },
    { retries: 3, factor: 2, minTimeout: 500 }
  );
}

// POST /v1/uploads/images.json — registers an image into the Printify media
// library and returns its upload id. That id is what print_areas[].placeholders[]
// .images[].id expects when creating a product. Passing the public URL directly
// into print_areas does NOT work (Printify rejects it as an unknown image id).
export async function uploadImageByUrl(
  imageUrl: string,
  fileName: string
): Promise<string> {
  const { PRINTIFY_API_TOKEN } = getSettings();

  const data = (await printifyFetch(
    "/uploads/images.json",
    { method: "POST", body: JSON.stringify({ file_name: fileName, url: imageUrl }) },
    PRINTIFY_API_TOKEN
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

export async function createHiddenProduct(
  input: CreateProductInput
): Promise<{ productId: string; mockupUrls: string[] }> {
  const { PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID } = getSettings();

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
    PRINTIFY_API_TOKEN
  )) as { id: string; images: Array<{ src: string }> };

  const mockupUrls = (data.images ?? []).map((img) => img.src);
  if (mockupUrls.length === 0) {
    throw new PrintifyError("Printify returned no mockup images for the created product");
  }

  return { productId: data.id, mockupUrls };
}

export async function setProductVisible(productId: string): Promise<void> {
  const { PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID } = getSettings();

  await printifyFetch(
    `/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`,
    { method: "PUT", body: JSON.stringify({ is_visible: true }) },
    PRINTIFY_API_TOKEN
  );
}
