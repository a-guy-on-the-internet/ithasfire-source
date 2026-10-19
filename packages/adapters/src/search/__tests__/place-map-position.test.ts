import { describe, expect, it } from "vitest";

import { placeMapPosition } from "../place-map-position";

describe("placeMapPosition — fails closed", () => {
  it("exact + point → the pin, never a radius", () => {
    expect(placeMapPosition(36.1, -86.7, true, 500)).toEqual({
      lat: 36.1,
      lng: -86.7,
      locationIsExact: true,
      locationRadiusMeters: null,
      locationHidden: false,
    });
  });

  it("not exact + radius → the circle centre and its radius", () => {
    expect(placeMapPosition(36.1, -86.7, false, 1000)).toEqual({
      lat: 36.1,
      lng: -86.7,
      locationIsExact: false,
      locationRadiusMeters: 1000,
      locationHidden: false,
    });
  });

  it.each([
    ["no radius", false, null],
    ["stale row: flags undefined", undefined, undefined],
    ["zero radius", false, 0],
    ["NaN radius", false, Number.NaN],
  ])("%s → no coordinates, and NOT claimed private (it still had a point)", (_label, exact, radius) => {
    expect(placeMapPosition(36.1, -86.7, exact, radius)).toEqual({
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      locationHidden: false,
    });
  });

  it("not exact AND no point → hidden: redactPlaceLocation's `hidden`", () => {
    expect(placeMapPosition(null, null, false, null)).toMatchObject({ locationHidden: true });
    // A stale row (flags absent) with no point is indistinguishable from a
    // hidden one until reindexed — reads hidden. Documented residual.
    expect(placeMapPosition(null, null, undefined, undefined)).toMatchObject({
      locationHidden: true,
    });
  });

  it("an EXACT venue with no point is off the map but NOT private (un-geocoded)", () => {
    expect(placeMapPosition(null, -86.7, true, null)).toMatchObject({
      lat: null,
      lng: null,
      locationHidden: false,
    });
  });
});
