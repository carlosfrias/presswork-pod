import type { Db } from "./db.js";
import { etsyFetch } from "./etsy-api.js";

export type ProductKey = "tshirt";

const PRODUCT_TAXONOMY_LABELS: Record<ProductKey, string[]> = {
  tshirt: ["T-Shirts"],
};

interface TaxonomyNode {
  id: number;
  name: string;
  children?: TaxonomyNode[];
}

function findNode(nodes: TaxonomyNode[], labels: string[]): number | null {
  for (const node of nodes) {
    if (labels.some((l) => node.name.toLowerCase() === l.toLowerCase())) {
      return node.id;
    }
    if (node.children?.length) {
      const found = findNode(node.children, labels);
      if (found !== null) return found;
    }
  }
  return null;
}

async function fetchTaxonomyNodes(db: Db): Promise<TaxonomyNode[]> {
  // Route through the shared limiter so taxonomy calls count against the same
  // rate budget as listing/receipt calls. Raw fetch() here bypassed bottleneck
  // and could burst us into 429 territory.
  const json = (await etsyFetch(db, "/application/seller-taxonomy/nodes")) as {
    results: TaxonomyNode[];
  };
  if (!Array.isArray(json.results)) throw new Error("Unexpected taxonomy response shape");
  return json.results;
}

/**
 * Returns the Etsy taxonomy ID for a given product type.
 * Reads from the Supabase config cache first; fetches and persists on cache miss.
 * To invalidate, delete the `etsy_taxonomy_<productKey>` row from the config table.
 */
export async function getTaxonomyId(db: Db, productKey: ProductKey): Promise<number> {
  const cacheKey = `etsy_taxonomy_${productKey}`;

  // Cache read
  const { data } = await db
    .from("config")
    .select("value")
    .eq("key", cacheKey)
    .maybeSingle();
  const cached = (data as { value?: string } | null)?.value;
  if (cached) {
    const id = parseInt(cached, 10);
    if (!isNaN(id) && id > 0) return id;
  }

  // Cache miss — fetch from Etsy
  const nodes = await fetchTaxonomyNodes(db);
  const labels = PRODUCT_TAXONOMY_LABELS[productKey];
  const id = findNode(nodes, labels);
  if (id === null) {
    throw new Error(
      `Etsy taxonomy node not found for product key "${productKey}" (labels: ${labels.join(", ")})`
    );
  }

  // Persist to cache
  await db.from("config").upsert({ key: cacheKey, value: String(id) });

  return id;
}
