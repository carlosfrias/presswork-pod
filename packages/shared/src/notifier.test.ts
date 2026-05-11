import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("notifySlack", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => { savedEnv = { ...process.env }; });
  afterEach(() => { process.env = savedEnv; });

  it("sends POST to SLACK_WEBHOOK_URL with message text", async () => {
    process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/test";
    let capturedBody: unknown;
    server.use(
      http.post("https://hooks.slack.com/test", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      })
    );
    const { notifySlack } = await import("./notifier.js");
    await expect(notifySlack("test alert")).resolves.toBeUndefined();
    expect(capturedBody).toMatchObject({ text: expect.stringContaining("test alert") });
  });

  it("does not throw when SLACK_WEBHOOK_URL is not set", async () => {
    delete process.env["SLACK_WEBHOOK_URL"];
    const { notifySlack } = await import("./notifier.js");
    await expect(notifySlack("silent")).resolves.toBeUndefined();
  });

  it("emits structured pino log (not console.warn) when SLACK_WEBHOOK_URL is unset (audit #44)", async () => {
    delete process.env["SLACK_WEBHOOK_URL"];
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Capture stdout writes from pino — pino writes JSON lines to stdout by default.
    let captured = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        captured += String(chunk);
        return true;
      });

    const { notifySlack } = await import("./notifier.js");
    await notifySlack("test");

    // pino emitted a structured warn entry mentioning the missing URL.
    expect(captured).toContain("\"action\":\"slack_skip\"");
    expect(captured).toContain("\"reason\":\"missing_url\"");
    // No console.warn fallback was used.
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("does not throw when Slack endpoint returns non-200", async () => {
    process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/fail";
    server.use(
      http.post("https://hooks.slack.com/fail", () =>
        new HttpResponse("error", { status: 500 })
      )
    );
    const { notifySlack } = await import("./notifier.js");
    await expect(notifySlack("oops")).resolves.toBeUndefined();
  });
});

describe("notifyEmail", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => { savedEnv = { ...process.env }; });
  afterEach(() => { process.env = savedEnv; });

  it("sends POST to Resend API with correct to and subject", async () => {
    process.env["RESEND_API_KEY"] = "re_test_key";
    process.env["ALERT_EMAIL"] = "alert@example.com";
    let capturedBody: unknown;
    server.use(
      http.post("https://api.resend.com/emails", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "email-123" });
      })
    );
    const { notifyEmail } = await import("./notifier.js");
    await expect(notifyEmail("Test Subject", "body text")).resolves.toBeUndefined();
    expect(capturedBody).toMatchObject({
      to: "alert@example.com",
      subject: "Test Subject",
    });
  });

  it("does not throw when RESEND_API_KEY is not set", async () => {
    delete process.env["RESEND_API_KEY"];
    process.env["ALERT_EMAIL"] = "alert@example.com";
    const { notifyEmail } = await import("./notifier.js");
    await expect(notifyEmail("subj", "body")).resolves.toBeUndefined();
  });
});
