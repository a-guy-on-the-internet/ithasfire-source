import { describe, expect, it } from "vitest";

import { haversineDistance } from "../../geo/haversine";

import {
  obfuscateCoordinate,
  redactLocation,
  type ExactLocation,
} from "../redact-location";

const EXACT_LOCATION: ExactLocation = {
  lat: 40.6892,
  lng: -74.0445,
  addressText: "123 Main St, Brooklyn, NY 11201",
  locality: "Brooklyn",
  region: "NY",
  countryCode: "US",
  postalCode: "11201",
  locationLabel: "Bushwick, Brooklyn",
};

const RADIUS = 500;
const EVENT_ID = "00000000-0000-4000-8000-0000000000e2";
const NOW = new Date("2024-02-01T12:00:00.000Z");
/** OBSCURED events always carry a reveal date (FR-005) — default fixture. */
const FUTURE_REVEAL = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

describe("redactLocation", () => {
  it("EXACT → returns raw coordinates with isExact true", () => {
    const result = redactLocation({
      mode: "EXACT",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: false,
      addressRevealAt: null,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(true);
    if (result.isExact) {
      expect(result.lat).toBe(EXACT_LOCATION.lat);
      expect(result.lng).toBe(EXACT_LOCATION.lng);
      expect(result.addressText).toBe(EXACT_LOCATION.addressText);
      expect(result.locality).toBe(EXACT_LOCATION.locality);
    }
  });

  it("OBSCURED without ticket → returns obfuscated circle with isExact false", () => {
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: false,
      addressRevealAt: FUTURE_REVEAL,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
    if (!result.isExact && !result.hidden) {
      expect(result.lat).not.toBe(EXACT_LOCATION.lat);
      expect(result.lng).not.toBe(EXACT_LOCATION.lng);
      expect(result.radiusMeters).toBe(RADIUS);
      expect(result.areaLabel).toBe("Bushwick, Brooklyn");
    }
  });

  it("OBSCURED non-ticket-holder → obfuscated even after the reveal time", () => {
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: false,
      addressRevealAt: past,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
  });

  it("OBSCURED with ticket + revealAt in the future → obfuscates", () => {
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: true,
      addressRevealAt: FUTURE_REVEAL,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
    if (!result.isExact && !result.hidden) {
      expect(result.lat).not.toBe(EXACT_LOCATION.lat);
      expect(result.lng).not.toBe(EXACT_LOCATION.lng);
    }
  });

  it("OBSCURED with ticket + revealAt in the past → reveals", () => {
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: true,
      addressRevealAt: past,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(true);
    if (result.isExact) {
      expect(result.lat).toBe(EXACT_LOCATION.lat);
      expect(result.lng).toBe(EXACT_LOCATION.lng);
    }
  });

  it("OBSCURED with ticket + revealAt equal to now → reveals", () => {
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: true,
      addressRevealAt: new Date(NOW.getTime()),
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(true);
  });

  it("OBSCURED with ticket + revealAt null → fails closed (NOT revealed)", () => {
    // A null addressRevealAt on an OBSCURED event is an invariant violation
    // (the reveal date is mandatory) — it must NOT mean 'reveal immediately'.
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: RADIUS,
      callerIsTicketHolder: true,
      addressRevealAt: null,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
  });

  // ── Fully hidden (OBSCURED + radiusMeters null) ────────────────────────────

  it("OBSCURED + null radius → fully hidden: no coordinates, only areaLabel", () => {
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: null,
      callerIsTicketHolder: false,
      addressRevealAt: FUTURE_REVEAL,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
    expect(result).not.toHaveProperty("lat");
    expect(result).not.toHaveProperty("lng");
    expect(result).not.toHaveProperty("radiusMeters");
    if (!result.isExact && result.hidden) {
      expect(result.hidden).toBe(true);
      expect(result.areaLabel).toBe("Bushwick, Brooklyn");
    } else {
      throw new Error("expected the fully-hidden variant");
    }
  });

  it("fully hidden + ticket holder pre-reveal → still hidden", () => {
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: null,
      callerIsTicketHolder: true,
      addressRevealAt: FUTURE_REVEAL,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
    expect(result).not.toHaveProperty("lat");
  });

  it("fully hidden + ticket holder post-reveal → exact", () => {
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    const result = redactLocation({
      mode: "OBSCURED",
      exact: EXACT_LOCATION,
      radiusMeters: null,
      callerIsTicketHolder: true,
      addressRevealAt: past,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(true);
    if (result.isExact) {
      expect(result.lat).toBe(EXACT_LOCATION.lat);
      expect(result.addressText).toBe(EXACT_LOCATION.addressText);
    }
  });

  it("falls back to locality, region when locationLabel is null", () => {
    const result = redactLocation({
      mode: "OBSCURED",
      exact: { ...EXACT_LOCATION, locationLabel: null },
      radiusMeters: RADIUS,
      callerIsTicketHolder: false,
      addressRevealAt: FUTURE_REVEAL,
      now: NOW,
      eventId: EVENT_ID,
    });

    expect(result.isExact).toBe(false);
    if (!result.isExact) {
      expect(result.areaLabel).toBe("Brooklyn, NY");
    }
  });
});

describe("obfuscateCoordinate", () => {
  // The keyed-circle properties (non-collinear radii, key dependence, fail
  // closed, uniform-in-disc) live in obfuscation-key.test.ts.
  const circle = (radiusMeters = 500) =>
    obfuscateCoordinate({
      lat: 40.6892,
      lng: -74.0445,
      radiusMeters,
      scope: "event",
      subjectId: EVENT_ID,
    });

  it("is deterministic (same input → same output)", () => {
    const a = circle();
    const b = circle();
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it("produces an offset within the specified radius", () => {
    const result = circle();
    if (!result) throw new Error("expected a circle centre");
    const distance = haversineDistance(40.6892, -74.0445, result.lat, result.lng);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(500);
  });

  it("does NOT return the original coordinates", () => {
    const result = circle();
    expect(result?.lat).not.toBe(40.6892);
    expect(result?.lng).not.toBe(-74.0445);
  });

  it("no subject id → no circle (null), never the true point", () => {
    expect(
      obfuscateCoordinate({
        lat: 40.6892,
        lng: -74.0445,
        radiusMeters: 500,
        scope: "event",
        subjectId: null,
      }),
    ).toBeNull();
  });
});
