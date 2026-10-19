import { describe, expect, it } from "vitest";

import {
  ceilingLocksExact,
  ceilingRadiusFloor,
  clampToCeiling,
  isArchivedPlacePrivacyRead,
  shouldRetryPlacePrivacyRead,
  type VenueLocationCeiling,
} from "../venue-location-ceiling";

/**
 * The UI half of the venue ceiling. The server's `applyPlaceLocationFloor` is
 * the guarantee; these cases mirror its direction exactly, because a UI that
 * clamped DIFFERENTLY would be worse than one that did not clamp at all — it
 * would show the organizer one answer and store another.
 */
describe("ceilingLocksExact", () => {
  it("locks for every ceiling except `none` — including `checking`", () => {
    expect(ceilingLocksExact({ state: "none" })).toBe(false);
    expect(ceilingLocksExact({ state: "checking" })).toBe(true);
    expect(ceilingLocksExact({ state: "hidden", venueName: "X" })).toBe(true);
    expect(
      ceilingLocksExact({ state: "area", venueName: "X", radiusMeters: 500 }),
    ).toBe(true);
  });
});

describe("ceilingRadiusFloor", () => {
  it("is the venue's radius for a circle ceiling and null otherwise", () => {
    expect(
      ceilingRadiusFloor({ state: "area", venueName: "X", radiusMeters: 800 }),
    ).toBe(800);
    // A hidden venue removes the circle rather than flooring it.
    expect(ceilingRadiusFloor({ state: "hidden", venueName: "X" })).toBeNull();
    expect(ceilingRadiusFloor({ state: "none" })).toBeNull();
    expect(ceilingRadiusFloor({ state: "checking" })).toBeNull();
  });
});

describe("clampToCeiling", () => {
  const hidden: VenueLocationCeiling = { state: "hidden", venueName: "Bat Cave" };
  const area: VenueLocationCeiling = {
    state: "area",
    venueName: "Bat Cave",
    radiusMeters: 1000,
  };

  it("leaves the request alone when there is no venue", () => {
    const requested = { mode: "EXACT" as const, radiusMeters: null };
    expect(clampToCeiling(requested, { state: "none" })).toEqual(requested);
  });

  it("does NOT clamp while the venue's setting is still unknown", () => {
    // Locking the control is enough; rewriting a saved choice on the strength
    // of a read that has not come back would be the UI inventing policy.
    const requested = { mode: "EXACT" as const, radiusMeters: null };
    expect(clampToCeiling(requested, { state: "checking" })).toEqual(requested);
  });

  it("forces fully hidden at a fully hidden venue, whatever was asked", () => {
    expect(clampToCeiling({ mode: "EXACT", radiusMeters: null }, hidden)).toEqual(
      { mode: "OBSCURED", radiusMeters: null },
    );
    expect(
      clampToCeiling({ mode: "OBSCURED", radiusMeters: 100 }, hidden),
    ).toEqual({ mode: "OBSCURED", radiusMeters: null });
  });

  it("adopts the venue's radius when the event asked for EXACT at a circle venue", () => {
    expect(clampToCeiling({ mode: "EXACT", radiusMeters: 200 }, area)).toEqual({
      mode: "OBSCURED",
      radiusMeters: 1000,
    });
  });

  it("widens a tighter event circle to the venue's", () => {
    expect(
      clampToCeiling({ mode: "OBSCURED", radiusMeters: 200 }, area),
    ).toEqual({ mode: "OBSCURED", radiusMeters: 1000 });
  });

  it("keeps a WIDER event circle — more private already", () => {
    expect(
      clampToCeiling({ mode: "OBSCURED", radiusMeters: 5000 }, area),
    ).toEqual({ mode: "OBSCURED", radiusMeters: 5000 });
  });

  it("keeps a fully hidden EVENT at a circle venue — null is stricter than any circle", () => {
    expect(
      clampToCeiling({ mode: "OBSCURED", radiusMeters: null }, area),
    ).toEqual({ mode: "OBSCURED", radiusMeters: null });
  });
});

describe("shouldRetryPlacePrivacyRead", () => {
  const archived = { data: { code: "NOT_FOUND", appCode: "PLACE_ARCHIVED" } };

  it("never retries a NOT_FOUND: an archived or missing place is the answer", () => {
    expect(shouldRetryPlacePrivacyRead(0, archived)).toBe(false);
    expect(
      shouldRetryPlacePrivacyRead(0, { data: { code: "NOT_FOUND" } }),
    ).toBe(false);
    expect(
      shouldRetryPlacePrivacyRead(0, { shape: { data: { code: "NOT_FOUND" } } }),
    ).toBe(false);
  });

  it("retries a transient failure once, never twice", () => {
    expect(shouldRetryPlacePrivacyRead(0, {})).toBe(true);
    expect(
      shouldRetryPlacePrivacyRead(0, {
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
    ).toBe(true);
    expect(shouldRetryPlacePrivacyRead(1, {})).toBe(false);
    expect(
      shouldRetryPlacePrivacyRead(1, {
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
    ).toBe(false);
  });

  it("does not retry other refusals the server decided", () => {
    expect(
      shouldRetryPlacePrivacyRead(0, { data: { code: "BAD_REQUEST" } }),
    ).toBe(false);
  });
});

describe("isArchivedPlacePrivacyRead", () => {
  it("claims only NOT_FOUND with PLACE_ARCHIVED", () => {
    expect(
      isArchivedPlacePrivacyRead({
        data: { code: "NOT_FOUND", appCode: "PLACE_ARCHIVED" },
      }),
    ).toBe(true);
    expect(
      isArchivedPlacePrivacyRead({
        shape: { data: { code: "NOT_FOUND", appCode: "PLACE_ARCHIVED" } },
      }),
    ).toBe(true);
    expect(
      isArchivedPlacePrivacyRead({
        data: { code: "NOT_FOUND", appCode: "PLACE_NOT_FOUND" },
      }),
    ).toBe(false);
    expect(
      isArchivedPlacePrivacyRead({ data: { code: "INTERNAL_SERVER_ERROR" } }),
    ).toBe(false);
    expect(isArchivedPlacePrivacyRead(null)).toBe(false);
  });
});
