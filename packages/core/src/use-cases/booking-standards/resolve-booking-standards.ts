import type { BookingIntent } from "@th/types/repos/booking-requests";
import type {
  BookingPitchExampleRecord,
  BookingStandardField,
  BookingStandardItemRecord,
  BookingStandardRequirement,
} from "@th/types/repos/booking-standards";

import {
  BOOKING_STANDARDS_PLATFORM_DEFAULTS,
  type PlatformBookingStandards,
} from "./platform-defaults";
import {
  fieldAppliesToIntent,
  fieldCanBeRequired,
  isFieldSatisfied,
  type BookingStandardsPayload,
} from "./standard-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Effective booking standards for one calendar + intent (venue-booking-
// standards spec, FR-003). PURE: the one function every reader uses — the
// booking-options read, the create gate, the embed inquiry, and the form.
//
// Leaf module (type imports + the two leaves beside it) — safe in a client
// bundle. A test pins that import graph.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingStandardSource = "calendar" | "place" | "platform";
export type VenueBookingStandardSource = Exclude<BookingStandardSource, "platform">;

/**
 * A platform default. Carries i18n KEYS (render with `t(labelKey)`), and is
 * SUGGESTED by type (NFR-002).
 */
export type PlatformEffectiveBookingStandard = {
  source: "platform";
  field: BookingStandardField;
  requirement: "SUGGESTED";
  labelKey: string;
  hintKey: string | null;
};

/** A venue-authored item. Carries the venue's LITERAL text. */
export type VenueEffectiveBookingStandard = {
  source: VenueBookingStandardSource;
  field: BookingStandardField;
  requirement: BookingStandardRequirement;
  label: string;
  hint: string | null;
};

/** Discriminate on `source`: key-carrying platform vs literal venue text. */
export type EffectiveBookingStandard =
  | PlatformEffectiveBookingStandard
  | VenueEffectiveBookingStandard;

export type PlatformEffectiveBookingPitchExample = {
  source: "platform";
  titleKey: string;
  bodyKey: string;
};

export type VenueEffectiveBookingPitchExample = {
  source: VenueBookingStandardSource;
  title: string;
  body: string;
};

export type EffectiveBookingPitchExample =
  | PlatformEffectiveBookingPitchExample
  | VenueEffectiveBookingPitchExample;

export type EffectiveBookingStandards = {
  standards: EffectiveBookingStandard[];
  examples: EffectiveBookingPitchExample[];
  /**
   * Items the WINNING owner level had for this intent whose field no longer
   * applies to it (or is unknown to this bundle) and were therefore dropped.
   * Non-zero means stored data and the catalogue disagree — S2 reports it
   * (`reportError`) rather than failing the read.
   */
  droppedCount: number;
};

/**
 * One owner's rows, as `BookingStandardsRepo.listForOwners` returns them —
 * any intents; the resolver picks. Only the fields resolution reads.
 */
export type OwnerBookingStandardRows = {
  items: readonly Pick<
    BookingStandardItemRecord,
    "intent" | "field" | "label" | "hint" | "requirement" | "sortOrder"
  >[];
  examples: readonly Pick<
    BookingPitchExampleRecord,
    "intent" | "title" | "body" | "sortOrder"
  >[];
};

export type ResolveBookingStandardsInput = {
  intent: BookingIntent;
  /** The routed calendar's rows. Null/omitted = none. */
  calendarRows?: OwnerBookingStandardRows | null;
  /**
   * The calendar's place's rows (the venue default). Null/omitted = none —
   * and callers MUST pass null for an UNCLAIMED place (see standard-fields.ts).
   */
  placeRows?: OwnerBookingStandardRows | null;
  /** Injected for tests; defaults to the shipped platform constants. */
  platformDefaults?: PlatformBookingStandards;
};

const bySortOrder = <T extends { sortOrder: number }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder;

/** An owner's rows for `intent`, display order, before any filtering. */
function itemsFor(
  rows: OwnerBookingStandardRows | null | undefined,
  intent: BookingIntent,
) {
  return (rows?.items ?? [])
    .filter((row) => row.intent === intent)
    .slice()
    .sort(bySortOrder);
}

function examplesFor(
  rows: OwnerBookingStandardRows | null | undefined,
  intent: BookingIntent,
) {
  return (rows?.examples ?? [])
    .filter((row) => row.intent === intent)
    .slice()
    .sort(bySortOrder);
}

