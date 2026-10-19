import { afterEach, describe, expect, it, vi } from "vitest";

import { haversineDistance } from "../../geo/haversine";
import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../obfuscation-key";
import { projectPublicEventLocation } from "../project-public-event-location";
import { obfuscateCoordinate } from "../redact-location";
import { redactPlaceLocation } from "../redact-place-location";

/**
 * D3 — keyed circles. The old offset was seeded by the TRUE point alone, so
 * C(R) = P + R·v: two published radii recovered P exactly, and anyone could
 * compute the circle for a guessed address and compare. These pin the fix.
 */

const TEST_SECRET = "test-only-location-obfuscation-secret";
const P = { lat: 36.1775, lng: -86.7412 };
const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
const METERS_PER_DEGREE_LAT = 111_320;

function centre(
  radiusMeters: number,
  subjectId: string = PLACE_ID,
  scope: "place" | "event" = "place",
  at = P,
) {
  const c = obfuscateCoordinate({ ...at, radiusMeters, scope, subjectId });
  if (!c) throw new Error("expected a circle centre");
  return c;
}

/** Planar metre offset of `c` from `at` — the frame the old attack works in. */
function offsetMeters(c: { lat: number; lng: number }, at = P) {
  return {
    x:
      (c.lng - at.lng) *
      METERS_PER_DEGREE_LAT *
      Math.cos((at.lat * Math.PI) / 180),
    y: (c.lat - at.lat) * METERS_PER_DEGREE_LAT,
  };
}

afterEach(() => {
  // The package setup file keys every test; restore it after any test that
  // changed or removed the key.
  configureLocationObfuscation({ secret: TEST_SECRET });
});

describe("keyed obfuscation circles", () => {
  it("two radii are NOT collinear with the true point — the two-circle solve fails", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const r1 = 500;
      const r2 = 800;
      const o1 = offsetMeters(centre(r1, id));
      const o2 = offsetMeters(centre(r2, id));
      // The old model C(R) = P + R·v makes o1/r1 === o2/r2, so
      // P = (r2·C1 − r1·C2)/(r2 − r1). Under keyed circles that "solution"
      // lands nowhere near P.
      const solved = {
        x: (r2 * o1.x - r1 * o2.x) / (r2 - r1),
        y: (r2 * o1.y - r1 * o2.y) / (r2 - r1),
      };
      expect(Math.hypot(solved.x, solved.y)).toBeGreaterThan(10);
      // And the two offsets are not parallel.
      const cross = o1.x * o2.y - o1.y * o2.x;
      const sine = Math.abs(cross) / (Math.hypot(o1.x, o1.y) * Math.hypot(o2.x, o2.y));
      expect(sine).toBeGreaterThan(1e-6);
    }
  });

  it("is deterministic for the same (scope, subject, radius)", () => {
    expect(centre(500)).toEqual(centre(500));
    expect(redactPlaceLocation({ id: PLACE_ID, locationMode: "OBSCURED", locationRadiusMeters: 500, ...P }))
      .toMatchObject(centre(500));
  });

  it("differs by subject and by scope", () => {
    const other = "00000000-0000-4000-8000-0000000000b2";
    expect(centre(500, other)).not.toEqual(centre(500));
    expect(centre(500, PLACE_ID, "event")).not.toEqual(centre(500, PLACE_ID, "place"));
  });

  it("differs by KEY — a guessed address cannot be confirmed without it", () => {
    const withTestKey = centre(500);
    configureLocationObfuscation({ secret: "a-different-server-secret" });
    const withOtherKey = centre(500);
    expect(withOtherKey).not.toEqual(withTestKey);
    // Same key again → same circle (it is the key, not time or state).
    configureLocationObfuscation({ secret: TEST_SECRET });
    expect(centre(500)).toEqual(withTestKey);
  });

  it("the INNERMOST circle (the smallest rung) is uniform within the DISC (no annulus), never outside R", () => {
    // Larger rungs are nested sums of steps (obfuscation-nesting.test.ts);
    // the first step is the one uniform draw around the true point.
    for (const lat of [0, 36.1775, 59.9]) {
      const at = { lat, lng: -86.7412 };
      const radius = 100;
      let inner30 = 0;
      let inner50 = 0;
      const n = 2_000;
      for (let i = 0; i < n; i += 1) {
        const c = centre(radius, `subject-${i}`, "event", at);
        const d = haversineDistance(at.lat, at.lng, c.lat, c.lng);
        expect(d).toBeLessThanOrEqual(radius);
        if (d <= 0.3 * radius) inner30 += 1;
        if (d <= 0.5 * radius) inner50 += 1;
      }
      // Uniform in a disc of 0.99R: P(d ≤ 0.3R) ≈ 9.2 %, P(d ≤ 0.5R) ≈ 25.5 %.
      // The old 30–70 % annulus put exactly 0 % inside 0.3R.
      expect(inner30 / n).toBeGreaterThan(0.06);
      expect(inner30 / n).toBeLessThan(0.13);
      expect(inner50 / n).toBeGreaterThan(0.21);
      expect(inner50 / n).toBeLessThan(0.3);
    }
  });
});

describe("FAIL CLOSED without a key", () => {
  it("emits no circle anywhere — place or event — and reports it ONCE", () => {
    resetLocationObfuscationForTests();
    const error = vi.fn();
    const reportError = vi.fn();
    const outcome = configureLocationObfuscation({
      secret: undefined,
      logger: { error },
      reportError,
    });
    expect(outcome).toEqual({ keyed: false });

    expect(
      obfuscateCoordinate({ ...P, radiusMeters: 500, scope: "place", subjectId: PLACE_ID }),
    ).toBeNull();

    const place = redactPlaceLocation({
      id: PLACE_ID,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      formattedAddress: "1417 Shelby Ave",
      city: "Nashville",
      region: "TN",
      ...P,
    });
    expect(place).toMatchObject({ hidden: true, lat: null, lng: null, formattedAddress: null });

    const event = projectPublicEventLocation({
      id: "00000000-0000-4000-8000-0000000000e9",
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressText: "1417 Shelby Ave",
      locality: "Nashville",
      region: "TN",
      ...P,
    });
    expect(event).toMatchObject({
      mode: "OBSCURED",
      hidden: true,
      lat: null,
      lng: null,
      addressText: null,
      label: "Nashville, TN",
    });

    // Once per process, however many circles failed.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "location_obfuscation.key_missing",
      expect.objectContaining({ reason: "configured_without_secret" }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("an unconfigured process reports at first use, then stays quiet", () => {
    resetLocationObfuscationForTests();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        obfuscateCoordinate({ ...P, radiusMeters: 500, scope: "event", subjectId: "e1" }),
      ).toBeNull();
      expect(
        obfuscateCoordinate({ ...P, radiusMeters: 800, scope: "event", subjectId: "e1" }),
      ).toBeNull();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "location_obfuscation.key_missing",
        expect.objectContaining({ reason: "obfuscation_without_key" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a throwing reporter never changes the outcome", () => {
    resetLocationObfuscationForTests();
    configureLocationObfuscation({
      secret: "",
      logger: {
        error: () => {
          throw new Error("logger down");
        },
      },
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    expect(
      obfuscateCoordinate({ ...P, radiusMeters: 500, scope: "place", subjectId: PLACE_ID }),
    ).toBeNull();
  });
});
