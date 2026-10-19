import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAddressReveal } from "../../../use-cases/events/_shared/save-event-shared";
import { encodeGeohash } from "../../geo/geohash";
import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../obfuscation-key";
import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  exactPlaceLocationColumns,
  placeEventProjectionChanged,
  placeExactAddressChanged,
  projectEventLocationAtPlace,
  projectPlaceLocationForEvents,
  type PlaceEventLocationSource,
} from "../place-event-location";
import {
  applyPlaceLocationFloor,
  redactPlaceLocation,
} from "../redact-place-location";

/**
 * D1: THE SECRET LIVES IN ONE TABLE. What an Event row may store for a
 * place-linked event. Pinned here as a pure rule; the adapter applies it on
 * every `upsertDraft` and `upsertPlace` applies it to every event on a
 * privacy change.
 */

const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const TRUE_LAT = 36.1775;
const TRUE_LNG = -86.7412;

function house(
  overrides: Partial<PlaceEventLocationSource> = {},
): PlaceEventLocationSource {
  return {
    id: PLACE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    addressLine1: "1417 Shelby Ave",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    ...overrides,
  };
}

/**
 * THE HISTORICAL COPY, verbatim from the pre-D1 events adapter — the oracle
 * for "an EXACT venue is stored exactly as before". Reset-to-null, then each
 * column only when the place value is truthy, the pair only when both exist.
 */
function legacyCopy(place: {
  lat: number | null;
  lng: number | null;
  address: string;
  city: string | null;
  region: string | null;
  country: string | null;
  postcode: string | null;
}) {
  const data: Record<string, unknown> = {
    addressText: null,
    lat: null,
    lng: null,
    geohash6: null,
    locality: null,
    region: null,
    countryCode: null,
    postalCode: null,
  };
  if (place?.lat != null && place?.lng != null) {
    data.lat = place.lat;
    data.lng = place.lng;
    data.geohash6 = encodeGeohash(place.lat, place.lng, 6);
  }
  if (place?.address) data.addressText = place.address;
  if (place?.city) data.locality = place.city;
  if (place?.region) data.region = place.region;
  if (place?.country) data.countryCode = place.country;
  if (place?.postcode) data.postalCode = place.postcode;
  return data;
}

beforeEach(() => {
  configureLocationObfuscation({ secret: "place-event-location-test" });
});

afterEach(() => {
  resetLocationObfuscationForTests();
});

describe("an EXACT venue: the event stores the truth, byte-identical to before", () => {
  const rows = [
    {
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      address: "917 Woodland St",
      city: "Nashville",
      region: "TN",
      country: "US",
      postcode: "37206",
    },
    // Empty strings stayed NULL under the truthy guards.
    { lat: 1, lng: 2, address: "", city: "", region: "", country: "", postcode: "" },
    // Half a coordinate pair copied nothing.
    { lat: 1, lng: null, address: "x", city: null, region: null, country: null, postcode: null },
    { lat: null, lng: null, address: "x", city: "c", region: null, country: "US", postcode: null },
  ];

  it.each(rows)("matches the legacy copy for %o", (row) => {
    const source: PlaceEventLocationSource = {
      id: PLACE_ID,
      locationMode: "EXACT",
      formattedAddress: row.address,
      city: row.city,
      region: row.region,
      countryCode: row.country,
      postalCode: row.postcode,
      lat: row.lat,
      lng: row.lng,
    };
    expect(exactPlaceLocationColumns(source)).toEqual(legacyCopy(row));

    const projected = projectEventLocationAtPlace(source, {
      locationMode: "OBSCURED",
      locationRadiusMeters: 250,
    });
    // An EXACT venue never touches the event's own privacy choice.
    expect(projected.withheld).toBe(false);
    expect(projected.columns).toEqual(legacyCopy(row));
  });
});

