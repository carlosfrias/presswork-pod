import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatUsd, formatNumber, formatPercent, formatRelative } from "./format";

describe("formatUsd", () => {
  it("formats a standard dollar amount with two decimals", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("falls back to em-dash for nullish or NaN", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(NaN)).toBe("—");
  });

  it("uses compact notation when opted in and value ≥ 10k", () => {
    const out = formatUsd(15000, { compact: true });
    expect(out).toMatch(/15K|15\.0K/);
    expect(out.startsWith("$")).toBe(true);
  });

  it("keeps standard notation under the 10k compact threshold even when compact:true", () => {
    expect(formatUsd(9999, { compact: true })).toBe("$9,999.00");
  });
});

describe("formatNumber", () => {
  it("formats integers with thousands separators", () => {
    expect(formatNumber(12345)).toBe("12,345");
  });

  it("returns em-dash for nullish input", () => {
    expect(formatNumber(null)).toBe("—");
  });

  it("uses compact notation at the 10k threshold", () => {
    expect(formatNumber(10500, { compact: true })).toMatch(/10\.5K|11K/);
  });
});

describe("formatPercent", () => {
  it("multiplies by 100 and appends a percent sign", () => {
    expect(formatPercent(0.125)).toBe("12.5%");
  });

  it("returns em-dash for nullish or NaN", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(NaN)).toBe("—");
  });
});

describe("formatRelative", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns em-dash for nullish input", () => {
    expect(formatRelative(null)).toBe("—");
    expect(formatRelative(undefined)).toBe("—");
  });

  it("formats sub-minute deltas in seconds", () => {
    expect(formatRelative("2026-05-14T11:59:30Z")).toBe("30s ago");
  });

  it("formats sub-hour deltas in minutes", () => {
    expect(formatRelative("2026-05-14T11:30:00Z")).toBe("30m ago");
  });

  it("formats sub-2-day deltas in hours", () => {
    expect(formatRelative("2026-05-14T06:00:00Z")).toBe("6h ago");
  });

  it("formats sub-2-week deltas in days", () => {
    expect(formatRelative("2026-05-10T12:00:00Z")).toBe("4d ago");
  });
});
