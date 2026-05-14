import { describe, it, expect } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class strings with a single space", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values (false, null, undefined, 0)", () => {
    expect(cn("a", false, null, undefined, 0, "b")).toBe("a b");
  });

  it("supports the clsx object shorthand", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("dedupes conflicting tailwind classes via twMerge (last-wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("keeps non-conflicting tailwind classes side by side", () => {
    expect(cn("px-2", "py-4")).toBe("px-2 py-4");
  });
});
