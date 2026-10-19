import { describe, expect, it } from "vitest";

import {
  formatOrderCode,
  orderIdentifierClauses,
  orderIdentifierFromQuery,
} from "../order-identifier";

const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";

describe("formatOrderCode", () => {
  it("matches what the dashboard renders, minus the '#'", () => {
    // Reference renderers: apps/web/src/app/admin/[slug]/dashboard/
    // _components/DashboardContent.tsx (`#{order.id.slice(-8).toUpperCase()}`).
    expect(formatOrderCode(ORDER_ID)).toBe(ORDER_ID.slice(-8).toUpperCase());
    expect(formatOrderCode(ORDER_ID)).toBe("DB21B2C3");
  });

  it("returns no leading '#' — callers add it", () => {
    expect(formatOrderCode(ORDER_ID).startsWith("#")).toBe(false);
  });

  it("is total on short input rather than throwing", () => {
    expect(formatOrderCode("abc")).toBe("ABC");
    expect(formatOrderCode("")).toBe("");
  });
});

describe("formatOrderCode / orderIdentifierFromQuery round trip", () => {
  it("a displayed code parses back to the lowercased id suffix", () => {
    const displayed = formatOrderCode(ORDER_ID);
    expect(orderIdentifierFromQuery(displayed)).toEqual({
      idSuffix: ORDER_ID.slice(-8),
    });
  });

  it("survives the leading '#' users paste along with it", () => {
    const displayed = `#${formatOrderCode(ORDER_ID)}`;
    expect(orderIdentifierFromQuery(displayed)).toEqual({
      idSuffix: ORDER_ID.slice(-8),
    });
  });

  it("produces a clause that would match the order it came from", () => {
    expect(orderIdentifierClauses(formatOrderCode(ORDER_ID))).toEqual([
      { id: { endsWith: ORDER_ID.slice(-8), mode: "insensitive" } },
    ]);
  });
});

describe("orderIdentifierFromQuery", () => {
  it("recognises a full UUID and normalises it down", () => {
    expect(orderIdentifierFromQuery(ORDER_ID.toUpperCase())).toEqual({
      id: ORDER_ID,
    });
  });

  it("returns null for free text", () => {
    expect(orderIdentifierFromQuery("ada lovelace")).toBeNull();
    expect(orderIdentifierFromQuery("  ")).toBeNull();
  });

  it("rejects an 8-char non-hex word", () => {
    expect(orderIdentifierFromQuery("someword")).toBeNull();
  });

  /**
   * Regression: `Order.shortId` (10 random base-36 chars) was removed from the
   * backend. A 10-char base-36 string must no longer look like an order
   * identifier — otherwise search would issue a lookup against a column the
   * code no longer reads.
   */
  it("does NOT treat a 10-char base-36 string as an order identifier", () => {
    for (const legacyShortId of ["dbzsucafur", "k3f9q1z7ab", "javascript"]) {
      expect(orderIdentifierFromQuery(legacyShortId)).toBeNull();
      expect(orderIdentifierFromQuery(`#${legacyShortId}`)).toBeNull();
      expect(orderIdentifierClauses(legacyShortId)).toEqual([]);
    }
  });
});

describe("orderIdentifierClauses", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(orderIdentifierClauses(null)).toEqual([]);
    expect(orderIdentifierClauses(undefined)).toEqual([]);
    expect(orderIdentifierClauses("")).toEqual([]);
  });

  it("emits an exact-equality clause for a full UUID", () => {
    expect(orderIdentifierClauses(ORDER_ID)).toEqual([{ id: ORDER_ID }]);
  });
});
