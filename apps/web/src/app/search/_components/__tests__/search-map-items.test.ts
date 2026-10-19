import { describe, expect, it } from "vitest";

import {
  areaPxAtZoom0,
  buildAreaCentreGeoJson,
  buildAreaGeoJson,
  buildMarkGeoJson,
  classifyPrecision,
  countPrivateVenues,
  itemBounds,
  mapItemKey,
  parseMapItemKey,
  toEventMapItem,
  toVenueMapItem,
  venueHref,
} from "../search-map-items";

const venue = (extra: Record<string, unknown>) => ({
  id: "place_1",
  placeId: "p1",
  title: "Fishbowl House",
  city: "Nashville",
  pageSlug: "fishbowl-house-p1",
  lat: 36.18,
  lng: -86.74,
  ...extra,
});
const event = (extra: Record<string, unknown>) => ({
  eventId: "e1",
  title: "Show",
  subtitle: "East Nashville",
  slug: "show",
  lat: 36.17,
  lng: -86.78,
  ...extra,
});

describe("classifyPrecision — how a public point may be drawn", () => {
  it("exact → a mark", () => {
    expect(classifyPrecision({ lat: 1, lng: 2, locationIsExact: true }, false)).toEqual({
      precision: "exact",
      radiusMeters: null,
    });
  });

  it("approximate with a radius → a circle at that radius (never a pin)", () => {
    expect(
      classifyPrecision({ lat: 1, lng: 2, locationIsExact: false, locationRadiusMeters: 1000 }, false),
    ).toEqual({ precision: "area", radiusMeters: 1000 });
  });

  it("no coordinates → not plotted", () => {
    expect(classifyPrecision({ lat: null, lng: 2, locationIsExact: true }, true)).toBeNull();
  });

  it("not exact, no radius: a venue is not plotted; a (stale) event is a soft approx marker, never a pin", () => {
    expect(classifyPrecision({ lat: 1, lng: 2 }, false)).toBeNull();
    expect(classifyPrecision({ lat: 1, lng: 2 }, true)).toEqual({
      precision: "approx",
      radiusMeters: null,
    });
  });
});

describe("toVenueMapItem / toEventMapItem", () => {
  it("an exact venue is a square mark linking to its page", () => {
    expect(toVenueMapItem(venue({ locationIsExact: true }))).toMatchObject({
      key: "venue:place_1",
      kind: "venue",
      precision: "exact",
      href: "/places/fishbowl-house-p1",
      subtitle: "Nashville",
    });
  });

  it("an OBSCURED venue is an area at its published radius", () => {
    expect(
      toVenueMapItem(venue({ locationIsExact: false, locationRadiusMeters: 1000 })),
    ).toMatchObject({ precision: "area", radiusMeters: 1000 });
  });

  it("a hidden venue is not plotted, and ONLY the server's hidden flag counts as private", () => {
    const hidden = venue({ lat: null, lng: null, locationIsExact: false, locationHidden: true });
    expect(toVenueMapItem(hidden)).toBeNull();
    // Off the map but NOT private: an un-geocoded EXACT venue, and a stale row
    // indexed before the flag existed. Neither may be called private.
    const ungeocoded = venue({ lat: null, lng: null, locationIsExact: true, locationHidden: false });
    const stale = venue({ lat: null, lng: null });
    expect(toVenueMapItem(ungeocoded)).toBeNull();
    expect(toVenueMapItem(stale)).toBeNull();
    expect(
      countPrivateVenues([
        hidden,
        ungeocoded,
        stale,
        venue({ locationIsExact: true }),
        venue({ locationIsExact: false, locationRadiusMeters: 500 }),
      ]),
    ).toBe(1);
  });

  it("an approximate EVENT is an area, not a pin (the old map hardcoded obscured:false)", () => {
    expect(
      toEventMapItem(event({ locationIsExact: false, locationRadiusMeters: 500 })),
    ).toMatchObject({ key: "event:e1", precision: "area", radiusMeters: 500, href: "/events/show" });
  });

  it("venueHref falls back to the id route, never a slug that 404s", () => {
    expect(venueHref({ pageSlug: null, placeId: "p9" })).toBe("/places/id/p9");
  });
});

describe("map-item keys", () => {
  it("round-trip and reject junk", () => {
    expect(parseMapItemKey(mapItemKey("venue", "a:b"))).toEqual({ kind: "venue", id: "a:b" });
    expect(parseMapItemKey("nope")).toBeNull();
    expect(parseMapItemKey("person:1")).toBeNull();
  });
});

describe("GeoJSON builders", () => {
  const items = [
    toEventMapItem(event({ locationIsExact: true }))!,
    toEventMapItem(event({ eventId: "e2", locationIsExact: false, locationRadiusMeters: 500 }))!,
    toVenueMapItem(venue({ locationIsExact: true }))!,
    toVenueMapItem(venue({ id: "place_2", locationIsExact: false, locationRadiusMeters: 1000 }))!,
  ];

  it("marks carry only the EXACT items of one layer", () => {
    expect(buildMarkGeoJson(items, "event").features.map((f) => f.properties.key)).toEqual([
      "event:e1",
    ]);
    expect(buildMarkGeoJson(items, "venue").features.map((f) => f.properties.key)).toEqual([
      "venue:place_1",
    ]);
  });

  it("areas are geographic polygons at the published radius, for both layers", () => {
    const areas = buildAreaGeoJson(items);
    expect(areas.features.map((f) => f.properties.key)).toEqual(["event:e2", "venue:place_2"]);
    // The polygon's northmost vertex sits `radius` metres north of the centre.
    const ring = areas.features[1]!.geometry.coordinates[0]!;
    const maxLat = Math.max(...ring.map(([, lat]) => lat));
    expect((maxLat - 36.18) * 111_320).toBeCloseTo(1000, 0);
  });

  it("area centres carry the zoom-0 pixel radius used to swap the stand-in marker", () => {
    const centres = buildAreaCentreGeoJson(items);
    expect(centres.features).toHaveLength(2);
    const venueCentre = centres.features.find((f) => f.properties.kind === "venue")!;
    expect(venueCentre.properties.rpx0).toBeCloseTo(areaPxAtZoom0(1000, 36.18), 10);
    // ~1 km is ~65px of radius at zoom 16 in Nashville.
    expect(venueCentre.properties.rpx0 * 2 ** 16).toBeGreaterThan(50);
  });

  it("bounds include a circle's full extent", () => {
    const b = itemBounds([items[3]!])!;
    expect((b[1][1] - b[0][1]) * 111_320).toBeCloseTo(2000, 0);
    expect(itemBounds([])).toBeNull();
  });
});
