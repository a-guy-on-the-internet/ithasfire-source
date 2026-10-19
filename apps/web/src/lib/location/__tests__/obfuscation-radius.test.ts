import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OBFUSCATION_RADIUS_LADDER_METERS,
  snapObfuscationRadiusUp,
} from "@th/core/lib/location/obfuscation-radius-ladder";

import {
  HIDDEN_SLIDER_POSITION,
  MAX_RADIUS_METERS,
  MIN_RADIUS_METERS,
  RADIUS_SLIDER_STOPS,
  drawnRadiusMeters,
  formatObfuscationRadius,
  radiusForSliderPosition,
  sliderPositionForRadius,
} from "../obfuscation-radius";

/**
 * The precision sliders (event builder + venue editor) offer EXACTLY the
 * server's radius ladder — the one list. A stop that is not a rung would be a
 * radius the server silently snaps to another value.
 */
describe("obfuscation-radius slider", () => {
  it("IS the server ladder (one source of truth, not a copy)", () => {
    expect(RADIUS_SLIDER_STOPS).toBe(OBFUSCATION_RADIUS_LADDER_METERS);
    expect(MIN_RADIUS_METERS).toBe(OBFUSCATION_RADIUS_LADDER_METERS[0]);
    expect(MAX_RADIUS_METERS).toBe(
      OBFUSCATION_RADIUS_LADDER_METERS[OBFUSCATION_RADIUS_LADDER_METERS.length - 1],
    );
  });

  it("offers exactly the nine ruled stops", () => {
    expect([...RADIUS_SLIDER_STOPS]).toEqual([
      100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
    ]);
  });

  it("shows a legacy off-ladder radius at the rung the server DRAWS it at (next up, never nearest)", () => {
    const at = (radius: number) =>
      RADIUS_SLIDER_STOPS[sliderPositionForRadius(radius)];
    expect(at(700)).toBe(1_000); // nearest would say 500
    expect(at(1_250)).toBe(2_000);
    expect(at(800)).toBe(1_000);
    expect(at(50)).toBe(100);
    expect(at(60_000)).toBe(50_000);
    expect(sliderPositionForRadius(null)).toBe(HIDDEN_SLIDER_POSITION);
  });

  it("every slider position the server would store unchanged", () => {
    for (let position = 0; position < HIDDEN_SLIDER_POSITION; position += 1) {
      const radius = radiusForSliderPosition(position)!;
      expect(snapObfuscationRadiusUp(radius)).toBe(radius);
    }
    expect(radiusForSliderPosition(HIDDEN_SLIDER_POSITION)).toBeNull();
  });

  it("displays the radius the public circle is DRAWN at, not the stored one", () => {
    // What every preview line and aria-valuetext formats. A legacy 700 m row
    // is drawn at 1 km; "700 m" would promise a tighter circle than the
    // public sees.
    expect(drawnRadiusMeters(700)).toBe(1_000);
    expect(drawnRadiusMeters(1_250)).toBe(2_000);
    expect(drawnRadiusMeters(50)).toBe(100);
    // On-ladder values are untouched…
    for (const rung of RADIUS_SLIDER_STOPS) {
      expect(drawnRadiusMeters(rung)).toBe(rung);
    }
    // …every value matches the core snap the public projections use…
    for (const radius of [101, 499, 501, 999, 4_000, 49_999]) {
      expect(drawnRadiusMeters(radius)).toBe(snapObfuscationRadiusUp(radius));
    }
    // …and fully hidden stays hidden.
    expect(drawnRadiusMeters(null)).toBeNull();
  });
});

describe("formatObfuscationRadius", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every rung of the server's ladder, both systems.
  const EXPECTED: ReadonlyArray<[number, string, string]> = [
    [100, "330 ft", "100 m"],
    [250, "820 ft", "250 m"],
    [500, "0.3 mi", "500 m"],
    [1_000, "0.6 mi", "1 km"],
    [2_000, "1.2 mi", "2 km"],
    [5_000, "3.1 mi", "5 km"],
    [10_000, "6.2 mi", "10 km"],
    [20_000, "12 mi", "20 km"],
    [50_000, "31 mi", "50 km"],
  ];

  it("covers exactly the ladder", () => {
    expect(EXPECTED.map(([m]) => m)).toEqual([
      ...OBFUSCATION_RADIUS_LADDER_METERS,
    ]);
  });

  it.each(EXPECTED)("%i m reads as %s / %s", (meters, imperial, metric) => {
    expect(
      formatObfuscationRadius(meters, { imperial: true, locale: "en-US" }),
    ).toBe(imperial);
    expect(
      formatObfuscationRadius(meters, { imperial: false, locale: "en-US" }),
    ).toBe(metric);
  });

  it("formats with the locale it is given, not the runtime default", () => {
    expect(
      formatObfuscationRadius(2_000, { imperial: true, locale: "de-DE" }),
    ).toBe("1,2 mi");
    expect(
      formatObfuscationRadius(1_500, { imperial: false, locale: "es-ES" }),
    ).toBe("1,5 km");
  });

  it("passes the locale to every Intl.NumberFormat it builds", () => {
    const spy = vi.spyOn(Intl, "NumberFormat");
    for (const [meters] of EXPECTED) {
      formatObfuscationRadius(meters, { imperial: true, locale: "fr-FR" });
      formatObfuscationRadius(meters, { imperial: false, locale: "fr-FR" });
    }
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) expect(call[0]).toBe("fr-FR");
  });

  it("never shows 1,000 ft or more in feet", () => {
    // 304 m ≈ 997 ft rounds to 1,000 ft — that is already miles.
    expect(
      formatObfuscationRadius(304, { imperial: true, locale: "en-US" }),
    ).toBe("0.2 mi");
    expect(
      formatObfuscationRadius(300, { imperial: true, locale: "en-US" }),
    ).toBe("980 ft");
  });
});
