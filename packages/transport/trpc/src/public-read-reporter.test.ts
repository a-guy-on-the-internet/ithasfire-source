import { describe, expect, it, vi } from "vitest";

import { throttledPublicReadReporter } from "./public-read-reporter";

describe("throttledPublicReadReporter", () => {
  it("is undefined without a base reporter", () => {
    expect(throttledPublicReadReporter(null)).toBeUndefined();
    expect(throttledPublicReadReporter(undefined)).toBeUndefined();
  });

  it("is the same throttled reporter per base reporter, so a window spans requests", () => {
    const base = vi.fn();
    const a = throttledPublicReadReporter(base)!;
    const b = throttledPublicReadReporter(base)!;
    expect(a).toBe(b);
    const tags = { useCase: "quoteSeatPriceOverrides" };
    a(new Error("x"), { tags });
    b(new Error("x"), { tags });
    a(new Error("x"), { tags });
    expect(base).toHaveBeenCalledTimes(1);
  });
});
