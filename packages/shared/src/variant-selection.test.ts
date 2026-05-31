import { describe, it, expect } from "vitest";
import { validateVariantIds, VariantSelectionError } from "./variant-selection.js";

describe("validateVariantIds", () => {
  it("does not throw when selected is a strict subset of available", () => {
    expect(() => validateVariantIds([1, 2], [1, 2, 3, 4])).not.toThrow();
  });

  it("does not throw when selected equals available", () => {
    expect(() => validateVariantIds([10, 20, 30], [10, 20, 30])).not.toThrow();
  });

  it("does not throw when selectedIds is empty", () => {
    expect(() => validateVariantIds([], [1, 2, 3])).not.toThrow();
  });

  it("does not throw when both arrays are empty", () => {
    expect(() => validateVariantIds([], [])).not.toThrow();
  });

  it("throws VariantSelectionError when a selected id is absent from available", () => {
    expect(() => validateVariantIds([1, 99], [1, 2, 3])).toThrowError(
      VariantSelectionError
    );
  });

  it("includes the offending id in the error message", () => {
    expect(() => validateVariantIds([42], [1, 2, 3])).toThrowError("42");
  });

  it("includes all offending ids in the error message when multiple are bad", () => {
    let caught: Error | undefined;
    try {
      validateVariantIds([1, 55, 66], [1, 2, 3]);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(VariantSelectionError);
    expect(caught?.message).toContain("55");
    expect(caught?.message).toContain("66");
  });

  it("does not include valid ids in the error message", () => {
    let caught: Error | undefined;
    try {
      validateVariantIds([1, 99], [1, 2, 3]);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).not.toContain("1,");
    expect(caught?.message).toContain("99");
  });

  it("sets error.name to VariantSelectionError", () => {
    let caught: Error | undefined;
    try {
      validateVariantIds([999], [1]);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.name).toBe("VariantSelectionError");
  });
});
