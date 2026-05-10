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

export async function createHiddenProduct(
  input: CreateProductInput
): Promise<{ productId: string; mockupUrls: string[] }> {
  const { PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID } = getSettings();

  const body = {
    title: input.title,
    blueprint_id: input.blueprintId,
    print_provider_id: 1, // default print provider for the blueprint
    variants: input.variantIds.map((id) => ({
      id,
      price: 0, // price is set on the Etsy listing, not on the Printify product
      is_enabled: true,
    })),
    print_areas: [
      {
        variant_ids: input.variantIds,
        placeholders: [
          {
            position: "front",
            images: [{ id: input.imageUrl, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
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
