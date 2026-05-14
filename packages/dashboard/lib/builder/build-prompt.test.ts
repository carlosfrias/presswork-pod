import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture every call made through the Anthropic SDK so we can assert request shape.
const createSpy = vi.fn(async () => ({
  content: [{ type: "text", text: JSON.stringify({ description: "a fleshed out description here." }) }],
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
}));

// Anthropic SDK mock. `APIError` is referenced via `Anthropic.APIError` in the
// module under test, so we expose a constructible class on the namespace too.
class FakeAPIError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.status = status;
  }
}

vi.mock("@anthropic-ai/sdk", () => {
  const Anthropic = vi.fn(() => ({
    beta: {
      promptCaching: {
        messages: {
          create: createSpy,
        },
      },
    },
  })) as unknown as new (opts: { apiKey: string }) => unknown;
  (Anthropic as unknown as { APIError: typeof FakeAPIError }).APIError = FakeAPIError;
  return { default: Anthropic };
});

const recordUsageSpy = vi.fn();
vi.mock("@presswork/shared", () => ({
  estimateAnthropicCostUsd: vi.fn(() => 0.012),
  recordUsage: recordUsageSpy,
}));

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  createSpy.mockClear();
  recordUsageSpy.mockClear();
});

afterEach(() => {
  process.env = savedEnv;
});

async function load() {
  vi.resetModules();
  return await import("./build-prompt");
}

type MessagesCreateCall = {
  model: string;
  max_tokens: number;
  system: Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: unknown }>;
  betas: string[];
};

function getMessagesCall(): MessagesCreateCall {
  expect(createSpy).toHaveBeenCalledTimes(1);
  // createSpy is typed as taking no args (vi.fn(async () => ...)) so we need
  // a two-step cast to access the actual call args at runtime.
  const calls = createSpy.mock.calls as unknown as MessagesCreateCall[][];
  return calls[0][0];
}

describe("buildPromptDescription", () => {
  it("throws BuildPromptError when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { buildPromptDescription, BuildPromptError } = await load();

    await expect(buildPromptDescription("a bulldog trashman", null)).rejects.toThrow(
      BuildPromptError,
    );
  });

  it("returns the description field from Claude's JSON response", async () => {
    const { buildPromptDescription } = await load();

    const result = await buildPromptDescription("a bulldog trashman", null);

    expect(result).toBe("a fleshed out description here.");
  });

  it("sends the canonical sonnet-4 model and the system prompt with prompt caching", async () => {
    const { buildPromptDescription } = await load();

    await buildPromptDescription("a bulldog trashman", null);

    const call = getMessagesCall();
    expect(call.model).toBe("claude-sonnet-4-20250514");
    expect(call.betas).toContain("prompt-caching-2024-07-31");
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(call.system[0].text.length).toBeGreaterThan(100);
  });

  it("packs seed only when scout/style/references are absent", async () => {
    const { buildPromptDescription } = await load();

    await buildPromptDescription("a bulldog trashman", null);

    const call = getMessagesCall();
    // Single text payload, not multi-block
    expect(typeof call.messages[0].content).toBe("string");
    const payload = JSON.parse(call.messages[0].content as string);
    expect(payload.seed).toBe("a bulldog trashman");
    expect(payload.scout_brief).toBeNull();
    expect(payload.style_lock).toBeNull();
    expect(payload.reference_image_count).toBe(0);
  });

  it("includes scout signals in the payload when provided", async () => {
    const { buildPromptDescription } = await load();

    await buildPromptDescription("a bulldog trashman", {
      niche: "cat lovers",
      style_keywords: ["vintage", "pastel"],
      top_tags: ["cats"],
      color_palette: ["#ff0000"],
    });

    const call = getMessagesCall();
    const payload = JSON.parse(call.messages[0].content as string);
    expect(payload.scout_brief).toEqual({
      niche: "cat lovers",
      style_keywords: ["vintage", "pastel"],
      top_tags: ["cats"],
      color_palette: ["#ff0000"],
    });
  });

  it("includes a style_lock block when styleId resolves to a catalog entry", async () => {
    const { buildPromptDescription } = await load();

    await buildPromptDescription("a bulldog trashman", null, null, "screen_print");

    const call = getMessagesCall();
    const payload = JSON.parse(call.messages[0].content as string);
    expect(payload.style_lock).not.toBeNull();
    expect(payload.style_lock.name).toBeTruthy();
    expect(payload.style_lock.directive.length).toBeGreaterThan(20);
  });

  it("prepends image blocks before the text payload when reference URLs are supplied", async () => {
    const { buildPromptDescription } = await load();

    await buildPromptDescription("a bulldog trashman", null, [
      "https://example.test/ref1.jpg",
      "https://example.test/ref2.jpg",
    ]);

    const call = getMessagesCall();
    const content = call.messages[0].content as Array<{ type: string; source?: { type: string; url: string }; text?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("image");
    expect(content[0].source?.url).toBe("https://example.test/ref1.jpg");
    expect(content[1].type).toBe("image");
    expect(content[2].type).toBe("text");
    const payload = JSON.parse(content[2].text!);
    expect(payload.reference_image_count).toBe(2);
  });

  it("records token usage to llm_usage with builder/anthropic/build_prompt tags", async () => {
    const { buildPromptDescription } = await load();

    await buildPromptDescription("a bulldog trashman", {
      niche: "cat lovers",
    });

    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    expect(recordUsageSpy.mock.calls[0][0]).toMatchObject({
      agent: "builder",
      provider: "anthropic",
      operation: "build_prompt",
      input_tokens: 100,
      output_tokens: 50,
      metadata: expect.objectContaining({
        model: "claude-sonnet-4-20250514",
        niche: "cat lovers",
        manual: false,
        reference_image_count: 0,
      }),
    });
  });

  it("strips ```json code fences before parsing the response", async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "```json\n" + JSON.stringify({ description: "fenced description here." }) + "\n```",
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const { buildPromptDescription } = await load();

    const result = await buildPromptDescription("seed text here", null);

    expect(result).toBe("fenced description here.");
  });
});
