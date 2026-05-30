import { getLogger } from "./logger.js";
import { getSettings } from "./config.js";

/**
 * Mock-mode bridge for the Etsy v3 API.
 *
 * When ETSY_MOCK_MODE=true (see config.ts), the shared HTTP client short-circuits
 * here instead of calling api.etsy.com / openapi.etsy.com. Fixtures below are
 * trimmed copies of the Etsy OpenAPI documentation examples so the response
 * shapes match what real Etsy returns. Single source of truth for both runtime
 * (etsyFetch / etsyMultipartFetch / etsy-auth) and tests (publisher-flow.test.ts
 * imports baseHandlers from the same fixture map).
 *
 * Adding a new endpoint:
 *   1) Find the example response in the Etsy v3 docs.
 *   2) Add a fixture entry below with a path matcher and a build() function.
 *   3) Call sites in etsy-api.ts pick it up automatically (no caller changes).
 */

export class EtsyMockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyMockError";
  }
}

export function isMockMode(): boolean {
  return getSettings().ETSY_MOCK_MODE;
}

interface MockContext {
  method: string;
  path: string;
  /** Parsed JSON body (if any). FormData calls pass undefined. */
  body: unknown;
}

interface FixtureEntry {
  name: string;
  match: (ctx: MockContext) => boolean;
  build: (ctx: MockContext) => unknown;
}

// Stable, non-cryptographic hash so deterministic IDs survive process restarts.
// Range is bounded by the caller; we just need spread + reproducibility.
function deterministicId(seed: string, max: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % max) + 1;
}

