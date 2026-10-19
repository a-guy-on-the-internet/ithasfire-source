import { describe, expect, it } from "vitest";

import {
  getEditableAddressRevealPreset,
  getPreviewDateTimeIso,
  HIDDEN_SLIDER_POSITION,
  isLocationUnsaved,
  isStartInPast,
  MAX_RADIUS_METERS,
  MIN_RADIUS_METERS,
  radiusForSliderPosition,
  resolveAddressRevealSaveInput,
  sliderPositionForRadius,
  toPickerIsoValue,
} from "../event-builder-helpers";

describe("event-builder-helpers", () => {
  it("preserves legacy obscured events with null reveal preset on untouched edit saves", () => {
    const result = resolveAddressRevealSaveInput({
      visibilityMode: "OBSCURED",
      selectedPreset: "DAY_BEFORE",
      selectedCustomAt: "",
      eventTimezone: "America/Los_Angeles",
      existingVisibilityMode: "OBSCURED",
      existingPreset: null,
      hasPresetBeenTouched: false,
    });

    // `undefined` preset → the server preserves the stored reveal date
    // (resolveAddressReveal) rather than the UI's display fallback.
    expect(result).toEqual({
      addressRevealPreset: undefined,
      addressRevealAt: null,
    });
  });

  it("uses the selected preset when the organizer changes a legacy obscured event", () => {
    const result = resolveAddressRevealSaveInput({
      visibilityMode: "OBSCURED",
      selectedPreset: "DAY_BEFORE",
      selectedCustomAt: "",
      eventTimezone: "America/Los_Angeles",
      existingVisibilityMode: "OBSCURED",
      existingPreset: null,
      hasPresetBeenTouched: true,
    });

    expect(result).toEqual({
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: null,
    });
  });

  it("does not preserve legacy null behavior when switching an exact event to obscured", () => {
    const result = resolveAddressRevealSaveInput({
      visibilityMode: "OBSCURED",
      selectedPreset: "DAY_BEFORE",
      selectedCustomAt: "",
      eventTimezone: "America/Los_Angeles",
      existingVisibilityMode: "EXACT",
      existingPreset: null,
      hasPresetBeenTouched: false,
    });

    expect(result).toEqual({
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: null,
    });
  });

  it("sends no reveal config for EXACT events", () => {
    const result = resolveAddressRevealSaveInput({
      visibilityMode: "EXACT",
      selectedPreset: "CUSTOM",
      selectedCustomAt: "2026-08-01T18:00",
      eventTimezone: "America/Los_Angeles",
      hasPresetBeenTouched: true,
    });

    expect(result).toEqual({
      addressRevealPreset: undefined,
      addressRevealAt: null,
    });
  });

  it("resolves a CUSTOM reveal datetime in the event timezone", () => {
    const result = resolveAddressRevealSaveInput({
      visibilityMode: "OBSCURED",
      selectedPreset: "CUSTOM",
      selectedCustomAt: "2026-08-01T18:00",
      eventTimezone: "America/Los_Angeles",
      hasPresetBeenTouched: true,
    });

    // 18:00 PDT (UTC-7 in August) === 01:00Z next day.
    expect(result).toEqual({
      addressRevealPreset: "CUSTOM",
      addressRevealAt: "2026-08-02T01:00:00.000Z",
    });
  });

  it("round-trips preview timestamps back into the event timezone", () => {
    const original = "2026-04-21T03:00:00.000Z";
    const pickerValue = toPickerIsoValue(original, "America/Los_Angeles");

    expect(pickerValue).toBeTruthy();
    expect(getPreviewDateTimeIso(pickerValue, "America/Los_Angeles")).toBe(
      original,
    );
  });

  it("maps legacy null presets to the DAY_BEFORE default UI selection", () => {
    expect(getEditableAddressRevealPreset(null)).toBe("DAY_BEFORE");
    expect(getEditableAddressRevealPreset("WEEK_BEFORE")).toBe("WEEK_BEFORE");
  });
});

