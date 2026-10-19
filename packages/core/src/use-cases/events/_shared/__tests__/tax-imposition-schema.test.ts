import { describe, expect, it } from "vitest";

import { uniformPlatformTaxBase } from "../tax-imposition-schema";

describe("uniformPlatformTaxBase", () => {
  it("no lines → null", () => {
    expect(uniformPlatformTaxBase([])).toBeNull();
  });

  it("ORGANISER-only → null", () => {
    expect(
      uniformPlatformTaxBase([{ base: "TICKET_FACE", collector: "ORGANISER" }]),
    ).toBeNull();
  });

  it("PLATFORM lines on one base plus an ORGANISER line on another → the PLATFORM base", () => {
    expect(
      uniformPlatformTaxBase([
        { base: "BUYER_TOTAL", collector: "PLATFORM" },
        { base: "BUYER_TOTAL", collector: "PLATFORM" },
        { base: "TICKET_FACE", collector: "ORGANISER" },
      ]),
    ).toBe("BUYER_TOTAL");
  });

  it("PLATFORM lines on different bases → null", () => {
    expect(
      uniformPlatformTaxBase([
        { base: "BUYER_TOTAL", collector: "PLATFORM" },
        { base: "TICKET_FACE", collector: "PLATFORM" },
      ]),
    ).toBeNull();
  });
});
