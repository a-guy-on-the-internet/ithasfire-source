import { describe, expect, it } from "vitest";

import { AsYouType } from "libphonenumber-js/max";

describe("PhoneNumberInput formatting", () => {
  it("formats US national number as you type", () => {
    const asYouType = new AsYouType("US");
    expect(asYouType.input("213")).toBe("(213)");
    expect(asYouType.input("3734253")).toBe("(213) 373-4253");
  });

  it("keeps non-digit formatting stable", () => {
    const asYouType = new AsYouType("US");
    expect(asYouType.input("(213)373-4253")).toBe("(213) 373-4253");
  });

  it("formats UK national number as you type", () => {
    const asYouType = new AsYouType("GB");
    expect(asYouType.input("020")).toBe("020");
    expect(asYouType.input("79460123")).toBe("020 7946 0123");
  });

  it("formats based on selected calling code country", () => {
    // This mirrors how the UI component picks a country for a calling code and then formats.
    // Calling code +1 should typically map to US formatting.
    const asYouType = new AsYouType("US");
    expect(asYouType.input("2133734253")).toBe("(213) 373-4253");

    // Calling code +44 should typically map to GB formatting.
    const asYouTypeGb = new AsYouType("GB");
    expect(asYouTypeGb.input("02079460123")).toBe("020 7946 0123");
  });
});
