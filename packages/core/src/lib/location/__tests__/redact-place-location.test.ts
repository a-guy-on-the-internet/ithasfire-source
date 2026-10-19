import { describe, expect, it } from "vitest";

import { encodeGeohash } from "../../geo/geohash";
import { haversineDistance } from "../../geo/haversine";
import {
  applyPlaceLocationFloor,
  GEOHASH6_CELL_METERS,
  placeWithholdsAddress,
  redactPlaceLocation,
  type PlaceLocationSource,
} from "../redact-place-location";

/** A punk house: a real street address that must never be published. */
const HOUSE: PlaceLocationSource = {
  id: "00000000-0000-4000-8000-0000000000a1",
  locationMode: "OBSCURED",
  locationRadiusMeters: null,
  locationLabel: "East Nashville",
  formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
  addressLine1: "1417 Shelby Ave",
  addressLine2: "Basement",
  city: "Nashville",
  region: "TN",
  postalCode: "37206",
  countryCode: "US",
  lat: 36.1775,
  lng: -86.7412,
};

const CLUB: PlaceLocationSource = {
  ...HOUSE,
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
};

/** Every field that, if non-null on a withheld place, is a leak. */
const STREET_FIELDS = [
  "formattedAddress",
  "addressLine1",
  "addressLine2",
  "postalCode",
] as const;

describe("redactPlaceLocation", () => {
  it("returns the full address and true pin for an EXACT place", () => {
    const result = redactPlaceLocation(CLUB);

    expect(result.isExact).toBe(true);
    expect(result.hidden).toBe(false);
    expect(result.formattedAddress).toBe("1417 Shelby Ave, Nashville, TN 37206");
    expect(result.addressLine1).toBe("1417 Shelby Ave");
    expect(result.postalCode).toBe("37206");
    expect(result.lat).toBe(36.1775);
    expect(result.lng).toBe(-86.7412);
    expect(result.radiusMeters).toBeNull();
  });

  describe("fully hidden (OBSCURED + null radius)", () => {
    const result = redactPlaceLocation(HOUSE);

    it.each(STREET_FIELDS)("withholds %s", (field) => {
      expect(result[field]).toBeNull();
    });

    it("publishes no coordinates and no radius at all", () => {
      expect(result.lat).toBeNull();
      expect(result.lng).toBeNull();
      expect(result.radiusMeters).toBeNull();
      expect(result.hidden).toBe(true);
      expect(result.isExact).toBe(false);
    });

    it("keeps the COARSE fields so the venue is still findable", () => {
      expect(result.city).toBe("Nashville");
      expect(result.region).toBe("TN");
      expect(result.countryCode).toBe("US");
      expect(result.areaLabel).toBe("East Nashville");
    });

    it("publishes NO geohash at all — a hidden venue has no position (W7)", () => {
      // A cell of the TRUE point is a position: intersected with anything
      // else a viewer knows it narrows the house down. Fully hidden means
      // none. (~38 m x 19 m geohash8 would BE the house.)
      expect(result.geohash6).toBeNull();
      expect(result.geohash8).toBeNull();
    });
  });

  describe("obfuscated circle (OBSCURED + radius)", () => {
    const circled = redactPlaceLocation({
      ...HOUSE,
      locationRadiusMeters: 1000,
    });

    it.each(STREET_FIELDS)("still withholds %s", (field) => {
      expect(circled[field]).toBeNull();
    });

    it("publishes an OFFSET centre, never the true pin", () => {
      expect(circled.hidden).toBe(false);
      expect(circled.isExact).toBe(false);
      expect(circled.radiusMeters).toBe(1000);
      expect(circled.lat).not.toBe(36.1775);
      expect(circled.lng).not.toBe(-86.7412);
    });

    it("is DETERMINISTIC — two surfaces cannot be differenced to triangulate", () => {
      const again = redactPlaceLocation({ ...HOUSE, locationRadiusMeters: 1000 });
      expect(again.lat).toBe(circled.lat);
      expect(again.lng).toBe(circled.lng);
    });

    it("still never publishes a fine geohash", () => {
      expect(circled.geohash8).toBeNull();
      expect(circled.geohash6).toHaveLength(6);
    });

    it("keys geohash6 to the EMITTED centre, never the true point (W7)", () => {
      expect(circled.geohash6).toBe(
        encodeGeohash(circled.lat as number, circled.lng as number, 6),
      );
    });

    it("drops geohash6 once the circle is wider than a cell (W7)", () => {
      const wide = redactPlaceLocation({
        ...HOUSE,
        locationRadiusMeters: GEOHASH6_CELL_METERS,
      });
      expect(wide.hidden).toBe(false);
      expect(wide.geohash6).toBeNull();
      expect(wide.geohash8).toBeNull();
    });

    it("keeps the true point inside the published circle", () => {
      const d = haversineDistance(
        36.1775,
        -86.7412,
        circled.lat as number,
        circled.lng as number,
      );
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(1000);
    });

    it("no place id → no key subject → fully hidden, never the true pin", () => {
      const anonymous = redactPlaceLocation({
        ...HOUSE,
        id: undefined,
        locationRadiusMeters: 1000,
      });
      expect(anonymous.hidden).toBe(true);
      expect(anonymous.lat).toBeNull();
      expect(anonymous.geohash6).toBeNull();
    });
  });

  describe("fail-closed", () => {
    // Anything that is not the literal "EXACT" withholds. These are the shapes
    // a partial fake, a stale projection, or a forgotten column actually
    // produce — and every one of them must land on the private side.
    const notExact = [
      undefined,
      null,
      "",
      "exact",
      "APPROXIMATE",
      "HIDDEN",
      "PUBLIC",
    ];

    it.each(notExact)("treats locationMode %p as withheld", (mode) => {
      const result = redactPlaceLocation({
        ...HOUSE,
        locationMode: mode as never,
      });
      expect(result.isExact).toBe(false);
      expect(result.formattedAddress).toBeNull();
      expect(result.lat).toBeNull();
      expect(result.geohash8).toBeNull();
    });

    it("withholds a row that carries NOTHING but coordinates", () => {
      const result = redactPlaceLocation({ lat: 36.1775, lng: -86.7412 });
      expect(result.isExact).toBe(false);
      expect(result.hidden).toBe(true);
      expect(result.lat).toBeNull();
    });

    it("falls back to 'city, region' when no explicit label is set", () => {
      const result = redactPlaceLocation({ ...HOUSE, locationLabel: null });
      expect(result.areaLabel).toBe("Nashville, TN");
    });

    it("is fully hidden when a radius exists but coordinates do not", () => {
      const result = redactPlaceLocation({
        ...HOUSE,
        locationRadiusMeters: 500,
        lat: null,
        lng: null,
      });
      expect(result.hidden).toBe(true);
      expect(result.radiusMeters).toBeNull();
    });
  });

  describe("viewerCanSeeExact", () => {
    it("unlocks the address ONLY when the caller passes it explicitly", () => {
      const owner = redactPlaceLocation(HOUSE, { viewerCanSeeExact: true });
      expect(owner.isExact).toBe(true);
      expect(owner.formattedAddress).toBe(
        "1417 Shelby Ave, Nashville, TN 37206",
      );
    });

    it("defaults to LOCKED — an omitted option never unlocks", () => {
      expect(redactPlaceLocation(HOUSE, {}).formattedAddress).toBeNull();
      expect(
        redactPlaceLocation(HOUSE, { viewerCanSeeExact: undefined })
          .formattedAddress,
      ).toBeNull();
      expect(
        redactPlaceLocation(HOUSE, { viewerCanSeeExact: false })
          .formattedAddress,
      ).toBeNull();
    });
  });
});

