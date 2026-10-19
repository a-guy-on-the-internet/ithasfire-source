import { describe, expect, it } from "vitest";

import { listingClosedKind, listingClosedKindFromAppCode } from "../listing-closed";

describe("listingClosedKind", () => {
  it.each([
    ["CANCELLED", "takenDown"],
    ["ARCHIVED", "takenDown"],
    ["COMPLETED", "ended"],
    ["PUBLISHED", null],
    ["DRAFT", null],
    [undefined, null],
  ])("%s → %s", (status, kind) => {
    expect(listingClosedKind(status)).toBe(kind);
  });
});

describe("listingClosedKindFromAppCode", () => {
  it.each([
    ["EVENT_ALREADY_CANCELLED", "takenDown"],
    ["EVENT_ARCHIVED", "takenDown"],
    ["EVENT_ALREADY_COMPLETED", "ended"],
    ["RECURRENCE_HAS_NO_UPCOMING_DATES", null],
    [null, null],
  ])("%s → %s", (code, kind) => {
    expect(listingClosedKindFromAppCode(code)).toBe(kind);
  });
});
