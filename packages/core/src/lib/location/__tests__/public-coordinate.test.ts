import { describe, expect, it } from "vitest";

import { haversineDistance } from "../../geo/haversine";
import {
  publicEventAddressText,
  publicEventCoordinate,
} from "../public-coordinate";

const TRUE_LAT = 40.6892;
const TRUE_LNG = -74.0445;
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";

describe("publicEventCoordinate", () => {
  it("EXACT → returns the true coordinate unchanged", () => {
    const result = publicEventCoordinate({
      eventId: EVENT_ID,
      locationMode: "EXACT",
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      locationRadiusMeters: 500,
    });
    expect(result).toEqual({ lat: TRUE_LAT, lng: TRUE_LNG });
  });

  it(
    "OBSCURED → returns an obscured point within the radius, not the true point",
    () => {
      const mode = "OBSCURED" as const;
      const radius = 500;
      const result = publicEventCoordinate({
        eventId: EVENT_ID,
        locationMode: mode,
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationRadiusMeters: radius,
      });
      expect(result).not.toBeNull();
      if (!result) throw new Error("expected a coordinate");
      // Not the true pin.
      expect(result.lat).not.toBe(TRUE_LAT);
      expect(result.lng).not.toBe(TRUE_LNG);
      // Within the obfuscation radius of the true pin.
      const offset = haversineDistance(
        TRUE_LAT,
        TRUE_LNG,
        result.lat,
        result.lng,
      );
      expect(offset).toBeLessThanOrEqual(radius);
      expect(offset).toBeGreaterThan(0);
    },
  );

  it("non-EXACT is deterministic — same input → same obscured point", () => {
    const a = publicEventCoordinate({
      eventId: EVENT_ID,
      locationMode: "OBSCURED",
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      locationRadiusMeters: 500,
    });
    const b = publicEventCoordinate({
      eventId: EVENT_ID,
      locationMode: "OBSCURED",
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      locationRadiusMeters: 500,
    });
    expect(a).toEqual(b);
  });

  it("OBSCURED + null radius (fully hidden) → returns NO coordinate at all", () => {
    // null radius is the FULLY-HIDDEN sentinel: the map must drop the marker,
    // so no point (not even an obscured one) may be emitted.
    expect(
      publicEventCoordinate({
        eventId: EVENT_ID,
        locationMode: "OBSCURED",
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationRadiusMeters: null,
      }),
    ).toBeNull();
  });

  it("fails closed: unknown mode + null radius → hidden (no coordinate)", () => {
    expect(
      publicEventCoordinate({
        eventId: EVENT_ID,
        locationMode: "UNKNOWN" as never,
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationRadiusMeters: null,
      }),
    ).toBeNull();
  });

  it("EXACT + null radius → still returns the true coordinate (radius ignored)", () => {
    expect(
      publicEventCoordinate({
        eventId: EVENT_ID,
        locationMode: "EXACT",
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationRadiusMeters: null,
      }),
    ).toEqual({ lat: TRUE_LAT, lng: TRUE_LNG });
  });

  it.each([null, undefined, "", "UNKNOWN", "exact"])(
    "fails closed: locationMode %p → obscured point, not the true pin",
    (mode) => {
      const result = publicEventCoordinate({
        eventId: EVENT_ID,
        // Intentionally pass a non-"EXACT" / unknown value through the gate.
        locationMode: mode as never,
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationRadiusMeters: 500,
      });
      expect(result).not.toBeNull();
      if (!result) throw new Error("expected a coordinate");
      expect(result.lat).not.toBe(TRUE_LAT);
      expect(result.lng).not.toBe(TRUE_LNG);
      const offset = haversineDistance(
        TRUE_LAT,
        TRUE_LNG,
        result.lat,
        result.lng,
      );
      expect(offset).toBeLessThanOrEqual(500);
      expect(offset).toBeGreaterThan(0);
    },
  );

  it("null lat/lng → returns null", () => {
    expect(
      publicEventCoordinate({
        eventId: EVENT_ID,
        locationMode: "EXACT",
        lat: null,
        lng: TRUE_LNG,
        locationRadiusMeters: 500,
      }),
    ).toBeNull();
    expect(
      publicEventCoordinate({
        eventId: EVENT_ID,
        locationMode: "OBSCURED",
        lat: TRUE_LAT,
        lng: null,
        locationRadiusMeters: 500,
      }),
    ).toBeNull();
  });
});

describe("publicEventAddressText", () => {
  it("EXACT → returns the true street address", () => {
    expect(
      publicEventAddressText({
        locationMode: "EXACT",
        addressText: "123 Main St, Brooklyn, NY",
        locality: "Brooklyn",
        region: "NY",
      }),
    ).toBe("123 Main St, Brooklyn, NY");
  });

  it(
    "OBSCURED → returns a coarse 'locality, region' label, never the street address",
    () => {
      const mode = "OBSCURED" as const;
      const result = publicEventAddressText({
        locationMode: mode,
        addressText: "123 Main St, Brooklyn, NY",
        locality: "Brooklyn",
        region: "NY",
      });
      expect(result).toBe("Brooklyn, NY");
      expect(result).not.toContain("123 Main St");
    },
  );

  it("non-EXACT with no locality/region → returns null (never the street address)", () => {
    expect(
      publicEventAddressText({
        locationMode: "OBSCURED",
        addressText: "123 Main St, Brooklyn, NY",
        locality: null,
        region: null,
      }),
    ).toBeNull();
  });

  it.each([null, undefined, "", "UNKNOWN", "exact"])(
    "fails closed: locationMode %p → coarse label, never the street address",
    (mode) => {
      const result = publicEventAddressText({
        // Intentionally pass a non-"EXACT" / unknown value through the gate.
        locationMode: mode as never,
        addressText: "123 Main St, Brooklyn, NY",
        locality: "Brooklyn",
        region: "NY",
      });
      expect(result).toBe("Brooklyn, NY");
      expect(result).not.toContain("123 Main St");
    },
  );
});
