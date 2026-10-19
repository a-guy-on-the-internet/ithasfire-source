import { describe, expect, it } from "vitest";

import { lookupOwn } from "../lookup-own";

const TABLE: Record<string, string> = { a: "alpha", empty: "" };

describe("lookupOwn", () => {
  it("returns own values, including falsy ones", () => {
    expect(lookupOwn(TABLE, "a")).toBe("alpha");
    expect(lookupOwn(TABLE, "empty")).toBe("");
  });

  it("returns undefined for a missing key", () => {
    expect(lookupOwn(TABLE, "nope")).toBeUndefined();
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "returns undefined for inherited %s",
    (key) => {
      expect(lookupOwn(TABLE, key)).toBeUndefined();
    },
  );

  it("returns undefined for null / undefined keys", () => {
    expect(lookupOwn(TABLE, null)).toBeUndefined();
    expect(lookupOwn(TABLE, undefined)).toBeUndefined();
  });

  it("finds an own key literally named like a prototype member", () => {
    const own = Object.fromEntries([["constructor", "mine"]]);
    expect(lookupOwn(own, "constructor")).toBe("mine");
  });
});