describe("precision slider mapping (radius ⇄ position)", () => {
  it("maps the far end-stop to null (fully hidden — no public map)", () => {
    expect(radiusForSliderPosition(HIDDEN_SLIDER_POSITION)).toBeNull();
    expect(sliderPositionForRadius(null)).toBe(HIDDEN_SLIDER_POSITION);
  });

  it("pins the extremes to the server's allowed radius bounds", () => {
    expect(radiusForSliderPosition(0)).toBe(MIN_RADIUS_METERS);
    expect(radiusForSliderPosition(HIDDEN_SLIDER_POSITION - 1)).toBe(
      MAX_RADIUS_METERS,
    );
  });

  it("round-trips every slider position through the radius mapping", () => {
    for (let p = 0; p <= HIDDEN_SLIDER_POSITION; p++) {
      const radius = radiusForSliderPosition(p);
      expect(sliderPositionForRadius(radius)).toBe(p);
    }
  });

  it("keeps positions within slider bounds for arbitrary stored radii", () => {
    // A persisted radius that doesn't sit on a step (e.g. legacy 13,000 m)
    // must land on a valid position without ever mutating the stored value —
    // the component only recomputes the radius when the user drags.
    for (const radius of [100, 137, 500, 13_000, 49_999, 50_000]) {
      const p = sliderPositionForRadius(radius);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(HIDDEN_SLIDER_POSITION);
    }
  });

  it("clamps out-of-range radii instead of throwing", () => {
    expect(sliderPositionForRadius(1)).toBe(0);
    expect(sliderPositionForRadius(10_000_000)).toBe(
      HIDDEN_SLIDER_POSITION - 1,
    );
  });
});

describe("isLocationUnsaved", () => {
  it("flags a freeform address chosen locally but not yet persisted", () => {
    expect(
      isLocationUnsaved(
        { addressText: "123 Main St", lat: 30.1, lng: -97.7 },
        { placeId: null, addressText: null },
      ),
    ).toBe(true);
  });

  it("flags a Place chosen locally when the saved record has no location", () => {
    expect(isLocationUnsaved({ thPlaceId: "place_123" }, null)).toBe(true);
  });

  it("does not flag when the saved record already has the location", () => {
    expect(
      isLocationUnsaved(
        { addressText: "123 Main St", lat: 30.1, lng: -97.7 },
        { addressText: "123 Main St" },
      ),
    ).toBe(false);
  });

  it("does not flag when the saved record has only a savedLocationId", () => {
    // Mirrors the server precondition (placeId || savedLocationId ||
    // addressText) — a savedLocationId-only record is already located.
    expect(
      isLocationUnsaved(
        { addressText: "123 Main St", lat: 30.1, lng: -97.7 },
        { savedLocationId: "sl_123" },
      ),
    ).toBe(false);
  });

  it("does not flag when there is no local location to publish", () => {
    // Empty builder state → let the server's own EVENT_LOCATION_REQUIRED
    // ("add a location") message stand; nothing to save first.
    expect(isLocationUnsaved({}, null)).toBe(false);
  });

  it("does not flag a partial freeform address (missing coordinates)", () => {
    expect(isLocationUnsaved({ addressText: "123 Main St" }, null)).toBe(false);
  });
});

describe("isStartInPast", () => {
  const TZ = "America/Chicago";
  const NOW = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29T12:00:00Z

  it("returns true for a start before now", () => {
    expect(isStartInPast("2020-01-01T10:00", TZ, NOW)).toBe(true);
  });

  it("returns false for a start after now", () => {
    expect(isStartInPast("2030-01-01T10:00", TZ, NOW)).toBe(false);
  });

  it("resolves the wall-clock value in the event timezone, not the browser's", () => {
    // 13:00 in America/Chicago (CDT, UTC-5 in June) === 18:00Z. This holds
    // regardless of the test runner's local timezone because the comparison
    // goes through toIsoInTimeZone.
    const startAt18Z = Date.UTC(2026, 5, 29, 18, 0, 0);
    expect(isStartInPast("2026-06-29T13:00", TZ, startAt18Z - 60_000)).toBe(
      false, // now is 17:59Z, start is 18:00Z → future
    );
    expect(isStartInPast("2026-06-29T13:00", TZ, startAt18Z + 60_000)).toBe(
      true, // now is 18:01Z, start is 18:00Z → past
    );
  });

  it("treats empty / undefined as not-in-past (required check handles it)", () => {
    expect(isStartInPast(undefined, TZ, NOW)).toBe(false);
    expect(isStartInPast("", TZ, NOW)).toBe(false);
  });

  it("treats an unparseable value as not-in-past", () => {
    expect(isStartInPast("not-a-date", TZ, NOW)).toBe(false);
  });
});