describe("a withheld venue: the event stores ONLY the public projection", () => {
  it("OBSCURED with a radius: centre = the venue's public circle, no street, no postcode", () => {
    const projected = projectEventLocationAtPlace(house(), {
      locationMode: "EXACT",
      locationRadiusMeters: 500,
    });
    const venuePublic = redactPlaceLocation(house());

    expect(projected.withheld).toBe(true);
    if (!projected.withheld) return;
    expect(projected.privacy).toEqual({
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
    });
    expect(projected.columns).toEqual({
      lat: venuePublic.lat,
      lng: venuePublic.lng,
      geohash6: venuePublic.geohash6,
      addressText: "East Nashville",
      locality: "Nashville",
      region: "TN",
      countryCode: "US",
      postalCode: null,
    });
    // The centre is NOT the house.
    expect(projected.columns.lat).not.toBe(TRUE_LAT);
    expect(projected.columns.lng).not.toBe(TRUE_LNG);
    expect(JSON.stringify(projected.columns)).not.toMatch(/Shelby|37206/);
  });

  it("an event radius wider than the venue's keeps its own (max), centre unchanged", () => {
    const projected = projectEventLocationAtPlace(house(), {
      locationMode: "OBSCURED",
      locationRadiusMeters: 5000,
    });
    expect(projected.withheld && projected.privacy.locationRadiusMeters).toBe(5000);
    expect(projected.columns.lat).toBe(redactPlaceLocation(house()).lat);
  });

  it("FULLY HIDDEN venue: no coordinates at all", () => {
    const projected = projectEventLocationAtPlace(
      house({ locationRadiusMeters: null }),
      { locationMode: "OBSCURED", locationRadiusMeters: 2000 },
    );
    expect(projected.withheld && projected.privacy).toEqual({
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });
    expect(projected.columns).toMatchObject({
      lat: null,
      lng: null,
      geohash6: null,
      postalCode: null,
      addressText: "East Nashville",
    });
  });

  it("an event that asked to be fully hidden stays hidden at a circle venue — no centre", () => {
    const projected = projectEventLocationAtPlace(house(), {
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });
    expect(projected.withheld && projected.privacy.locationRadiusMeters).toBeNull();
    expect(projected.columns.lat).toBeNull();
    expect(projected.columns.lng).toBeNull();
  });

  it("falls back to 'city, region' when the venue has no area label", () => {
    const projected = projectEventLocationAtPlace(
      house({ locationLabel: null }),
      { locationMode: "EXACT", locationRadiusMeters: 500 },
    );
    expect(projected.columns.addressText).toBe("Nashville, TN");
  });

  it("FAIL-CLOSED: an unrecognised / missing locationMode is withheld", () => {
    for (const locationMode of [null, undefined, "", "exact", "APPROXIMATE"]) {
      const projected = projectEventLocationAtPlace(
        house({ locationMode: locationMode as never }),
        { locationMode: "EXACT", locationRadiusMeters: 500 },
      );
      expect(projected.withheld).toBe(true);
      expect(projected.columns.postalCode).toBeNull();
      expect(projected.columns.addressText).toBe("East Nashville");
    }
  });

  it("FAIL-CLOSED: with no obfuscation key there is no centre (never the true point)", () => {
    resetLocationObfuscationForTests();
    const projected = projectEventLocationAtPlace(house(), {
      locationMode: "EXACT",
      locationRadiusMeters: 500,
    });
    expect(projected.columns.lat).toBeNull();
    expect(projected.columns.lng).toBeNull();
  });

  it("the privacy floor is exactly `applyPlaceLocationFloor`", () => {
    const venueRadii = [null, 100, 800, 5000];
    const requests = [
      { locationMode: "EXACT" as const, locationRadiusMeters: 500 },
      { locationMode: "EXACT" as const, locationRadiusMeters: null },
      { locationMode: "OBSCURED" as const, locationRadiusMeters: null },
      { locationMode: "OBSCURED" as const, locationRadiusMeters: 250 },
      { locationMode: "OBSCURED" as const, locationRadiusMeters: 3000 },
    ];
    for (const r of venueRadii) {
      for (const requested of requests) {
        const place = house({ locationRadiusMeters: r });
        const projected = projectEventLocationAtPlace(place, requested);
        expect(projected.withheld && projected.privacy).toEqual(
          applyPlaceLocationFloor(requested, place),
        );
      }
    }
  });
});

