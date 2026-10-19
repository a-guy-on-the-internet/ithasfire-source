import { describe, expect, it } from "vitest";

import { haversineDistance } from "../../geo/haversine";
import {
  projectPublicEventLocation,
  publicDistanceMeters,
  unreadablePlaceLocation,
  type PublicEventLocationSource,
} from "../project-public-event-location";
import {
  eventCircleSubject,
  roundPointForCircle,
} from "../event-circle-subject";
import { publicIcalLocation } from "../public-ical-location";
import {
  redactPlaceLocation,
  type PlaceLocationSource,
} from "../redact-place-location";

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
const TRUE = { lat: 36.1775, lng: -86.7412 };
const STREET = "1417 Shelby Ave, Nashville, TN 37206";

const EXACT_EVENT: PublicEventLocationSource = {
  id: EVENT_ID,
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: 500,
  locationLabel: null,
  addressText: STREET,
  locality: "Nashville",
  region: "TN",
  countryCode: "US",
  postalCode: "37206",
  ...TRUE,
};

const OBSCURED_EVENT: PublicEventLocationSource = {
  ...EXACT_EVENT,
  locationMode: "OBSCURED",
  locationRadiusMeters: 500,
  locationLabel: "East side",
};

/** A venue that publishes its address. */
const CLUB: PlaceLocationSource = {
  id: PLACE_ID,
  locationMode: "EXACT",
  locationRadiusMeters: null,
  formattedAddress: STREET,
  city: "Nashville",
  region: "TN",
  countryCode: "US",
  postalCode: "37206",
  ...TRUE,
};

/** A house venue that withholds its address behind a 1,000 m circle. */
const HOUSE: PlaceLocationSource = {
  ...CLUB,
  locationMode: "OBSCURED",
  locationRadiusMeters: 1000,
  locationLabel: "East Nashville",
};

function expectNoStreet(loc: ReturnType<typeof projectPublicEventLocation>) {
  expect(loc.addressText).toBeNull();
  expect(loc.postalCode).toBeNull();
  expect(loc.label).not.toContain("Shelby");
  expect(loc.areaLabel ?? "").not.toContain("Shelby");
}

