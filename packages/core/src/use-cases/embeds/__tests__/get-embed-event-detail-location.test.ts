import { describe, expect, it } from "vitest";

import { redactPlaceLocation } from "../../../lib/location/redact-place-location";
import { buildPublicEmbedLocationFields } from "../get-embed-event-detail";

const BASE = {
  // Keys the event's obfuscation circle — without it there is no circle.
  id: "00000000-0000-4000-8000-0000000000e3",
  // Ungated (N5: a missing gate fails closed to label only).
  gateType: "NONE",
  addressText: "123 Main St, Brooklyn, NY",
  locality: "Brooklyn",
  region: "NY",
  // Operator-authored free text that can name a specific venue — must NOT leak.
  locationLabel: "Bob's Speakeasy, basement entrance",
  lat: 40.6892,
  lng: -74.0445,
  locationRadiusMeters: 500,
};

describe("buildPublicEmbedLocationFields — GATED events are label only", () => {
  it("a password/application-gated EXACT event: no coords, no street, coarse label", () => {
    for (const gateType of ["PASSWORD", "APPLICATION"]) {
      const out = buildPublicEmbedLocationFields({
        ...BASE,
        locationMode: "EXACT",
        gateType,
      });
      expect(out.locationCoords).toBeNull();
      expect(out.addressText).toBeNull();
      expect(out.locationLabel).toBe("Brooklyn, NY");
      expect(JSON.stringify(out)).not.toContain("Main St");
    }
  });

  it("an ungated EXACT event is unchanged", () => {
    const out = buildPublicEmbedLocationFields({
      ...BASE,
      locationMode: "EXACT",
      gateType: "NONE",
    });
    expect(out.locationCoords?.latitude).toBe(BASE.lat);
    expect(out.addressText).toBe(BASE.addressText);
  });
});

describe("buildPublicEmbedLocationFields — FR-013 redaction", () => {
  it("EXACT → passes through all fields unchanged", () => {
    const out = buildPublicEmbedLocationFields({
      ...BASE,
      locationMode: "EXACT",
    });
    expect(out.addressText).toBe(BASE.addressText);
    expect(out.locality).toBe(BASE.locality);
    expect(out.region).toBe(BASE.region);
    expect(out.locationLabel).toBe(BASE.locationLabel);
    expect(out.locationCoords).not.toBeNull();
    expect(out.locationCoords?.isExact).toBe(true);
    expect(out.locationCoords?.latitude).toBe(BASE.lat);
    expect(out.locationCoords?.longitude).toBe(BASE.lng);
    expect(out.locationCoords?.label).toBe(BASE.locationLabel);
  });

  it(
    "OBSCURED → drops raw region + free-text locationLabel, exposes only coarse areaLabel",
    () => {
      const out = buildPublicEmbedLocationFields({
        ...BASE,
        locationMode: "OBSCURED",
      });
      // Street address + precise fields are gone.
      expect(out.addressText).toBeNull();
      expect(out.locality).toBeNull();
      expect(out.region).toBeNull();
      // The operator free-text label must never appear anywhere.
      expect(out.locationLabel).not.toContain("Speakeasy");
      expect(out.locationLabel).toBe("Brooklyn, NY");
      expect(out.locationCoords?.label).toBe("Brooklyn, NY");
      expect(out.locationCoords?.areaLabel).toBe("Brooklyn, NY");
      // Coords are obscured, not the true pin.
      expect(out.locationCoords?.isExact).toBe(false);
      expect(out.locationCoords?.latitude).not.toBe(BASE.lat);
      expect(out.locationCoords?.longitude).not.toBe(BASE.lng);
    },
  );

  it.each([null, undefined, "", "UNKNOWN"])(
    "fails closed: locationMode %p → redacted like a non-EXACT event",
    (mode) => {
      const out = buildPublicEmbedLocationFields({
        ...BASE,
        locationMode: mode as never,
      });
      expect(out.addressText).toBeNull();
      expect(out.region).toBeNull();
      expect(out.locationLabel).not.toContain("Speakeasy");
      expect(out.locationLabel).toBe("Brooklyn, NY");
      expect(out.locationCoords?.isExact).toBe(false);
      expect(out.locationCoords?.latitude).not.toBe(BASE.lat);
    },
  );

  it("OBSCURED + null radius (fully hidden) → NO public coordinates at all", () => {
    const out = buildPublicEmbedLocationFields({
      ...BASE,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });
    // The embed map is dropped entirely for fully-hidden events…
    expect(out.locationCoords).toBeNull();
    // …but the coarse area label still renders.
    expect(out.addressText).toBeNull();
    expect(out.locationLabel).toBe("Brooklyn, NY");
  });

  it("non-EXACT with no locality/region → null label, never the operator free text", () => {
    const out = buildPublicEmbedLocationFields({
      ...BASE,
      locality: null,
      region: null,
      locationMode: "OBSCURED",
    });
    expect(out.locationLabel).toBeNull();
    expect(out.locationCoords?.label).toBeNull();
    expect(out.locationCoords?.areaLabel).toBeNull();
  });
  it("an EXACT-stored event at a WITHHELD venue → the venue's keyed circle, no street", () => {
    const venue = {
      id: "00000000-0000-4000-8000-0000000000a3",
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      formattedAddress: "123 Main St, Brooklyn, NY",
      city: "Brooklyn",
      region: "NY",
      lat: BASE.lat,
      lng: BASE.lng,
    };
    const out = buildPublicEmbedLocationFields(
      { ...BASE, locationMode: "EXACT" },
      venue,
    );
    const venueCircle = redactPlaceLocation(venue);
    expect(out.addressText).toBeNull();
    expect(out.locality).toBeNull();
    expect(out.locationLabel).toBe("Brooklyn, NY");
    expect(out.locationCoords).toMatchObject({
      isExact: false,
      // The venue's stored 800 m is drawn at the next rung up.
      radiusMeters: 1000,
      latitude: venueCircle.lat,
      longitude: venueCircle.lng,
    });
  });

  it("an event at a FULLY HIDDEN venue → no coordinates at all", () => {
    const out = buildPublicEmbedLocationFields(
      { ...BASE, locationMode: "EXACT" },
      {
        id: "00000000-0000-4000-8000-0000000000a4",
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        lat: BASE.lat,
        lng: BASE.lng,
      },
    );
    expect(out.locationCoords).toBeNull();
    expect(out.addressText).toBeNull();
  });
});
