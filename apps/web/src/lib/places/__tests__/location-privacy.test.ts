import { describe, expect, it } from "vitest";

import {
  placeAllowsDirections,
  resolvePlaceLocationPrivacy,
} from "../location-privacy";

/**
 * The fail-closed contract, pinned.
 *
 * Every case below is a shape a real caller hands this function today —
 * `EntitySummary`'s PLACE arm (flags optional), the `location_map` block's JSON
 * bag (flags absent on old rows), a client-side fallback summary. The whole
 * point is that NONE of them can accidentally read as "exact".
 */
describe("resolvePlaceLocationPrivacy — fail closed", () => {
  it("treats a missing source as fully hidden", () => {
    expect(resolvePlaceLocationPrivacy(undefined).kind).toBe("hidden");
    expect(resolvePlaceLocationPrivacy(null).kind).toBe("hidden");
  });

  it("treats an ABSENT locationIsExact as withheld, even with coordinates", () => {
    const privacy = resolvePlaceLocationPrivacy({
      lat: 36.17,
      lng: -86.75,
      city: "Nashville",
      region: "TN",
    });
    expect(privacy.kind).toBe("hidden");
    expect(placeAllowsDirections(privacy, "917 Woodland St")).toBe(false);
  });

  it("treats a NON-BOOLEAN truthy locationIsExact as withheld", () => {
    const privacy = resolvePlaceLocationPrivacy({
      // A projection that stringified the flag somewhere upstream.
      locationIsExact: "true" as unknown as boolean,
      lat: 36.17,
      lng: -86.75,
    });
    expect(privacy.kind).toBe("hidden");
  });

  it("is fully hidden when withheld with no radius", () => {
    const privacy = resolvePlaceLocationPrivacy({
      locationIsExact: false,
      locationHidden: true,
      locationRadiusMeters: null,
      areaLabel: "East Nashville",
    });
    expect(privacy).toEqual({ kind: "hidden", areaLabel: "East Nashville" });
  });

  it("is fully hidden when withheld WITH a radius but no centre to draw it on", () => {
    // A partial projection is not a licence to guess at a circle.
    const privacy = resolvePlaceLocationPrivacy({
      locationIsExact: false,
      locationRadiusMeters: 1000,
      lat: null,
      lng: null,
    });
    expect(privacy.kind).toBe("hidden");
  });

  it("is fully hidden when locationHidden is true even if a stray radius rode along", () => {
    const privacy = resolvePlaceLocationPrivacy({
      locationIsExact: false,
      locationHidden: true,
      locationRadiusMeters: 1000,
      lat: 36.17,
      lng: -86.75,
    });
    expect(privacy.kind).toBe("hidden");
  });

  it("draws a circle when withheld with a radius and a centre", () => {
    const privacy = resolvePlaceLocationPrivacy({
      locationIsExact: false,
      locationHidden: false,
      locationRadiusMeters: 1200,
      lat: 36.17,
      lng: -86.75,
      areaLabel: "East Nashville",
    });
    expect(privacy).toEqual({
      kind: "area",
      lat: 36.17,
      lng: -86.75,
      radiusMeters: 1200,
      areaLabel: "East Nashville",
    });
  });

  it("unlocks exact ONLY on the literal true", () => {
    const privacy = resolvePlaceLocationPrivacy({
      locationIsExact: true,
      lat: 36.17,
      lng: -86.75,
      city: "Nashville",
      region: "TN",
    });
    expect(privacy.kind).toBe("exact");
    expect(placeAllowsDirections(privacy)).toBe(true);
  });

  it("falls back to city, region when no explicit area label exists", () => {
    expect(
      resolvePlaceLocationPrivacy({
        locationIsExact: false,
        city: "Nashville",
        region: "TN",
      }).areaLabel,
    ).toBe("Nashville, TN");
  });

  it("prefers the explicit area label over city, region", () => {
    expect(
      resolvePlaceLocationPrivacy({
        locationIsExact: false,
        areaLabel: "  East Nashville  ",
        city: "Nashville",
        region: "TN",
      }).areaLabel,
    ).toBe("East Nashville");
  });

  it("rejects a non-finite radius rather than drawing a NaN circle", () => {
    expect(
      resolvePlaceLocationPrivacy({
        locationIsExact: false,
        locationRadiusMeters: Number.NaN,
        lat: 36.17,
        lng: -86.75,
      }).kind,
    ).toBe("hidden");
  });
});

describe("placeAllowsDirections", () => {
  it("is false for every withheld state, address string or not", () => {
    const area = resolvePlaceLocationPrivacy({
      locationIsExact: false,
      locationRadiusMeters: 1000,
      lat: 36.17,
      lng: -86.75,
    });
    const hidden = resolvePlaceLocationPrivacy({ locationIsExact: false });
    expect(placeAllowsDirections(area, "917 Woodland St")).toBe(false);
    expect(placeAllowsDirections(hidden, "917 Woodland St")).toBe(false);
  });

  it("is true for an exact venue with only an address (no coordinates)", () => {
    const privacy = resolvePlaceLocationPrivacy({ locationIsExact: true });
    expect(placeAllowsDirections(privacy, "917 Woodland St")).toBe(true);
  });

  it("is false for an exact venue with neither coordinates nor an address", () => {
    const privacy = resolvePlaceLocationPrivacy({ locationIsExact: true });
    expect(placeAllowsDirections(privacy, "   ")).toBe(false);
  });
});
