import { describe, expect, it } from "vitest";

import {
  HOURS_PRESETS,
  presetUpsertFields,
  setupScope,
  shouldOfferPresets,
  shouldShowHoursWarning,
  type AvailabilitySetupState,
} from "../availability-setup-helpers";
import {
  WEEKDAY_ORDER,
  isOvernight,
  windowError,
} from "../venue-calendars-helpers";

/**
 * The availability-onboarding presets (spec FR-002) ride the SAME full-PUT
 * write path as the hours editor, so what these tests pin is the payload
 * contract: isOpen always present and true, dayOfWeek XOR date, scope threaded
 * through as calendarId, and windows that the editor itself would accept —
 * including the deliberately-overnight "every night" 18:00–02:00.
 */

const preset = (id: string) => {
  const found = HOURS_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
};

const configured: AvailabilitySetupState = {
  configured: true,
  calendarCount: 1,
  defaultCalendarId: "cal-1",
};
const unconfigured: AvailabilitySetupState = {
  configured: false,
  calendarCount: 0,
  defaultCalendarId: null,
};

describe("HOURS_PRESETS", () => {
  it("matches the spec's four presets and their windows", () => {
    expect(HOURS_PRESETS.map((p) => p.id)).toEqual([
      "evenings_thu_sat",
      "evenings_wed_sun",
      "every_night",
      "weekends",
    ]);

    const thuSat = preset("evenings_thu_sat");
    expect([...thuSat.days].sort()).toEqual([4, 5, 6]);
    expect(thuSat.startTime).toBe("19:00");
    expect(thuSat.endTime).toBe("00:00");

    const wedSun = preset("evenings_wed_sun");
    expect([...wedSun.days].sort()).toEqual([0, 3, 4, 5, 6]);
    expect(wedSun.startTime).toBe("19:00");
    expect(wedSun.endTime).toBe("00:00");

    const everyNight = preset("every_night");
    expect([...everyNight.days].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(everyNight.startTime).toBe("18:00");
    expect(everyNight.endTime).toBe("02:00");

    const weekends = preset("weekends");
    expect([...weekends.days].sort()).toEqual([0, 6]);
    expect(weekends.startTime).toBe("12:00");
    expect(weekends.endTime).toBe("00:00");
  });

  it("every preset window is one the editor itself would accept", () => {
    for (const p of HOURS_PRESETS) {
      expect(windowError(p.startTime, p.endTime)).toBeNull();
    }
  });

  it("'every night' crosses midnight deliberately — the overnight helper must read it as one night", () => {
    const p = preset("every_night");
    expect(isOvernight(p.startTime, p.endTime)).toBe(true);
  });

  it("windows ending at midnight are overnight too, not empty", () => {
    const p = preset("evenings_thu_sat");
    expect(isOvernight(p.startTime, p.endTime)).toBe(true);
    expect(windowError(p.startTime, p.endTime)).toBeNull();
  });
});

describe("presetUpsertFields", () => {
  it("emits one FULL-PUT create per weekday, isOpen always present and true", () => {
    const rows = presetUpsertFields(preset("evenings_thu_sat"), null);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.isOpen).toBe(true);
      // dayOfWeek XOR date — a weekly window is never a dated row.
      expect(row.date).toBeNull();
      expect(row.dayOfWeek).not.toBeNull();
      expect(row.startTime).toBe("19:00");
      expect(row.endTime).toBe("00:00");
      expect(row.note).toBeNull();
    }
  });

  it("threads the place-wide scope as calendarId: null", () => {
    const rows = presetUpsertFields(preset("weekends"), null);
    expect(rows.every((r) => r.calendarId === null)).toBe(true);
  });

  it("threads a default-calendar scope as that calendar's id", () => {
    const rows = presetUpsertFields(preset("weekends"), "cal-1");
    expect(rows.every((r) => r.calendarId === "cal-1")).toBe(true);
  });

  it("orders writes Monday-first, matching the editor's day order", () => {
    const rows = presetUpsertFields(preset("every_night"), null);
    expect(rows.map((r) => r.dayOfWeek)).toEqual([...WEEKDAY_ORDER]);

    // Sunday (0) sorts AFTER Saturday, not first.
    const wedSun = presetUpsertFields(preset("evenings_wed_sun"), null);
    expect(wedSun.map((r) => r.dayOfWeek)).toEqual([3, 4, 5, 6, 0]);
  });
});

describe("shouldOfferPresets", () => {
  it("offers presets only for a known-unconfigured venue", () => {
    expect(shouldOfferPresets(unconfigured)).toBe(true);
  });

  it("never offers presets once rows exist — replacing real hours would be data loss", () => {
    expect(shouldOfferPresets(configured)).toBe(false);
  });

  it("offers nothing while the detector has not answered", () => {
    expect(shouldOfferPresets(undefined)).toBe(false);
  });
});

describe("setupScope", () => {
  it("opens on the default calendar when the detector reports one", () => {
    expect(setupScope(configured)).toBe("cal-1");
  });

  it("falls back to the place-wide null scope", () => {
    expect(setupScope(unconfigured)).toBeNull();
    expect(setupScope(undefined)).toBeNull();
  });
});

describe("shouldShowHoursWarning", () => {
  it("shows only when accepting, verified, and known-unconfigured", () => {
    expect(
      shouldShowHoursWarning({
        accepts: true,
        isVerified: true,
        state: unconfigured,
      }),
    ).toBe(true);
  });

  it("renders nothing when configured", () => {
    expect(
      shouldShowHoursWarning({
        accepts: true,
        isVerified: true,
        state: configured,
      }),
    ).toBe(false);
  });

  it("renders nothing while the toggle is off", () => {
    expect(
      shouldShowHoursWarning({
        accepts: false,
        isVerified: true,
        state: unconfigured,
      }),
    ).toBe(false);
  });

  it("renders nothing for an unverified venue (its own helper copy owns that state)", () => {
    expect(
      shouldShowHoursWarning({
        accepts: true,
        isVerified: false,
        state: unconfigured,
      }),
    ).toBe(false);
  });

  it("renders nothing before the detector answers — no flash-and-retract", () => {
    expect(
      shouldShowHoursWarning({
        accepts: true,
        isVerified: true,
        state: undefined,
      }),
    ).toBe(false);
  });
});