describe("projectPublicEventLocation", () => {
  it("EXACT (no venue) → the stored row, byte for byte", () => {
    expect(projectPublicEventLocation(EXACT_EVENT)).toEqual({
      mode: "EXACT",
      hidden: false,
      lat: TRUE.lat,
      lng: TRUE.lng,
      radiusMeters: null,
      label: STREET,
      areaLabel: null,
      addressText: STREET,
      postalCode: "37206",
      locality: "Nashville",
      region: "TN",
      countryCode: "US",
    });
  });

  it("EXACT at a venue that publishes its address → unchanged", () => {
    expect(projectPublicEventLocation(EXACT_EVENT, { place: CLUB })).toEqual(
      projectPublicEventLocation(EXACT_EVENT),
    );
  });

  it("event-level OBSCURED → keyed circle, coarse label, no street", () => {
    const loc = projectPublicEventLocation(OBSCURED_EVENT);
    expect(loc.mode).toBe("OBSCURED");
    expect(loc.hidden).toBe(false);
    expect(loc.radiusMeters).toBe(500);
    expect(loc.label).toBe("Nashville, TN");
    expect(loc.areaLabel).toBe("East side");
    expectNoStreet(loc);
    const d = haversineDistance(TRUE.lat, TRUE.lng, loc.lat!, loc.lng!);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(500);
    // Ownerless (a community listing): keyed to the EVENT, so another event
    // at the same point draws another circle.
    const other = projectPublicEventLocation({
      ...OBSCURED_EVENT,
      id: "00000000-0000-4000-8000-0000000000e2",
    });
    expect(other.lat).not.toBe(loc.lat);
  });

  it("OBSCURED event at a publishing venue stays OBSCURED (no venue address)", () => {
    const loc = projectPublicEventLocation(OBSCURED_EVENT, { place: CLUB });
    expect(loc).toEqual(projectPublicEventLocation(OBSCURED_EVENT));
  });

  it("a STALE EXACT row at a withheld venue → the VENUE's circle, never the row", () => {
    // Stored before the venue was withheld: the row still carries the house.
    const loc = projectPublicEventLocation(EXACT_EVENT, { place: HOUSE });
    const venue = redactPlaceLocation(HOUSE);
    expect(loc.mode).toBe("OBSCURED");
    expect(loc.lat).toBe(venue.lat);
    expect(loc.lng).toBe(venue.lng);
    expect(loc.radiusMeters).toBe(1000);
    expect(loc.areaLabel).toBe("East Nashville");
    expect(loc.label).toBe("Nashville, TN");
    expectNoStreet(loc);
  });

  it("a wider event radius at a withheld venue keeps the VENUE centre at max(r)", () => {
    const loc = projectPublicEventLocation(
      { ...OBSCURED_EVENT, locationRadiusMeters: 5_000 },
      { place: HOUSE },
    );
    expect(loc.radiusMeters).toBe(5_000);
    expect(loc.lat).toBe(redactPlaceLocation(HOUSE).lat);
  });

  it("fully hidden venue → no position at all", () => {
    const loc = projectPublicEventLocation(EXACT_EVENT, {
      place: { ...HOUSE, locationRadiusMeters: null },
    });
    expect(loc).toMatchObject({ mode: "OBSCURED", hidden: true, lat: null, lng: null, radiusMeters: null });
    expectNoStreet(loc);
  });

  it("fully hidden event (null radius) → no position", () => {
    const loc = projectPublicEventLocation({
      ...OBSCURED_EVENT,
      locationRadiusMeters: null,
    });
    expect(loc).toMatchObject({ hidden: true, lat: null, lng: null });
    expectNoStreet(loc);
  });

  it("a venue row that is gone/unreadable fails closed", () => {
    const loc = projectPublicEventLocation(EXACT_EVENT, {
      place: unreadablePlaceLocation(PLACE_ID),
    });
    expect(loc).toMatchObject({ mode: "OBSCURED", hidden: true, lat: null });
    expectNoStreet(loc);
  });

  it.each([null, undefined, "", "exact", "APPROXIMATE"])(
    "fails closed on locationMode %p",
    (mode) => {
      const loc = projectPublicEventLocation({
        ...EXACT_EVENT,
        locationMode: mode as never,
      });
      expect(loc.mode).toBe("OBSCURED");
      expectNoStreet(loc);
      expect(loc.lat).not.toBe(TRUE.lat);
    },
  );
});

