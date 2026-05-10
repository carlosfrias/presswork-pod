import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.resetModules() before each test ensures the ring buffer is fresh (module re-executes)
describe("getPrintifyErrorRate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ok=true with 0 pct errors when buffer is empty", async () => {
    const { getPrintifyErrorRate } = await import("./printify-metrics.js");
    const rate = getPrintifyErrorRate();
    expect(rate).toEqual({ sample_size: 0, error_rate_4xx_pct: 0, error_rate_5xx_pct: 0, ok: true });
  });

  it("calculates correct rates with 1 error in 10 requests", async () => {
    const { getPrintifyErrorRate, _recordPrintifyOutcome } = await import("./printify-metrics.js");

    // 9 successes + 1 4xx = 10 total, 10% 4xx rate
    for (let i = 0; i < 9; i++) _recordPrintifyOutcome("success");
    _recordPrintifyOutcome("4xx");

    const rate = getPrintifyErrorRate();
    expect(rate.sample_size).toBe(10);
    expect(rate.error_rate_4xx_pct).toBe(10);
    expect(rate.error_rate_5xx_pct).toBe(0);
    expect(rate.ok).toBe(false); // 10% >= 4% threshold → not ok
  });

  it("ok=true when combined error rate is below 4%", async () => {
    const { getPrintifyErrorRate, _recordPrintifyOutcome } = await import("./printify-metrics.js");

    // 3 errors in 100 = 3%, under the 4% threshold
    for (let i = 0; i < 97; i++) _recordPrintifyOutcome("success");
    _recordPrintifyOutcome("4xx");
    _recordPrintifyOutcome("5xx");
    _recordPrintifyOutcome("4xx");

    const rate = getPrintifyErrorRate();
    expect(rate.sample_size).toBe(100);
    expect(rate.ok).toBe(true); // 3% < 4%
  });

  it("ok=false when combined error rate is exactly 4%", async () => {
    const { getPrintifyErrorRate, _recordPrintifyOutcome } = await import("./printify-metrics.js");

    // 4 errors in 100 = exactly 4%
    for (let i = 0; i < 96; i++) _recordPrintifyOutcome("success");
    for (let i = 0; i < 4; i++) _recordPrintifyOutcome("4xx");

    const rate = getPrintifyErrorRate();
    expect(rate.sample_size).toBe(100);
    expect(rate.ok).toBe(false); // 4% is NOT < 4 (uses strict less-than)
  });

  it("caps ring buffer at 200 samples", async () => {
    const { getPrintifyErrorRate, _recordPrintifyOutcome } = await import("./printify-metrics.js");

    // Fill beyond 200
    for (let i = 0; i < 250; i++) _recordPrintifyOutcome("success");

    const rate = getPrintifyErrorRate();
    expect(rate.sample_size).toBe(200);
  });

  it("counts 5xx and 4xx separately", async () => {
    const { getPrintifyErrorRate, _recordPrintifyOutcome } = await import("./printify-metrics.js");

    for (let i = 0; i < 90; i++) _recordPrintifyOutcome("success");
    for (let i = 0; i < 5; i++) _recordPrintifyOutcome("4xx");
    for (let i = 0; i < 5; i++) _recordPrintifyOutcome("5xx");

    const rate = getPrintifyErrorRate();
    expect(rate.sample_size).toBe(100);
    expect(rate.error_rate_4xx_pct).toBe(5);
    expect(rate.error_rate_5xx_pct).toBe(5);
  });
});