/**
 * FR-003, with the review decisions of 2026-09-25.
 *
 * ITEMS — the first owner level that HAS rows for the intent WINS, whole,
 * never merged: calendar, else place, else platform. Within the winner,
 * rows whose field the intent's form does not have (or this bundle does not
 * know) are DROPPED and counted in `droppedCount`. If that empties the
 * winner, resolution falls to the PLATFORM defaults (SUGGESTED-only) — NEVER
 * down to the place: a calendar that overrode the place's list must not have
 * the place's REQUIRED items come back because its own rows went stale.
 *
 * A stored REQUIRED on a field that cannot be required
 * (`fieldCanBeRequired` false — CUSTOM, or schema-mandatory fields) reads as
 * SUGGESTED: the write path refuses it, so only a catalogue change can put
 * one here, and it must not start blocking.
 *
 * EXAMPLES fall through calendar → place the same way, INDEPENDENTLY of the
 * items (a calendar may set its own examples and inherit the place's list),
 * and are then ADDITIVE with the platform's: venue examples first.
 */
export function resolveBookingStandards(
  input: ResolveBookingStandardsInput,
): EffectiveBookingStandards {
  const { intent } = input;
  const platform = (input.platformDefaults ??
    BOOKING_STANDARDS_PLATFORM_DEFAULTS)[intent];

  const calendarItems = itemsFor(input.calendarRows, intent);
  const placeItems = itemsFor(input.placeRows, intent);
  const winner: {
    source: VenueBookingStandardSource;
    rows: ReturnType<typeof itemsFor>;
  } | null =
    calendarItems.length > 0
      ? { source: "calendar", rows: calendarItems }
      : placeItems.length > 0
        ? { source: "place", rows: placeItems }
        : null;

  const applicable =
    winner?.rows.filter((row) => fieldAppliesToIntent(row.field, intent)) ??
    [];
  const droppedCount = (winner?.rows.length ?? 0) - applicable.length;

  const standards: EffectiveBookingStandard[] =
    winner !== null && applicable.length > 0
      ? applicable.map(
          (row): VenueEffectiveBookingStandard => ({
            source: winner.source,
            field: row.field,
            requirement:
              row.requirement === "REQUIRED" && !fieldCanBeRequired(row.field)
                ? "SUGGESTED"
                : row.requirement,
            label: row.label,
            hint: row.hint,
          }),
        )
      : platform.items.map(
          (row): PlatformEffectiveBookingStandard => ({
            source: "platform",
            field: row.field,
            requirement: row.requirement,
            labelKey: row.labelKey,
            hintKey: row.hintKey,
          }),
        );

  const calendarExamples = examplesFor(input.calendarRows, intent);
  const venueExamples: VenueEffectiveBookingPitchExample[] =
    calendarExamples.length > 0
      ? calendarExamples.map((row) => ({
          source: "calendar",
          title: row.title,
          body: row.body,
        }))
      : examplesFor(input.placeRows, intent).map((row) => ({
          source: "place",
          title: row.title,
          body: row.body,
        }));

  return {
    standards,
    examples: [
      ...venueExamples,
      ...platform.examples.map(
        (row): PlatformEffectiveBookingPitchExample => ({
          source: "platform",
          titleKey: row.titleKey,
          bodyKey: row.bodyKey,
        }),
      ),
    ],
    droppedCount,
  };
}

/**
 * The REQUIRED standards `payload` does not satisfy, in display order — what
 * STANDARDS_UNMET lists (with the venue's `label`) and what the form marks
 * inline. Only VENUE items can ever appear: platform items are SUGGESTED by
 * type, and a field that cannot be required (CUSTOM, schema-mandatory) never
 * blocks even if it somehow reads REQUIRED.
 */
export function unmetRequiredStandards(
  standards: readonly EffectiveBookingStandard[],
  payload: BookingStandardsPayload,
): VenueEffectiveBookingStandard[] {
  return standards.filter(
    (standard): standard is VenueEffectiveBookingStandard =>
      standard.source !== "platform" &&
      standard.requirement === "REQUIRED" &&
      fieldCanBeRequired(standard.field) &&
      !isFieldSatisfied(standard.field, payload),
  );
}
