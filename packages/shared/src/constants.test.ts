import { describe, it, expect } from "vitest";
import { normalizeEtsyCarrierName } from "./constants.js";

describe("normalizeEtsyCarrierName", () => {
  it("normalizes USPS variants", () => {
    expect(normalizeEtsyCarrierName("USPS")).toBe("usps");
    expect(normalizeEtsyCarrierName("usps")).toBe("usps");
    expect(normalizeEtsyCarrierName("USPS First Class Mail")).toBe("usps");
    expect(normalizeEtsyCarrierName("USPS Priority Mail")).toBe("usps");
    expect(normalizeEtsyCarrierName("United States Postal Service")).toBe("usps");
  });

  it("normalizes FedEx variants", () => {
    expect(normalizeEtsyCarrierName("FedEx")).toBe("fedex");
    expect(normalizeEtsyCarrierName("FEDEX")).toBe("fedex");
    expect(normalizeEtsyCarrierName("fedex")).toBe("fedex");
    expect(normalizeEtsyCarrierName("Federal Express")).toBe("fedex");
    expect(normalizeEtsyCarrierName("Fed Ex")).toBe("fedex");
  });

  it("normalizes UPS", () => {
    expect(normalizeEtsyCarrierName("UPS")).toBe("ups");
    expect(normalizeEtsyCarrierName("ups")).toBe("ups");
    expect(normalizeEtsyCarrierName("United Parcel Service")).toBe("ups");
  });

  it("normalizes DHL with and without Express", () => {
    expect(normalizeEtsyCarrierName("DHL")).toBe("dhl");
    expect(normalizeEtsyCarrierName("dhl")).toBe("dhl");
    expect(normalizeEtsyCarrierName("DHL Express")).toBe("dhl-express");
    expect(normalizeEtsyCarrierName("dhl express")).toBe("dhl-express");
    expect(normalizeEtsyCarrierName("DHL-Express")).toBe("dhl-express");
  });

  it("handles whitespace and mixed case", () => {
    expect(normalizeEtsyCarrierName("  USPS  ")).toBe("usps");
    expect(normalizeEtsyCarrierName("  FedEx  ")).toBe("fedex");
  });

  it("returns null for empty string", () => {
    expect(normalizeEtsyCarrierName("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeEtsyCarrierName(undefined)).toBeNull();
  });

  it("returns null for unknown carrier", () => {
    expect(normalizeEtsyCarrierName("SkyNet Express")).toBeNull();
    expect(normalizeEtsyCarrierName("Mystery Carrier LLC")).toBeNull();
    expect(normalizeEtsyCarrierName("random string")).toBeNull();
  });
});
