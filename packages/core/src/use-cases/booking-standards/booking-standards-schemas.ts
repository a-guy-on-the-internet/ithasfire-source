import { z } from "zod";

import {
  plainTextMultilineRequired,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";

import {
  BOOKING_PITCH_EXAMPLE_BODY_MAX,
  BOOKING_PITCH_EXAMPLE_TITLE_MAX,
  BOOKING_PITCH_EXAMPLES_MAX,
  BOOKING_STANDARD_FIELDS,
  BOOKING_STANDARD_HINT_MAX,
  BOOKING_STANDARD_ITEMS_MAX,
  BOOKING_STANDARD_LABEL_MAX,
  fieldAppliesToIntent,
  fieldCanBeRequired,
} from "./standard-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Write-path validation for booking standards + example pitches
// (venue-booking-standards spec, FR-001 / FR-002 / NFR-001, D2a). The use
// cases that own the writes (S2: setBookingStandards / setBookingPitchExamples)
// extend the base objects here with their owner + actor fields, re-apply
// `.strict()`, and add `refineItemsApplyToIntent` — the same
// base-object + refine-function split as `createBookingRequestBaseSchema` /
// `refineIntentShape`, because a refined zod object cannot be `.extend()`ed.
//
// NOT a leaf: pulls zod and sanitize-html. Client code imports
// `./standard-fields` for the constants, never this file.
// ─────────────────────────────────────────────────────────────────────────────

export const bookingStandardOwnerTypeSchema = z.enum(["PLACE", "CALENDAR"]);
export const bookingStandardIntentSchema = z.enum(["PERFORM", "RENT", "USE"]);
export const bookingStandardFieldSchema = z.enum(
  BOOKING_STANDARD_FIELDS as [
    (typeof BOOKING_STANDARD_FIELDS)[number],
    ...(typeof BOOKING_STANDARD_FIELDS)[number][],
  ],
);
export const bookingStandardRequirementSchema = z.enum([
  "REQUIRED",
  "SUGGESTED",
]);

/**
 * NFR-001: no links in venue-authored labels, hints or example TITLES. The
 * sanitizer already strips markup; this refuses URL-ish text a renderer (or a
 * mail client) could still auto-link:
 *   - anything with a scheme separator `://` (http, https, hxxp, ftp, …),
 *   - `www.`,
 *   - a bare domain on a common TLD (`bandcamp.com`, `example.io/path`). The
 *     TLD set is deliberately short, so ordinary prose like "St. Louis" or
 *     "3.5 hours" never trips it.
 * Conservative on purpose: it will miss exotic TLDs rather than refuse
 * honest wording. Example pitch BODIES may carry links — a real pitch does.
 */
const LINK_IN_TEXT =
  /:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|ly|fm|co|me|app|link|page|site|us|uk)\b(?:\/\S*)?/i;
export const containsLinkLikeText = (value: string): boolean =>
  LINK_IN_TEXT.test(value);
const noLink = (value: string) => !containsLinkLikeText(value);

/** The venue's wording: sanitized BEFORE the length cap (house helper). */
const standardLabelSchema = plainTextRequired(BOOKING_STANDARD_LABEL_MAX).refine(
  noLink,
  { message: "booking_standard_label_contains_link" },
);

/**
 * Optional hint. Sanitized first; empty-after-sanitize (or an explicit null)
 * normalizes to `null`, so "no hint" has ONE stored shape.
 */
const standardHintSchema = plainTextOptional(BOOKING_STANDARD_HINT_MAX)
  .refine(noLink, { message: "booking_standard_hint_contains_link" })
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

/**
 * One item. `canBeRequired` is enforced HERE (an `invalid_input` issue on
 * `requirement`): CUSTOM (D2a — the SQL CHECK backstops this one) and the
 * schema-mandatory fields (MESSAGE, PREFERRED_DATES, PURPOSE,
 * REQUESTED_WINDOW — core-only, so the catalogue can change without a
 * migration) may be SUGGESTED, never REQUIRED.
 */
export const bookingStandardItemInputSchema = z
  .object({
    field: bookingStandardFieldSchema,
    label: standardLabelSchema,
    hint: standardHintSchema,
    requirement: bookingStandardRequirementSchema,
  })
  .strict()
  .refine(
    (item) => item.requirement !== "REQUIRED" || fieldCanBeRequired(item.field),
    {
      message: "booking_standard_field_cannot_be_required",
      path: ["requirement"],
    },
  );

/**
 * One list per (owner, intent). A known field may appear ONCE — two rows for
 * the same field would render two ticks that always agree and, if one were
 * REQUIRED, two identical entries in STANDARDS_UNMET. CUSTOM lines are
 * free text and may repeat. The issue is pathed to the LATER duplicate's
 * `field` so the editor marks the row that was added second.
 */
export const bookingStandardItemsSchema = z
  .array(bookingStandardItemInputSchema)
  .max(BOOKING_STANDARD_ITEMS_MAX)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (item.field === "CUSTOM") return;
      if (seen.has(item.field)) {
        ctx.addIssue({
          code: "custom",
          message: "booking_standard_field_duplicate",
          path: [index, "field"],
        });
        return;
      }
      seen.add(item.field);
    });
  });

/**
 * One venue-written example pitch: plain text, multi-line body. The TITLE is
 * link-free (NFR-001); the body may link, as a real pitch would.
 */
export const bookingPitchExampleInputSchema = z
  .object({
    title: plainTextRequired(BOOKING_PITCH_EXAMPLE_TITLE_MAX).refine(noLink, {
      message: "booking_pitch_example_title_contains_link",
    }),
    body: plainTextMultilineRequired(BOOKING_PITCH_EXAMPLE_BODY_MAX),
  })
  .strict();

export const bookingPitchExamplesSchema = z
  .array(bookingPitchExampleInputSchema)
  .max(BOOKING_PITCH_EXAMPLES_MAX);

/**
 * Base objects for the S2 write inputs — extend with the owner + actor
 * fields, `.strict()`, then `.superRefine(refineItemsApplyToIntent)` on the
 * items one.
 */
export const bookingStandardItemsWriteBaseSchema = z.object({
  intent: bookingStandardIntentSchema,
  items: bookingStandardItemsSchema,
});

export const bookingPitchExamplesWriteBaseSchema = z.object({
  intent: bookingStandardIntentSchema,
  examples: bookingPitchExamplesSchema,
});

/**
 * Every item's field must exist on the intent's form (a music link on a RENT
 * list could never be met). One issue per offending item, pathed to its
 * `field`.
 */
export function refineItemsApplyToIntent(
  value: {
    intent: z.infer<typeof bookingStandardIntentSchema>;
    items: readonly { field: z.infer<typeof bookingStandardFieldSchema> }[];
  },
  ctx: z.RefinementCtx,
): void {
  value.items.forEach((item, index) => {
    if (!fieldAppliesToIntent(item.field, value.intent)) {
      ctx.addIssue({
        code: "custom",
        message: "booking_standard_field_not_for_intent",
        path: ["items", index, "field"],
      });
    }
  });
}

/** Composed, for callers that need nothing else (and for the tests). */
export const bookingStandardItemsWriteSchema = bookingStandardItemsWriteBaseSchema
  .strict()
  .superRefine(refineItemsApplyToIntent);

export const bookingPitchExamplesWriteSchema =
  bookingPitchExamplesWriteBaseSchema.strict();

export type BookingStandardItemWriteInput = z.infer<
  typeof bookingStandardItemInputSchema
>;
export type BookingPitchExampleWriteInput = z.infer<
  typeof bookingPitchExampleInputSchema
>;
