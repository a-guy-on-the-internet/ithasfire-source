import type { BookingIntent } from "@th/types/repos/booking-requests";
import type { BookingStandardField } from "@th/types/repos/booking-standards";

// ─────────────────────────────────────────────────────────────────────────────
// Platform booking standards — what a venue that has set nothing shows
// (venue-booking-standards spec, FR-002 / FR-003 / NFR-002, D4).
//
// SUGGESTED-ONLY, and the type says so: `requirement` is the literal
// "SUGGESTED", so a REQUIRED platform default does not compile. That is
// NFR-002 — nothing newly blocks submit anywhere on day one.
//
// Every string here is an i18n KEY, not copy — hence `labelKey` / `hintKey`
// / `titleKey` / `bodyKey`, never `label`. The web layer renders them from
// `apps/web/src/i18n/messages/{en,es}.ts` (`bookingStandards.platform.*`); a
// web test pins every key below to both catalogs. The resolver keeps the
// distinction in its output TYPE: `source: "platform"` entries carry keys,
// venue entries carry the venue's literal `label` / `title`.
//
// Leaf module (type imports only) — safe in a client bundle.
// ─────────────────────────────────────────────────────────────────────────────

export type PlatformBookingStandardItem = {
  readonly field: BookingStandardField;
  readonly labelKey: string;
  /** Null for no hint. */
  readonly hintKey: string | null;
  readonly requirement: "SUGGESTED";
};

export type PlatformBookingPitchExample = {
  readonly titleKey: string;
  readonly bodyKey: string;
};

export type PlatformBookingStandards = {
  readonly [I in BookingIntent]: {
    readonly items: readonly PlatformBookingStandardItem[];
    readonly examples: readonly PlatformBookingPitchExample[];
  };
};

const ROOT = "bookingStandards.platform";

function item(
  intentKey: string,
  field: BookingStandardField,
  fieldKey: string,
): PlatformBookingStandardItem {
  return {
    field,
    labelKey: `${ROOT}.${intentKey}.${fieldKey}.label`,
    hintKey: `${ROOT}.${intentKey}.${fieldKey}.hint`,
    requirement: "SUGGESTED",
  };
}

function example(
  intentKey: string,
  exampleKey: string,
): PlatformBookingPitchExample {
  return {
    titleKey: `${ROOT}.${intentKey}.${exampleKey}.title`,
    bodyKey: `${ROOT}.${intentKey}.${exampleKey}.body`,
  };
}

export const BOOKING_STANDARDS_PLATFORM_DEFAULTS: PlatformBookingStandards = {
  PERFORM: {
    items: [
      item("perform", "PREFERRED_DATES", "preferredDates"),
      item("perform", "LINK_MUSIC", "linkMusic"),
      item("perform", "EXPECTED_DRAW", "expectedDraw"),
      item("perform", "SET_LENGTH", "setLength"),
    ],
    examples: [example("perform", "exampleOne"), example("perform", "exampleTwo")],
  },
  RENT: {
    items: [
      item("rent", "REQUESTED_WINDOW", "requestedWindow"),
      item("rent", "PURPOSE", "purpose"),
      item("rent", "EXPECTED_ATTENDANCE", "expectedAttendance"),
    ],
    examples: [example("rent", "exampleOne"), example("rent", "exampleTwo")],
  },
  USE: {
    items: [
      item("use", "REQUESTED_WINDOW", "requestedWindow"),
      item("use", "PURPOSE", "purpose"),
      item("use", "EXPECTED_ATTENDANCE", "expectedAttendance"),
    ],
    examples: [example("use", "exampleOne"), example("use", "exampleTwo")],
  },
};

/** Every i18n key the defaults reference — for the catalog drift test. */
export function platformBookingStandardKeys(
  defaults: PlatformBookingStandards = BOOKING_STANDARDS_PLATFORM_DEFAULTS,
): string[] {
  const keys: string[] = [];
  for (const intent of Object.keys(defaults) as BookingIntent[]) {
    for (const entry of defaults[intent].items) {
      keys.push(entry.labelKey);
      if (entry.hintKey !== null) keys.push(entry.hintKey);
    }
    for (const entry of defaults[intent].examples) {
      keys.push(entry.titleKey, entry.bodyKey);
    }
  }
  return keys;
}