describe("placeWithholdsAddress", () => {
  it("is true for everything that is not the literal EXACT", () => {
    expect(placeWithholdsAddress({ locationMode: "EXACT" })).toBe(false);
    expect(placeWithholdsAddress({ locationMode: "OBSCURED" })).toBe(true);
    expect(placeWithholdsAddress({})).toBe(true);
    expect(placeWithholdsAddress({ locationMode: null })).toBe(true);
  });
});

describe("applyPlaceLocationFloor — the hard ceiling", () => {
  const EXACT_EVENT = {
    locationMode: "EXACT",
    locationRadiusMeters: null,
  } as const;

  it("leaves an event alone when it has no place", () => {
    expect(applyPlaceLocationFloor(EXACT_EVENT, null)).toEqual(EXACT_EVENT);
    expect(applyPlaceLocationFloor(EXACT_EVENT, undefined)).toEqual(
      EXACT_EVENT,
    );
  });

  it("leaves an event alone at a venue that publishes its address", () => {
    expect(applyPlaceLocationFloor(EXACT_EVENT, CLUB)).toEqual(EXACT_EVENT);
  });

  it("forces an EXACT event OBSCURED at a fully-hidden venue", () => {
    expect(applyPlaceLocationFloor(EXACT_EVENT, HOUSE)).toEqual({
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });
  });

  it("forces an EXACT event to the venue's circle", () => {
    expect(
      applyPlaceLocationFloor(EXACT_EVENT, {
        ...HOUSE,
        locationRadiusMeters: 1500,
      }),
    ).toEqual({ locationMode: "OBSCURED", locationRadiusMeters: 1500 });
  });

  it("widens a TIGHTER event circle up to the venue's", () => {
    expect(
      applyPlaceLocationFloor(
        { locationMode: "OBSCURED", locationRadiusMeters: 200 },
        { ...HOUSE, locationRadiusMeters: 1500 },
      ),
    ).toEqual({ locationMode: "OBSCURED", locationRadiusMeters: 1500 });
  });

  it("keeps a WIDER event circle — the floor is a minimum, not a target", () => {
    expect(
      applyPlaceLocationFloor(
        { locationMode: "OBSCURED", locationRadiusMeters: 5000 },
        { ...HOUSE, locationRadiusMeters: 1500 },
      ),
    ).toEqual({ locationMode: "OBSCURED", locationRadiusMeters: 5000 });
  });

  it("keeps a FULLY HIDDEN event hidden at a merely-circled venue", () => {
    // null is MORE private than any circle, so the venue's circle must not
    // relax it back into publishing a point.
    expect(
      applyPlaceLocationFloor(
        { locationMode: "OBSCURED", locationRadiusMeters: null },
        { ...HOUSE, locationRadiusMeters: 1500 },
      ),
    ).toEqual({ locationMode: "OBSCURED", locationRadiusMeters: null });
  });

  it("fails closed on a venue row with an unknown locationMode", () => {
    expect(
      applyPlaceLocationFloor(EXACT_EVENT, {
        locationMode: undefined,
        locationRadiusMeters: null,
      }),
    ).toEqual({ locationMode: "OBSCURED", locationRadiusMeters: null });
  });
});
