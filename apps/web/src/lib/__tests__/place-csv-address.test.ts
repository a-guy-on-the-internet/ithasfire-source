import { describe, expect, it } from "vitest";

import { buildPlaceCsvAddress } from "../place-csv-address";

/**
 * Regression suite for the `"TBD"` sentinel both place CSV importers used to
 * forge into `Place.addrLine1`. The sentinel persisted, fed
 * `Place.address` / `addressHash`, and rendered as the venue's street on its
 * public page — `PlaceMobileCard` still carries a defensive `!== "TBD"`
 * filter because of it.
 */
describe("buildPlaceCsvAddress", () => {
  it("never emits a sentinel for a row with no address columns at all", () => {
    const address = buildPlaceCsvAddress({ name: "Logan Square DIY" });

    expect(address.line1).toBeUndefined();
    // `formatted` is NOT optional server-side (`min(1)`, and `Place.address` is
    // NOT NULL), so it falls back to the only part the row has.
    expect(address.formatted).toBe("US");
    expect(JSON.stringify(address)).not.toContain("TBD");
  });

  it("omits line1 — rather than forging one — when only city/region/country are mapped", () => {
    const address = buildPlaceCsvAddress({
      city: "Chicago",
      region: "IL",
      postalCode: "60647",
      countryCode: "us",
    });

    expect(address.line1).toBeUndefined();
    // Same parts, same order, same join as the place editor's rebuiltAddress.
    expect(address.formatted).toBe("Chicago, IL, 60647, US");
    expect(address.countryCode).toBe("US");
    expect(JSON.stringify(address)).not.toContain("TBD");
  });

  it("prefers the mapped full-address column for `formatted` and the street column for `line1`", () => {
    const address = buildPlaceCsvAddress({
      addressFormatted: "123 Main St, Portland, OR 97201, US",
      addressLine1: "123 Main St",
      addressLine2: "Suite 4",
      city: "Portland",
      region: "OR",
      postalCode: "97201",
      countryCode: "US",
    });

    expect(address).toEqual({
      formatted: "123 Main St, Portland, OR 97201, US",
      line1: "123 Main St",
      line2: "Suite 4",
      city: "Portland",
      region: "OR",
      postalCode: "97201",
      countryCode: "US",
    });
  });

  it("falls back to the full-address column for line1 — real user data, not a constant", () => {
    // A "Full Address" column is very often just the street ("713 Congress
    // Ave" is exactly that in this repo's own seed data).
    const address = buildPlaceCsvAddress({
      addressFormatted: "713 Congress Ave",
      city: "Austin",
    });

    expect(address.line1).toBe("713 Congress Ave");
    expect(address.formatted).toBe("713 Congress Ave");
  });

  it("treats whitespace-only cells as absent instead of writing them through", () => {
    const address = buildPlaceCsvAddress({
      addressFormatted: "   ",
      addressLine1: "  ",
      addressLine2: " ",
      city: "  Boise  ",
      region: "",
      postalCode: "   ",
      countryCode: " ca ",
    });

    expect(address.line1).toBeUndefined();
    expect(address.line2).toBeUndefined();
    expect(address.region).toBeUndefined();
    expect(address.postalCode).toBeUndefined();
    expect(address.city).toBe("Boise");
    expect(address.countryCode).toBe("CA");
    expect(address.formatted).toBe("Boise, CA");
  });
});