describe("rule 5 — a GATED event is LABEL ONLY on every public surface", () => {
  const gates = ["PASSWORD", "APPLICATION"];

  it("gated EXACT: no lat/lng/radius, no street, no postcode — the coarse label", () => {
    for (const gateType of gates) {
      const loc = projectPublicEventLocation({ ...EXACT_EVENT, gateType });
      expect(loc).toMatchObject({
        mode: "OBSCURED",
        hidden: true,
        lat: null,
        lng: null,
        radiusMeters: null,
        label: "Nashville, TN",
        areaLabel: "Nashville, TN",
      });
      expectNoStreet(loc);
      expect(publicDistanceMeters(TRUE, loc)).toBeNull();
    }
  });

  it("gated OBSCURED keeps only its (already public) author label; gated at a withheld venue draws no venue circle", () => {
    const obscured = projectPublicEventLocation({
      ...OBSCURED_EVENT,
      gateType: "PASSWORD",
    });
    expect(obscured).toMatchObject({ lat: null, lng: null, areaLabel: "East side" });
    const atHouse = projectPublicEventLocation(
      { ...EXACT_EVENT, gateType: "APPLICATION" },
      { place: HOUSE },
    );
    expect(atHouse).toMatchObject({ lat: null, lng: null, radiusMeters: null });
    expectNoStreet(atHouse);
  });

  it("a viewer who PASSED the gate (gateAccessGranted) gets rules 1–4 unchanged", () => {
    for (const gateType of gates) {
      expect(
        projectPublicEventLocation(
          { ...EXACT_EVENT, gateType },
          { gateAccessGranted: true },
        ),
      ).toEqual(projectPublicEventLocation(EXACT_EVENT));
      expect(
        projectPublicEventLocation(
          { ...OBSCURED_EVENT, gateType },
          { gateAccessGranted: true },
        ),
      ).toEqual(projectPublicEventLocation(OBSCURED_EVENT));
    }
  });

  it("NONE is ungated: rules 1–4 unchanged", () => {
    expect(EXACT_EVENT.gateType).toBe("NONE");
    expect(projectPublicEventLocation(EXACT_EVENT).lat).toBe(TRUE.lat);
    expect(projectPublicEventLocation(EXACT_EVENT).addressText).toBe(STREET);
  });

  it("N5: a MISSING gate (undefined / null) or an unknown value FAILS CLOSED — label only", () => {
    for (const gateType of [undefined, null, "", "none", "SOMETHING_NEW"]) {
      const loc = projectPublicEventLocation({ ...EXACT_EVENT, gateType });
      expect(loc).toMatchObject({
        mode: "OBSCURED",
        hidden: true,
        lat: null,
        lng: null,
        radiusMeters: null,
        label: "Nashville, TN",
      });
      expectNoStreet(loc);
    }
    // And for an OBSCURED event: no circle either.
    const obscured = projectPublicEventLocation({
      ...OBSCURED_EVENT,
      gateType: undefined,
    });
    expect(obscured).toMatchObject({ lat: null, lng: null, radiusMeters: null });
  });
});

describe("publicDistanceMeters", () => {
  const viewer = { lat: 36.16, lng: -86.78 };

  it("measures to the EMITTED point for OBSCURED — not the true distance", () => {
    const loc = projectPublicEventLocation(OBSCURED_EVENT);
    const shown = publicDistanceMeters(viewer, loc);
    const trueDistance = haversineDistance(viewer.lat, viewer.lng, TRUE.lat, TRUE.lng);
    expect(shown).toBe(haversineDistance(viewer.lat, viewer.lng, loc.lat!, loc.lng!));
    expect(shown).not.toBe(trueDistance);
  });

  it("is the true distance for EXACT (unchanged)", () => {
    expect(publicDistanceMeters(viewer, projectPublicEventLocation(EXACT_EVENT))).toBe(
      haversineDistance(viewer.lat, viewer.lng, TRUE.lat, TRUE.lng),
    );
  });

  it("is null when hidden", () => {
    expect(
      publicDistanceMeters(
        viewer,
        projectPublicEventLocation({ ...OBSCURED_EVENT, locationRadiusMeters: null }),
      ),
    ).toBeNull();
  });
});

describe("publicIcalLocation", () => {
  it("M5: a GATED event carries NO location and NO GEO — a feed is not a way around the gate", () => {
    for (const gateType of ["PASSWORD", "APPLICATION"]) {
      expect(
        publicIcalLocation({ ...EXACT_EVENT, placeId: null, gateType }, null),
      ).toEqual({ location: null, geo: null });
      expect(
        publicIcalLocation(
          { ...EXACT_EVENT, placeId: PLACE_ID, gateType },
          { ...CLUB, name: "The Club" },
        ),
      ).toEqual({ location: null, geo: null });
    }
    // Ungated is unchanged.
    expect(
      publicIcalLocation({ ...EXACT_EVENT, placeId: null, gateType: "NONE" }, null),
    ).toEqual({ location: STREET, geo: TRUE });
  });

  it("EXACT at a venue → the venue address + GEO, exactly as before", () => {
    expect(
      publicIcalLocation({ ...EXACT_EVENT, placeId: PLACE_ID }, { ...CLUB, name: "The Club" }),
    ).toEqual({ location: STREET, geo: TRUE });
  });

  it("EXACT freeform → the event's own address + GEO", () => {
    expect(publicIcalLocation({ ...EXACT_EVENT, placeId: null }, null)).toEqual({
      location: STREET,
      geo: TRUE,
    });
  });

  it("OBSCURED event → label only, NO GEO, no street", () => {
    expect(publicIcalLocation({ ...OBSCURED_EVENT, placeId: null }, null)).toEqual({
      location: "Nashville, TN",
      geo: null,
    });
  });

  it("OBSCURED event at a PUBLISHING venue → still no venue address and no GEO", () => {
    expect(
      publicIcalLocation({ ...OBSCURED_EVENT, placeId: PLACE_ID }, { ...CLUB, name: "The Club" }),
    ).toEqual({ location: "Nashville, TN", geo: null });
  });

  it("any event at a WITHHELD venue → label only, no venue name, no GEO", () => {
    const out = publicIcalLocation(
      { ...EXACT_EVENT, placeId: PLACE_ID },
      { ...HOUSE, name: "Shelby House" },
    );
    expect(out).toEqual({ location: "Nashville, TN", geo: null });
  });

  it("a venue row that is gone fails closed", () => {
    expect(publicIcalLocation({ ...EXACT_EVENT, placeId: PLACE_ID }, null)).toEqual({
      location: "Nashville, TN",
      geo: null,
    });
  });
});

