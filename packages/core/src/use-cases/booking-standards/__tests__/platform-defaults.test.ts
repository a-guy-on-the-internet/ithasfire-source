import { describe, expect, it } from "vitest";

import {
  BOOKING_STANDARDS_PLATFORM_DEFAULTS,
  platformBookingStandardKeys,
} from "../platform-defaults";
import { fieldAppliesToIntent } from "../standard-fields";

const INTENTS = ["PERFORM", "RENT", "USE"] as const;

describe("platform booking standards", () => {
  it("NFR-002: every platform item is SUGGESTED", () => {
    for (const intent of INTENTS) {
      for (const entry of BOOKING_STANDARDS_PLATFORM_DEFAULTS[intent].items) {
        expect(entry.requirement, `${intent} ${entry.field}`).toBe("SUGGESTED");
      }
    }
  });

  it("uses the suggested lists from the build brief", () => {
    const fields = (intent: (typeof INTENTS)[number]) =>
      BOOKING_STANDARDS_PLATFORM_DEFAULTS[intent].items.map((e) => e.field);
    expect(fields("PERFORM")).toEqual([
      "PREFERRED_DATES",
      "LINK_MUSIC",
      "EXPECTED_DRAW",
      "SET_LENGTH",
    ]);
    expect(fields("RENT")).toEqual([
      "REQUESTED_WINDOW",
      "PURPOSE",
      "EXPECTED_ATTENDANCE",
    ]);
    expect(fields("USE")).toEqual(fields("RENT"));
  });

  it("every platform item's field exists on its intent's form", () => {
    for (const intent of INTENTS) {
      for (const entry of BOOKING_STANDARDS_PLATFORM_DEFAULTS[intent].items) {
        expect(fieldAppliesToIntent(entry.field, intent), entry.field).toBe(true);
      }
    }
  });

  it("two platform examples per intent (FR-002)", () => {
    for (const intent of INTENTS) {
      expect(BOOKING_STANDARDS_PLATFORM_DEFAULTS[intent].examples).toHaveLength(2);
    }
  });

  it("every string is an i18n key under bookingStandards.platform, all distinct", () => {
    const keys = platformBookingStandardKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^bookingStandards\.platform\.(perform|rent|use)\.[a-zA-Z]+\.(label|hint|title|body)$/);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});