function parseJsonBody(raw: BodyInit | null | undefined): unknown {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── Fixture catalog ────────────────────────────────────────────────────────────
// Order matters: more specific paths must come before more general ones.
const fixtures: FixtureEntry[] = [
  // OAuth token refresh
  // POST https://api.etsy.com/v3/public/oauth/token
  // Note: this endpoint lives on api.etsy.com, NOT openapi.etsy.com — etsy-auth
  // calls it directly with full URL, so the path here matches what etsy-auth
  // hands us when short-circuiting (the full /v3/public/oauth/token path).
  {
    name: "oauth_token_refresh",
    match: ({ method, path }) =>
      method === "POST" && path === "/v3/public/oauth/token",
    build: () => ({
      access_token: "mock-access-token-aaaaaaaaaaaaaaaaaaaaaaaa",
      refresh_token: "mock-refresh-token-bbbbbbbbbbbbbbbbbbbbbbb",
      expires_in: 3600,
      token_type: "Bearer",
    }),
  },

  // Seller taxonomy nodes — trimmed to the T-Shirts branch since that's the
  // only product key getTaxonomyId currently resolves. Add more branches if
  // PRODUCT_TAXONOMY_LABELS in etsy-taxonomy.ts grows beyond "tshirt".
  {
    name: "seller_taxonomy_nodes",
    match: ({ method, path }) =>
      method === "GET" &&
      /\/application\/seller-taxonomy\/nodes\/?$/.test(path),
    build: () => ({
      count: 1,
      results: [
        {
          id: 30,
          level: 0,
          name: "Clothing",
          parent_id: null,
          children_ids: [80],
          children: [
            {
              id: 80,
              level: 1,
              name: "Unisex Adult Clothing",
              parent_id: 30,
              children_ids: [1167],
              children: [
                {
                  id: 1167,
                  level: 2,
                  name: "T-Shirts",
                  parent_id: 80,
                  children_ids: [],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    }),
  },

  // List the shop's active (live) listings — used by the reconcile script.
  // GET /application/shops/{shop_id}/listings/active
  // Returns a small fixed set so a dry run has something to diff against. The
  // count equals results.length so getActiveEtsyListings stops after one page.
  {
    name: "list_active_listings",
    match: ({ method, path }) =>
      method === "GET" &&
      /\/application\/shops\/[^/]+\/listings\/active(\/|\?|$)/.test(path),
    build: () => ({
      count: 2,
      results: [
        {
          listing_id: 4200000001,
          title: "Mock Hand-Made Listing One",
          description: "A live listing that exists on Etsy but not in the DB.",
          tags: ["mock", "handmade"],
          state: "active",
          price: { amount: 2499, divisor: 100, currency_code: "USD" },
        },
        {
          listing_id: 4200000002,
          title: "Mock Hand-Made Listing Two",
          description: "Another live listing absent from the local listings table.",
          tags: ["mock"],
          state: "active",
          price: { amount: 1999, divisor: 100, currency_code: "USD" },
        },
      ],
    }),
  },

  // Create draft listing
  // POST /application/shops/{shop_id}/listings
  {
    name: "create_draft_listing",
    match: ({ method, path }) =>
      method === "POST" &&
      /\/application\/shops\/[^/]+\/listings\/?$/.test(path),
    build: ({ body }) => {
      const title =
        typeof body === "object" &&
        body !== null &&
        "title" in body &&
        typeof (body as { title: unknown }).title === "string"
          ? (body as { title: string }).title
          : "Mock Listing";
      // Deterministic ID so a rerun produces the same etsy_listing_id and
      // resume guards in publisher.ts treat it as a real prior draft.
      const listingId = deterministicId(`listing:${title}`, 999_999_998) + 1;
      return {
        listing_id: listingId,
        user_id: 1,
        shop_id: 1,
        title,
        description: "Mock listing description",
        state: "draft",
        creation_timestamp: Math.floor(Date.now() / 1000),
        ending_timestamp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 120,
        original_creation_timestamp: Math.floor(Date.now() / 1000),
        last_modified_timestamp: Math.floor(Date.now() / 1000),
        state_timestamp: Math.floor(Date.now() / 1000),
        quantity: 999,
        url: `https://www.etsy.com/listing/${listingId}`,
        currency_code: "USD",
        is_customizable: false,
        is_personalizable: false,
        personalization_is_required: false,
      };
    },
  },

  // Upload listing image (multipart)
  // POST /application/shops/{shop_id}/listings/{listing_id}/images
  {
    name: "upload_listing_image",
    match: ({ method, path }) =>
      method === "POST" &&
      /\/application\/shops\/[^/]+\/listings\/[^/]+\/images\/?$/.test(path),
    build: ({ path }) => {
      const idMatch = path.match(/listings\/(\d+)\/images/);
      const listingId = idMatch ? Number(idMatch[1]) : 0;
      const imageId = deterministicId(`image:${path}:${Date.now()}`, 999_999_998) + 1;
      return {
        listing_id: listingId,
        listing_image_id: imageId,
        hex_code: "FFFFFF",
        red: 255,
        green: 255,
        blue: 255,
        hue: 0,
        saturation: 0,
        brightness: 100,
        is_black_and_white: false,
        creation_tsz: Math.floor(Date.now() / 1000),
        rank: 1,
        url_75x75: `https://i.etsystatic.com/mock/${imageId}_75x75.jpg`,
        url_170x135: `https://i.etsystatic.com/mock/${imageId}_170x135.jpg`,
        url_570xN: `https://i.etsystatic.com/mock/${imageId}_570xN.jpg`,
        url_fullxfull: `https://i.etsystatic.com/mock/${imageId}_fullxfull.jpg`,
        full_height: 2000,
        full_width: 2000,
      };
    },
  },

  // Update listing inventory (variants)
  // PUT /application/listings/{listing_id}/inventory
  {
    name: "update_listing_inventory",
    match: ({ method, path }) =>
      method === "PUT" &&
      /\/application\/listings\/[^/]+\/inventory\/?$/.test(path),
    build: ({ body }) => {
      const products =
        typeof body === "object" &&
        body !== null &&
        "products" in body &&
        Array.isArray((body as { products: unknown }).products)
          ? (body as { products: unknown[] }).products
          : [];
      return {
        products,
        price_on_property: [],
        quantity_on_property: [],
        sku_on_property: [],
      };
    },
  },

  // Activate (or otherwise update) listing state
  // PATCH /application/shops/{shop_id}/listings/{listing_id}
  {
    name: "update_listing_state",
    match: ({ method, path }) =>
      method === "PATCH" &&
      /\/application\/shops\/[^/]+\/listings\/\d+\/?$/.test(path),
    build: ({ path, body }) => {
      const idMatch = path.match(/listings\/(\d+)/);
      const listingId = idMatch ? Number(idMatch[1]) : 0;
      const state =
        typeof body === "object" &&
        body !== null &&
        "state" in body &&
        typeof (body as { state: unknown }).state === "string"
          ? (body as { state: string }).state
          : "active";
      return {
        listing_id: listingId,
        state,
        title: "Mock Listing",
        url: `https://www.etsy.com/listing/${listingId}`,
        last_modified_timestamp: Math.floor(Date.now() / 1000),
        state_timestamp: Math.floor(Date.now() / 1000),
      };
    },
  },

  // Receipts list — empty by default. Ledger code paths still execute
  // (limiter, auth, schema parse) without minting fake economics rows.
  // Override per-test by adding a fixture entry above this one.
  {
    name: "list_receipts_empty",
    match: ({ method, path }) =>
      method === "GET" &&
      /\/application\/shops\/[^/]+\/receipts(\/|\?|$)/.test(path),
    build: () => ({ count: 0, results: [] }),
  },
];

/**
 * Returns the canned response for a given (method, path, body). Throws
 * EtsyMockError if no fixture matches — that's the signal to add one to the
 * catalog before the call site can run in mock mode.
 *
 * `body` may be:
 *   - a JSON string (the typical etsyFetch case) — parsed before matching.
 *   - undefined (multipart uploads, GETs).
 *   - an already-parsed object (test callers).
 */
export function mockEtsyResponse(
  method: string,
  path: string,
  body?: BodyInit | null | unknown
): unknown {
  const parsedBody =
    typeof body === "string" || body == null
      ? parseJsonBody(body as BodyInit | null | undefined)
      : body;

  const ctx: MockContext = { method: method.toUpperCase(), path, body: parsedBody };
  const entry = fixtures.find((f) => f.match(ctx));
  if (!entry) {
    throw new EtsyMockError(
      `etsy-mock: no fixture for ${ctx.method} ${path}. Add one to packages/shared/src/etsy-mock.ts.`
    );
  }
  const data = entry.build(ctx);
  getLogger("etsy-mock").info({
    action: "mock_response",
    method: ctx.method,
    path,
    fixture: entry.name,
  });
  return data;
}