describe("the venue-level projection (what the cascade hands the repo)", () => {
  it("carries the CONFIGURED venue radius even when there is no point to draw", () => {
    const projection = projectPlaceLocationForEvents(
      house({ lat: null, lng: null }),
    );
    expect(projection).toMatchObject({
      kind: "withheld",
      venueRadiusMeters: 800,
      publicCentre: null,
    });
  });
});

describe("the default reveal schedule matches the save path's", () => {
  it("DAY_BEFORE, startsAt − 24h — the value resolveAddressReveal gives a new OBSCURED event", () => {
    const startsAt = new Date("2026-10-10T20:00:00.000Z");
    const resolved = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: undefined,
      addressRevealAt: undefined,
      existingEvent: null,
      now: new Date("2026-09-25T00:00:00.000Z"),
    });
    expect(resolved.preset).toBe(WITHHELD_EVENT_DEFAULT_REVEAL.preset);
    expect(resolved.at).toEqual(
      new Date(startsAt.getTime() - WITHHELD_EVENT_DEFAULT_REVEAL.leadMs),
    );
  });
});

describe("placeEventProjectionChanged — when upsertPlace must cascade", () => {
  const exact = house({ locationMode: "EXACT", locationRadiusMeters: null });

  it.each([
    ["EXACT → withheld", exact, house()],
    ["withheld → EXACT", house(), exact],
    ["radius tightened", house(), house({ locationRadiusMeters: 2000 })],
    ["radius loosened", house({ locationRadiusMeters: 2000 }), house()],
    ["circle → fully hidden", house(), house({ locationRadiusMeters: null })],
    ["label changed while withheld", house(), house({ locationLabel: "Nashville" })],
    ["moved while withheld", house(), house({ lat: 36.2 })],
    ["city changed while withheld", house(), house({ city: "Madison" })],
  ])("%s → cascades", (_label, before, after) => {
    expect(placeEventProjectionChanged(before, after)).toBe(true);
  });

  it.each([
    ["nothing changed (withheld)", house(), house()],
    ["nothing changed (EXACT)", exact, exact],
    // Not a PROJECTION change: an EXACT venue's address edit is the
    // address follow's (`placeExactAddressChanged`, upcoming events only).
    ["EXACT address edit", exact, { ...exact, formattedAddress: "2 Other St", lat: 1 }],
    ["street edit while withheld (not in the projection)", house(), house({ formattedAddress: "9 Else St" })],
  ])("%s → no cascade", (_label, before, after) => {
    expect(placeEventProjectionChanged(before, after)).toBe(false);
  });
});

describe("placeExactAddressChanged — when events follow an EXACT venue's address edit", () => {
  const exact = house({ locationMode: "EXACT", locationRadiusMeters: null });

  it.each([
    ["street text", { formattedAddress: "1500 Shelby Ave, Nashville, TN 37206" }],
    ["coordinates", { lat: 36.2 }],
    ["one coordinate dropped", { lng: null }],
    ["city", { city: "Madison" }],
    ["region", { region: "KY" }],
    ["postcode", { postalCode: "37207" }],
    ["country", { countryCode: "CA" }],
  ])("%s changed → follows", (_label, patch) => {
    expect(placeExactAddressChanged(exact, { ...exact, ...patch })).toBe(true);
  });

  it.each([
    ["nothing changed", exact, exact],
    // Not copied onto events, so not a follow.
    ["addressLine1 only", exact, { ...exact, addressLine1: "Unit 2" }],
    ["label only", exact, { ...exact, locationLabel: "Back room" }],
    // Empty string and null both store NULL on the event.
    ["'' ↔ null postcode", { ...exact, postalCode: "" }, { ...exact, postalCode: null }],
    // Privacy changes belong to placeEventProjectionChanged.
    ["EXACT → withheld", exact, { ...house(), formattedAddress: "9 Else St" }],
    ["withheld → EXACT", house(), { ...exact, formattedAddress: "9 Else St" }],
    ["withheld → withheld", house(), house({ formattedAddress: "9 Else St" })],
  ])("%s → does not follow", (_label, before, after) => {
    expect(placeExactAddressChanged(before, after)).toBe(false);
  });
});
