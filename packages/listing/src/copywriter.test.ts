import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AI_DISCLOSURE_TEXT } from "@presswork/shared";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: "999001",
  ETSY_READINESS_STATE_ID: "1",
  FAL_KEY: "fal-key",
  PRINTIFY_API_TOKEN: "printify-token",
  PRINTIFY_SHOP_ID: "shop-1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};

const validCopy = {
  title: "Funny Cat T-Shirt Unisex Graphic Tee Gift",
  description: `A great shirt for cat lovers everywhere. ${AI_DISCLOSURE_TEXT} Perfect gift.`,
  tags: ["cat shirt", "cat tee", "funny cat", "cat lover gift", "unisex tee",
         "graphic tee", "cat mom", "cat dad", "pet lover", "animal shirt",
         "cute cat", "cat design", "novelty tee"],
};

function makeAnthropicMock(responseText: string) {
  return {
    default: vi.fn().mockReturnValue({
      beta: {
        promptCaching: {
          messages: {
            create: vi.fn().mockResolvedValue({
              content: [{ type: "text", text: responseText }],
            }),
          },
        },
      },
    }),
  };
}

const brief = {
  id: "00000000-0000-0000-0000-000000000001",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: "done" as const,
  niche: "cat lovers",
  style_keywords: ["cute", "minimalist"],
  top_tags: ["cat shirt", "cat tee"],
  color_palette: ["black", "white"],
  price_target_usd: 24.99,
  shirt_colors: ["White"],
  shirt_sizes: ["S", "M", "L", "XL", "2XL"],
  retry_count: 0,
};

const design = {
  id: "00000000-0000-0000-0000-000000000002",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: "done" as const,
  printify_blueprint_id: 5,
  printify_variant_ids: [1, 2, 3],
  retry_count: 0,
};

describe("writeCopy", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("happy path: returns valid ListingCopy", async () => {
    vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(JSON.stringify(validCopy)));
    const { writeCopy } = await import("./copywriter.js");
    const result = await writeCopy(brief, design);
    expect(result.title).toBe(validCopy.title);
    expect(result.tags).toHaveLength(13);
    expect(result.description).toContain(AI_DISCLOSURE_TEXT);
  });

  it("auto-appends the AI disclosure when Claude omits it (option-3 contract)", async () => {
    // Etsy requires the disclosure verbatim in the description; we own the
    // wording server-side. Even if Claude obeys the system prompt's "don't
    // mention AI" rule, writeCopy must still return copy whose description
    // contains AI_DISCLOSURE_TEXT. No throw.
    const { AI_DISCLOSURE_TEXT } = await import("@presswork/shared");
    const noDisclosure = {
      ...validCopy,
      description: "A great shirt for cat lovers. Crafted from premium cotton.",
    };
    vi.doMock("@anthropic-ai/sdk", () =>
      makeAnthropicMock(JSON.stringify(noDisclosure)),
    );
    const { writeCopy } = await import("./copywriter.js");
    const result = await writeCopy(brief, design);
    expect(result.description).toContain(AI_DISCLOSURE_TEXT);
    // The non-disclosure prefix Claude wrote is preserved.
    expect(result.description.startsWith("A great shirt for cat lovers."))
      .toBe(true);
  });

  it("throws CopywriterError when title exceeds 140 chars", async () => {
    const longTitle = { ...validCopy, title: "A".repeat(141) };
    vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(JSON.stringify(longTitle)));
    const { writeCopy, CopywriterError } = await import("./copywriter.js");
    await expect(writeCopy(brief, design)).rejects.toThrow(CopywriterError);
  });

  it("accepts up to 13 tags (audit #42: fewer-than-13 should not abort publish)", async () => {
    const twelveTags = { ...validCopy, tags: validCopy.tags.slice(0, 12) };
    vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(JSON.stringify(twelveTags)));
    const { writeCopy } = await import("./copywriter.js");
    const result = await writeCopy(brief, design);
    expect(result.tags).toHaveLength(12);
  });

  it("auto-trims tag count to 13 when Claude returns more (option-3 contract)", async () => {
    // Same defense-in-depth as the AI disclosure: ensureValidTags caps the
    // array at 13 server-side instead of failing the whole publish call.
    const tooManyTags = { ...validCopy, tags: [...validCopy.tags, "extra tag"] };
    vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(JSON.stringify(tooManyTags)));
    const { writeCopy } = await import("./copywriter.js");
    const result = await writeCopy(brief, design);
    expect(result.tags).toHaveLength(13);
    expect(result.tags).not.toContain("extra tag");
  });

  it("auto-trims long tags to 20 chars (option-3 contract)", async () => {
    // ensureValidTags trims at the last word boundary ≤20 chars (or hard
    // truncates if no boundary), so "houseplant lover gift" (21) → "houseplant lover" (16).
    const longTag = {
      ...validCopy,
      tags: ["houseplant lover gift", ...validCopy.tags.slice(1)],
    };
    vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(JSON.stringify(longTag)));
    const { writeCopy } = await import("./copywriter.js");
    const result = await writeCopy(brief, design);
    expect(result.tags[0]).toBe("houseplant lover");
    expect(result.tags.every((t) => t.length <= 20)).toBe(true);
  });

  it("throws CopywriterError when title is all-caps", async () => {
    const allCaps = { ...validCopy, title: "CAT T-SHIRT UNISEX GRAPHIC TEE" };
    vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(JSON.stringify(allCaps)));
    const { writeCopy, CopywriterError } = await import("./copywriter.js");
    await expect(writeCopy(brief, design)).rejects.toThrow(CopywriterError);
  });

  it("sends system message with cache_control ephemeral", async () => {
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(validCopy) }],
    });
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: vi.fn().mockReturnValue({
        beta: { promptCaching: { messages: { create: createMock } } },
      }),
    }));
    const { writeCopy } = await import("./copywriter.js");
    await writeCopy(brief, design);
    const call = createMock.mock.calls[0]?.[0] as { system: Array<{ cache_control?: unknown }> };
    expect(call.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