describe("event circles are keyed to owner + TRUE POINT (one chain per location, not per event or spelling)", () => {
  const ORG = "00000000-0000-4000-8000-0000000000b1";
  const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
  const at = (id: string, overrides: Partial<PublicEventLocationSource> = {}) =>
    projectPublicEventLocation({
      ...OBSCURED_EVENT,
      id,
      orgId: ORG,
      ...overrides,
    });

  it("two different events, same owner, same point + radius → the IDENTICAL centre", () => {
    const first = at("00000000-0000-4000-8000-000000000101");
    const second = at("00000000-0000-4000-8000-000000000102");
    expect(first.lat).not.toBeNull();
    expect(second.lat).toBe(first.lat);
    expect(second.lng).toBe(first.lng);
  });

  it("the SAME point typed two ways (St / Street, zip, unit) → the SAME circle — text is not the key", () => {
    const typed = at("00000000-0000-4000-8000-000000000101", {
      addressText: "1417 Shelby Ave, Nashville, TN 37206",
    });
    const retyped = at("00000000-0000-4000-8000-000000000102", {
      addressText: "1417 Shelby Avenue Apt 2, Nashville 37206-1234",
    });
    const noText = at("00000000-0000-4000-8000-000000000103", {
      addressText: null,
    });
    expect(typed.lat).not.toBeNull();
    expect(retyped).toMatchObject({ lat: typed.lat, lng: typed.lng });
    expect(noText).toMatchObject({ lat: typed.lat, lng: typed.lng });
  });

  it("a sub-metre geocoder jitter keys the same subject (same offset); a different point does not", () => {
    const offset = (
      point: { lat: number; lng: number },
      id: string,
    ): { dLat: number; dLng: number } => {
      const shown = at(id, point);
      return { dLat: shown.lat! - point.lat, dLng: shown.lng! - point.lng };
    };
    const base = offset(
      { lat: 36.177501, lng: -86.741201 },
      "00000000-0000-4000-8000-000000000101",
    );
    const jitter = offset(
      { lat: 36.1775012, lng: -86.7412013 },
      "00000000-0000-4000-8000-000000000102",
    );
    const nextDoor = offset(
      { lat: 36.1776, lng: -86.7412 },
      "00000000-0000-4000-8000-000000000103",
    );
    // Same subject → the same offset from the point (to float precision).
    expect(jitter.dLat).toBeCloseTo(base.dLat, 9);
    expect(jitter.dLng).toBeCloseTo(base.dLng, 9);
    // A point ~11 m away is another subject: an unrelated offset.
    expect(Math.abs(nextDoor.dLat - base.dLat)).toBeGreaterThan(1e-7);
  });

  it("N weekly events at the house: the centres do NOT average toward it", () => {
    const centres = Array.from({ length: 12 }, (_, i) =>
      at(`00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`),
    );
    expect(new Set(centres.map((c) => `${c.lat},${c.lng}`)).size).toBe(1);
  });

  it("a different radius is a NESTED circle: a different centre that still contains the true point", () => {
    const r500 = at("00000000-0000-4000-8000-000000000101");
    const r800 = at("00000000-0000-4000-8000-000000000101", {
      locationRadiusMeters: 800,
    });
    expect(r800.lat).not.toBe(r500.lat);
    for (const circle of [r500, r800]) {
      expect(
        haversineDistance(TRUE.lat, TRUE.lng, circle.lat!, circle.lng!),
      ).toBeLessThan(circle.radiusMeters!);
    }
  });

  it("a DIFFERENT owner at the same point draws a different circle — nobody can reproduce another's to confirm a guess", () => {
    const mine = at("00000000-0000-4000-8000-000000000101");
    const guess = at("00000000-0000-4000-8000-000000000301", {
      orgId: OTHER_ORG,
    });
    expect(guess.lat).not.toBe(mine.lat);
  });

  it("a human owner keys the point the same way", () => {
    const a = at("00000000-0000-4000-8000-000000000401", {
      orgId: null,
      humanId: "00000000-0000-4000-8000-0000000000c1",
    });
    const b = at("00000000-0000-4000-8000-000000000402", {
      orgId: null,
      humanId: "00000000-0000-4000-8000-0000000000c1",
    });
    expect(b.lat).toBe(a.lat);
  });

  it("no owner → falls back to the SERIES, then to the event", () => {
    const series = "00000000-0000-4000-8000-0000000000d1";
    const s1 = at("00000000-0000-4000-8000-000000000501", {
      orgId: null,
      seriesId: series,
    });
    const s2 = at("00000000-0000-4000-8000-000000000502", {
      orgId: null,
      seriesId: series,
    });
    expect(s2.lat).toBe(s1.lat);

    const e1 = at("00000000-0000-4000-8000-000000000601", { orgId: null });
    const e2 = at("00000000-0000-4000-8000-000000000602", { orgId: null });
    expect(e2.lat).not.toBe(e1.lat);
    expect(e1.lat).not.toBe(s1.lat);
  });

  it("an off-ladder stored radius is DRAWN (and emitted) at the next rung up", () => {
    const legacy = at("00000000-0000-4000-8000-000000000101", {
      locationRadiusMeters: 520,
    });
    const rung = at("00000000-0000-4000-8000-000000000101", {
      locationRadiusMeters: 1000,
    });
    expect(legacy).toMatchObject({
      lat: rung.lat,
      lng: rung.lng,
      radiusMeters: 1000,
    });
    // Above the top rung: no rung contains it without shrinking → hidden.
    expect(
      at("00000000-0000-4000-8000-000000000101", {
        locationRadiusMeters: 60_000,
      }),
    ).toMatchObject({ hidden: true, lat: null, lng: null, radiusMeters: null });
  });
});

describe("eventCircleSubject", () => {
  it("keys owner + the point rounded to 1e-5°, and never the address text", () => {
    expect(roundPointForCircle(36.1775049, -86.74120001)).toBe(
      "36.17750,-86.74120",
    );
    expect(roundPointForCircle(-0.000001, 0.000004)).toBe("0.00000,0.00000");
    expect(roundPointForCircle(null, 1)).toBeNull();
    expect(
      eventCircleSubject({ id: "e", orgId: "o", lat: 36.1775, lng: -86.7412 }),
    ).toEqual({ scope: "event-point", id: "org:o\u001e36.17750,-86.74120" });
    expect(
      eventCircleSubject({ id: "e", humanId: "h", lat: 1, lng: 2 }),
    ).toEqual({ scope: "event-point", id: "human:h\u001e1.00000,2.00000" });
    // No owner: the point alone would be reproducible by anyone.
    expect(eventCircleSubject({ id: "e", lat: 1, lng: 2 })).toEqual({
      scope: "event",
      id: "e",
    });
    // No point: series, then event.
    expect(eventCircleSubject({ id: "e", orgId: "o", seriesId: "s" })).toEqual({
      scope: "event-series",
      id: "s",
    });
  });
});
