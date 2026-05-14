import { describe, it, expect } from "vitest";
import {
  PALETTE_SIZE,
  generateLocalPalette,
  normalizeHex,
  isValidHex,
} from "./palette";

describe("generateLocalPalette", () => {
  it("returns PALETTE_SIZE valid hex colors", () => {
    const colors = generateLocalPalette(42);
    expect(colors).toHaveLength(PALETTE_SIZE);
    for (const c of colors) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(generateLocalPalette(123)).toEqual(generateLocalPalette(123));
  });

  it("produces different palettes for different seeds", () => {
    expect(generateLocalPalette(1)).not.toEqual(generateLocalPalette(2));
  });
});

describe("normalizeHex", () => {
  it("expands 3-digit hex shorthand to 6 digits", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("abc")).toBe("#aabbcc");
  });

  it("lowercases and prefixes 6-digit hex", () => {
    expect(normalizeHex("AABBCC")).toBe("#aabbcc");
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
  });

  it("trims whitespace", () => {
    expect(normalizeHex("  #abc  ")).toBe("#aabbcc");
  });

  it("returns null for non-hex input", () => {
    expect(normalizeHex("not-a-color")).toBeNull();
    expect(normalizeHex("#xyz")).toBeNull();
    expect(normalizeHex("#abcd")).toBeNull(); // 4 chars, not 3 or 6
  });
});

describe("isValidHex", () => {
  it("returns true for valid hex (with or without leading #, 3 or 6 digits)", () => {
    expect(isValidHex("#abc")).toBe(true);
    expect(isValidHex("abc")).toBe(true);
    expect(isValidHex("#aabbcc")).toBe(true);
    expect(isValidHex("AABBCC")).toBe(true);
  });

  it("returns false for non-hex input", () => {
    expect(isValidHex("not-a-color")).toBe(false);
    expect(isValidHex("#xyz")).toBe(false);
  });
});
