import { describe, expect, it } from "vitest";

import {
  DEFAULT_RADIUS_KM,
  RADIUS_MAX_KM,
  RADIUS_MAX_MI,
  RADIUS_MIN_KM,
  RADIUS_MIN_MI,
  RADIUS_STEP_KM,
  RADIUS_STEP_MI,
  RADIUS_WORLDWIDE_KM,
  RADIUS_WORLDWIDE_MI,
  SLIDER_MAX,
  SLIDER_MAX_KM,
  SLIDER_MAX_MI,
  formatRadiusLabel,
  isWorldwideRadius,
  kmToSliderValue,
  normalizeRadiusForUnit,
  radiusSliderConfig,
  radiusToNearFilter,
  sliderValueToKm,
} from "../radius";

describe("radius constants", () => {
  it("matches the canonical km values shared across every radius control", () => {
    expect(RADIUS_MIN_KM).toBe(5);
    expect(RADIUS_MAX_KM).toBe(500);
    expect(RADIUS_STEP_KM).toBe(5);
    expect(DEFAULT_RADIUS_KM).toBe(50);
    expect(RADIUS_WORLDWIDE_KM).toBe(505);
    expect(SLIDER_MAX_KM).toBe(505);
    // Back-compat alias.
    expect(SLIDER_MAX).toBe(SLIDER_MAX_KM);
  });

  it("defines the imperial (miles) slider domain", () => {
    expect(RADIUS_MIN_MI).toBe(5);
    expect(RADIUS_MAX_MI).toBe(300);
    expect(RADIUS_STEP_MI).toBe(5);
    expect(RADIUS_WORLDWIDE_MI).toBe(305);
    expect(SLIDER_MAX_MI).toBe(305);
  });
});

describe("isWorldwideRadius", () => {
  it("identifies the worldwide sentinel", () => {
    expect(isWorldwideRadius(505)).toBe(true);
    expect(isWorldwideRadius(500)).toBe(false);
    // Worldwide is `>=` so anything above the top also counts.
    expect(isWorldwideRadius(510)).toBe(true);
  });
});

describe("radiusToNearFilter", () => {
  it("keeps a real distance for 5–500 km", () => {
    expect(radiusToNearFilter(5)).toEqual({ radiusKm: 5 });
    expect(radiusToNearFilter(50)).toEqual({ radiusKm: 50 });
    expect(radiusToNearFilter(500)).toEqual({ radiusKm: 500 });
  });

  it("drops `near` for Worldwide (505)", () => {
    // getRandomEvent caps radius at 500km; the sentinel means "don't constrain
    // by distance" → omit near entirely.
    expect(radiusToNearFilter(505)).toBeNull();
  });
});

describe("formatRadiusLabel", () => {
  // Minimal translate stub returning the key so we can assert which key is used.
  const t = (key: string) => key;

  it("shows kilometres in metric", () => {
    expect(formatRadiusLabel(50, { imperial: false, t })).toBe("50 km");
  });

  it("converts to miles in imperial", () => {
    // 50 km * 0.621371 ≈ 31.07 → rounds to 31.
    expect(formatRadiusLabel(50, { imperial: true, t })).toBe("31 mi");
  });

  it("uses the shared Worldwide message key at the sentinel", () => {
    expect(formatRadiusLabel(505, { imperial: false, t })).toBe(
      "search.worldwide",
    );
    expect(formatRadiusLabel(505, { imperial: true, t })).toBe(
      "search.worldwide",
    );
  });

  it("reads as a round multiple of 5 mi once the km value is normalized", () => {
    // 50 km normalized to the imperial grid → 48 km, which formats to "30 mi".
    const normalized = normalizeRadiusForUnit(50, true);
    expect(formatRadiusLabel(normalized, { imperial: true, t })).toBe("30 mi");
  });
});

describe("radiusSliderConfig", () => {
  it("returns the metric track (5→505 km, 5 km steps)", () => {
    expect(radiusSliderConfig(false)).toEqual({
      min: 5,
      max: 505,
      step: 5,
      sliderMax: 505,
    });
  });

  it("returns the imperial track (5→305 mi, 5 mi steps)", () => {
    expect(radiusSliderConfig(true)).toEqual({
      min: 5,
      max: 305,
      step: 5,
      sliderMax: 305,
    });
  });
});

describe("kmToSliderValue / sliderValueToKm", () => {
  it("is a metric identity (values are already km, incl. the sentinel)", () => {
    expect(kmToSliderValue(50, false)).toBe(50);
    expect(sliderValueToKm(50, false)).toBe(50);
    expect(kmToSliderValue(505, false)).toBe(505);
    expect(sliderValueToKm(505, false)).toBe(505);
  });

  it("snaps km onto the 5-mi grid for imperial", () => {
    // 50 km ≈ 31.07 mi → nearest 5-mi stop is 30 mi.
    expect(kmToSliderValue(50, true)).toBe(30);
    // 30 mi ≈ 48.28 km → 48 km.
    expect(sliderValueToKm(30, true)).toBe(48);
  });

  it("clamps to the imperial [5, 300] mi bounds", () => {
    // 5 km ≈ 3.1 mi would snap to 5, but the min is 5 mi anyway.
    expect(kmToSliderValue(5, true)).toBe(5);
    // 500 km ≈ 310.7 mi → clamped to the 300 mi max.
    expect(kmToSliderValue(500, true)).toBe(300);
  });

  it("maps worldwide to the right sentinel in each direction", () => {
    expect(kmToSliderValue(505, true)).toBe(RADIUS_WORLDWIDE_MI); // 305
    expect(sliderValueToKm(305, true)).toBe(RADIUS_WORLDWIDE_KM); // 505
    expect(kmToSliderValue(505, false)).toBe(RADIUS_WORLDWIDE_KM); // 505
  });
});

describe("normalizeRadiusForUnit", () => {
  it("leaves km untouched in metric", () => {
    expect(normalizeRadiusForUnit(50, false)).toBe(50);
    expect(normalizeRadiusForUnit(235, false)).toBe(235);
  });

  it("snaps km onto the imperial grid", () => {
    // 50 km → 30 mi stop → 48 km.
    expect(normalizeRadiusForUnit(50, true)).toBe(48);
  });

  it("preserves worldwide in both units", () => {
    expect(normalizeRadiusForUnit(505, true)).toBe(RADIUS_WORLDWIDE_KM);
    expect(normalizeRadiusForUnit(505, false)).toBe(RADIUS_WORLDWIDE_KM);
  });

  it("respects the imperial max clamp (500 km → 300 mi → 483 km)", () => {
    expect(normalizeRadiusForUnit(500, true)).toBe(483);
  });

  it("is idempotent on an already-snapped value", () => {
    const once = normalizeRadiusForUnit(50, true); // 48
    expect(normalizeRadiusForUnit(once, true)).toBe(once);
  });
});
