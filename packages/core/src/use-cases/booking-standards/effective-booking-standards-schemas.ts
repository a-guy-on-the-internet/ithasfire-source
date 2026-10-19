import { z } from "zod";

import {
  bookingStandardFieldSchema,
  bookingStandardRequirementSchema,
} from "./booking-standards-schemas";
import type { EffectiveBookingStandardsByIntent } from "./load-effective-booking-standards";
import type { EffectiveBookingStandards } from "./resolve-booking-standards";

// ─────────────────────────────────────────────────────────────────────────────
// Wire (output) schemas for RESOLVED booking standards — what the options
// read and the editor read put on the wire (FR-004 / FR-007). They mirror the
// resolver's discriminated union exactly: platform entries carry i18n KEYS,
// venue entries carry the venue's LITERAL text, and `.strict()` keeps each
// shape from growing the other's fields. `droppedCount` is internal (the
// loader reports it) and never leaves.
// ─────────────────────────────────────────────────────────────────────────────

const platformStandardSchema = z
  .object({
    source: z.literal("platform"),
    field: bookingStandardFieldSchema,
    requirement: z.literal("SUGGESTED"),
    labelKey: z.string(),
    hintKey: z.string().nullable(),
  })
  .strict();

const venueStandardSchema = z
  .object({
    source: z.enum(["calendar", "place"]),
    field: bookingStandardFieldSchema,
    requirement: bookingStandardRequirementSchema,
    label: z.string(),
    hint: z.string().nullable(),
  })
  .strict();

export const effectiveBookingStandardSchema = z.union([
  platformStandardSchema,
  venueStandardSchema,
]);

const platformExampleSchema = z
  .object({
    source: z.literal("platform"),
    titleKey: z.string(),
    bodyKey: z.string(),
  })
  .strict();

const venueExampleSchema = z
  .object({
    source: z.enum(["calendar", "place"]),
    title: z.string(),
    body: z.string(),
  })
  .strict();

export const effectiveBookingPitchExampleSchema = z.union([
  platformExampleSchema,
  venueExampleSchema,
]);

/** One (calendar, intent)'s resolved list, as the dialog reads it. */
export const effectiveBookingStandardsWireSchema = z
  .object({
    standards: z.array(effectiveBookingStandardSchema),
    examples: z.array(effectiveBookingPitchExampleSchema),
  })
  .strict();

/** Intent-keyed; an intent the calendar does not take is absent. */
export const effectiveBookingStandardsByIntentWireSchema = z
  .object({
    PERFORM: effectiveBookingStandardsWireSchema.optional(),
    RENT: effectiveBookingStandardsWireSchema.optional(),
    USE: effectiveBookingStandardsWireSchema.optional(),
  })
  .strict();

export type EffectiveBookingStandardsWire = z.infer<
  typeof effectiveBookingStandardsWireSchema
>;
export type EffectiveBookingStandardsByIntentWire = z.infer<
  typeof effectiveBookingStandardsByIntentWireSchema
>;

/** Drop the internal `droppedCount`: the wire carries the lists only. */
export function toEffectiveBookingStandardsWire(
  effective: EffectiveBookingStandards,
): EffectiveBookingStandardsWire {
  return { standards: effective.standards, examples: effective.examples };
}

/** Intent-keyed form of {@link toEffectiveBookingStandardsWire}. */
export function toEffectiveBookingStandardsByIntentWire(
  byIntent: EffectiveBookingStandardsByIntent,
): EffectiveBookingStandardsByIntentWire {
  const out: EffectiveBookingStandardsByIntentWire = {};
  for (const intent of ["PERFORM", "RENT", "USE"] as const) {
    const effective = byIntent[intent];
    if (effective) out[intent] = toEffectiveBookingStandardsWire(effective);
  }
  return out;
}
