import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { BookingIntent } from "@th/types/repos/booking-requests";
import type {
  BookingPitchExampleRecord,
  BookingStandardItemRecord,
  BookingStandardOwnerKey,
} from "@th/types/repos/booking-standards";
import type { CalendarRow } from "@th/ports/repos/calendars";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ensurePlaceOwnerAccess } from "../places/_shared/ensure-place-owner-access";
import {
  bookingPitchExamplesWriteBaseSchema,
  bookingStandardFieldSchema,
  bookingStandardIntentSchema,
  bookingStandardItemsWriteBaseSchema,
  bookingStandardRequirementSchema,
  refineItemsApplyToIntent,
} from "./booking-standards-schemas";
import {
  effectiveBookingStandardsWireSchema,
  toEffectiveBookingStandardsWire,
} from "./effective-booking-standards-schemas";
import { calendarRequestIntents } from "./load-effective-booking-standards";
import {
  resolveBookingStandards,
  type OwnerBookingStandardRows,
} from "./resolve-booking-standards";

// ─────────────────────────────────────────────────────────────────────────────
// Authoring venue booking standards (venue-booking-standards spec, FR-007).
//
// Four replace-all writes — items and examples, for a CALENDAR or the PLACE
// default — and one editor read. AUTHZ is exactly the calendar editor's:
// `ensurePlaceOwnerAccess` (an ORG_EDIT_ROLES member of an owning org, or a
// verified direct human owner), run first, before any row is read — the same
// gate `updateCalendar` runs, so whoever may edit the calendar's rate fields
// may edit its standards, and a refusal is the same NOT_RESOURCE_OWNER.
//
// Calendar writes also take `placeId` and assert the calendar belongs to it
// INSIDE the transaction (manage-calendars' cross-place isolation: a foreign
// calendar id is CALENDAR_NOT_FOUND, indistinguishable from a missing one).
//
// NOT degraded: unlike the readers, a write fails loudly when storage does
// (e.g. the table not migrated yet). Only the editor calls these, and a
// silently dropped save is worse than an error the venue can see.
// ─────────────────────────────────────────────────────────────────────────────

export type ManageBookingStandardsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

const INTENTS = ["PERFORM", "RENT", "USE"] as const satisfies readonly BookingIntent[];

/**
 * The calendar, asserted to be `placeId`'s, and asserted to take REQUESTS
 * for `intent` — standards for an intent nobody can ask for would never be
 * shown. Same machine message as the create gate's refusal.
 */
async function assertCalendarForIntent(
  tx: Pick<TxRepos, "calendars">,
  args: { placeId: string; calendarId: string; intent: BookingIntent },
): Promise<CalendarRow> {
  const calendar = await tx.calendars.findById(args.calendarId);
  if (!calendar || calendar.placeId !== args.placeId) {
    throw fail("CALENDAR_NOT_FOUND");
  }
  if (!calendarRequestIntents(calendar).includes(args.intent)) {
    throw fail("INVALID_INPUT", {
      message: "calendar_rejects_intent",
      meta: { calendarId: calendar.id, intent: args.intent },
    });
  }
  return calendar;
}

// ── Output rows (the venue's own text, as stored) ────────────────────────────

export const bookingStandardItemRowSchema = z
  .object({
    field: bookingStandardFieldSchema,
    label: z.string(),
    hint: z.string().nullable(),
    requirement: bookingStandardRequirementSchema,
    sortOrder: z.number().int(),
  })
  .strict();

export const bookingPitchExampleRowSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    sortOrder: z.number().int(),
  })
  .strict();

const toItemRow = (row: BookingStandardItemRecord) => ({
  field: row.field,
  label: row.label,
  hint: row.hint,
  requirement: row.requirement,
  sortOrder: row.sortOrder,
});

const toExampleRow = (row: BookingPitchExampleRecord) => ({
  title: row.title,
  body: row.body,
  sortOrder: row.sortOrder,
});

export const setBookingStandardsOutputSchema = z
  .object({
    intent: bookingStandardIntentSchema,
    items: z.array(bookingStandardItemRowSchema),
  })
  .strict();

export const setPitchExamplesOutputSchema = z
  .object({
    intent: bookingStandardIntentSchema,
    examples: z.array(bookingPitchExampleRowSchema),
  })
  .strict();

export type SetBookingStandardsOutput = z.infer<
  typeof setBookingStandardsOutputSchema
>;
export type SetPitchExamplesOutput = z.infer<typeof setPitchExamplesOutputSchema>;

// ── Calendar: items ──────────────────────────────────────────────────────────

export const setCalendarBookingStandardsInputSchema =
  bookingStandardItemsWriteBaseSchema
    .extend({
      actorHumanId: z.uuid(),
      placeId: z.uuid(),
      calendarId: z.uuid(),
    })
    .strict()
    .superRefine(refineItemsApplyToIntent);

export type SetCalendarBookingStandardsInput = z.infer<
  typeof setCalendarBookingStandardsInputSchema
>;

/** Replace one calendar's items for one intent. `[]` = use the venue default. */
export async function setCalendarBookingStandards(
  deps: ManageBookingStandardsDeps,
  rawInput: unknown,
): Promise<SetBookingStandardsOutput> {
  const input = parseInput(setCalendarBookingStandardsInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const items = await deps.repos.tx(async (tx) => {
    await assertCalendarForIntent(tx, input);
    const written = await tx.bookingStandards.replaceItems({
      ownerType: "CALENDAR",
      ownerId: input.calendarId,
      intent: input.intent,
      items: input.items,
    });
    await tx.audit.log({
      entity: "calendar",
      entityId: input.calendarId,
      action: "booking_standards_updated",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        intent: input.intent,
        items: input.items,
      },
      at: deps.clock.now(),
    });
    return written;
  });

  deps.logger?.info("booking_standards.calendar_items_updated", {
    placeId: input.placeId,
    calendarId: input.calendarId,
    intent: input.intent,
    count: items.length,
  });
  return setBookingStandardsOutputSchema.parse({
    intent: input.intent,
    items: items.map(toItemRow),
  });
}

// ── Calendar: examples ───────────────────────────────────────────────────────

export const setCalendarPitchExamplesInputSchema =
  bookingPitchExamplesWriteBaseSchema
    .extend({
      actorHumanId: z.uuid(),
      placeId: z.uuid(),
      calendarId: z.uuid(),
    })
    .strict();

export type SetCalendarPitchExamplesInput = z.infer<
  typeof setCalendarPitchExamplesInputSchema
>;

/** Replace one calendar's example pitches for one intent. */
export async function setCalendarPitchExamples(
  deps: ManageBookingStandardsDeps,
  rawInput: unknown,
): Promise<SetPitchExamplesOutput> {
  const input = parseInput(setCalendarPitchExamplesInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const examples = await deps.repos.tx(async (tx) => {
    await assertCalendarForIntent(tx, input);
    const written = await tx.bookingStandards.replaceExamples({
      ownerType: "CALENDAR",
      ownerId: input.calendarId,
      intent: input.intent,
      examples: input.examples,
    });
    await tx.audit.log({
      entity: "calendar",
      entityId: input.calendarId,
      action: "pitch_examples_updated",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        intent: input.intent,
        examples: input.examples,
      },
      at: deps.clock.now(),
    });
    return written;
  });

  deps.logger?.info("booking_standards.calendar_examples_updated", {
    placeId: input.placeId,
    calendarId: input.calendarId,
    intent: input.intent,
    count: examples.length,
  });
  return setPitchExamplesOutputSchema.parse({
    intent: input.intent,
    examples: examples.map(toExampleRow),
  });
}

// ── Place default: items ─────────────────────────────────────────────────────

export const setPlaceBookingStandardsInputSchema =
  bookingStandardItemsWriteBaseSchema
    .extend({
      actorHumanId: z.uuid(),
      placeId: z.uuid(),
    })
    .strict()
    .superRefine(refineItemsApplyToIntent);

export type SetPlaceBookingStandardsInput = z.infer<
  typeof setPlaceBookingStandardsInputSchema
>;

/**
 * Replace the PLACE default for one intent — what every calendar without
 * its own rows for that intent inherits. `[]` = the platform defaults.
 */
export async function setPlaceBookingStandards(
  deps: ManageBookingStandardsDeps,
  rawInput: unknown,
): Promise<SetBookingStandardsOutput> {
  const input = parseInput(setPlaceBookingStandardsInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const items = await deps.repos.tx(async (tx) => {
    const written = await tx.bookingStandards.replaceItems({
      ownerType: "PLACE",
      ownerId: input.placeId,
      intent: input.intent,
      items: input.items,
    });
    await tx.audit.log({
      entity: "place",
      entityId: input.placeId,
      action: "booking_standards_updated",
      data: {
        actorHumanId: input.actorHumanId,
        intent: input.intent,
        items: input.items,
      },
      at: deps.clock.now(),
    });
    return written;
  });

  deps.logger?.info("booking_standards.place_items_updated", {
    placeId: input.placeId,
    intent: input.intent,
    count: items.length,
  });
  return setBookingStandardsOutputSchema.parse({
    intent: input.intent,
    items: items.map(toItemRow),
  });
}

// ── Place default: examples ──────────────────────────────────────────────────

export const setPlacePitchExamplesInputSchema =
  bookingPitchExamplesWriteBaseSchema
    .extend({
      actorHumanId: z.uuid(),
      placeId: z.uuid(),
    })
    .strict();

export type SetPlacePitchExamplesInput = z.infer<
  typeof setPlacePitchExamplesInputSchema
>;

/** Replace the PLACE default example pitches for one intent. */
export async function setPlacePitchExamples(
  deps: ManageBookingStandardsDeps,
  rawInput: unknown,
): Promise<SetPitchExamplesOutput> {
  const input = parseInput(setPlacePitchExamplesInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const examples = await deps.repos.tx(async (tx) => {
    const written = await tx.bookingStandards.replaceExamples({
      ownerType: "PLACE",
      ownerId: input.placeId,
      intent: input.intent,
      examples: input.examples,
    });
    await tx.audit.log({
      entity: "place",
      entityId: input.placeId,
      action: "pitch_examples_updated",
      data: {
        actorHumanId: input.actorHumanId,
        intent: input.intent,
        examples: input.examples,
      },
      at: deps.clock.now(),
    });
    return written;
  });

  deps.logger?.info("booking_standards.place_examples_updated", {
    placeId: input.placeId,
    intent: input.intent,
    count: examples.length,
  });
  return setPitchExamplesOutputSchema.parse({
    intent: input.intent,
    examples: examples.map(toExampleRow),
  });
}

// ── Editor read ──────────────────────────────────────────────────────────────

export const getBookingStandardsForEditingInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    placeId: z.uuid(),
  })
  .strict();

export type GetBookingStandardsForEditingInput = z.infer<
  typeof getBookingStandardsForEditingInputSchema
>;

/**
 * One (owner, intent) as the editor shows it: the owner's OWN rows (empty =
 * it inherits) and what a requester actually sees there (`effective`), so a
 * calendar with no rows can say "Using the venue default" and show it.
 */
const ownerIntentEditingSchema = z
  .object({
    items: z.array(bookingStandardItemRowSchema),
    examples: z.array(bookingPitchExampleRowSchema),
    effective: effectiveBookingStandardsWireSchema,
  })
  .strict();

export const getBookingStandardsForEditingOutputSchema = z
  .object({
    placeId: z.uuid(),
    /** The venue default, every intent (a calendar may take any of them). */
    place: z
      .object({
        PERFORM: ownerIntentEditingSchema,
        RENT: ownerIntentEditingSchema,
        USE: ownerIntentEditingSchema,
      })
      .strict(),
    /** Every calendar at the place, default first (the calendars repo's order). */
    calendars: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          isDefault: z.boolean(),
          /** The intents it takes requests for — the sections the editor shows. */
          intents: z.array(bookingStandardIntentSchema),
          standards: z
            .object({
              PERFORM: ownerIntentEditingSchema.optional(),
              RENT: ownerIntentEditingSchema.optional(),
              USE: ownerIntentEditingSchema.optional(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

export type GetBookingStandardsForEditingOutput = z.infer<
  typeof getBookingStandardsForEditingOutputSchema
>;

/**
 * The editor's read: every owner at the place (the place + each calendar),
 * per intent, raw rows plus the resolved list. Same authz as the writes.
 * NOT degraded — an editor that silently showed the platform defaults over a
 * failed read would invite a save that wipes the venue's real list.
 */
export async function getBookingStandardsForEditing(
  deps: ManageBookingStandardsDeps,
  rawInput: unknown,
): Promise<GetBookingStandardsForEditingOutput> {
  const input = parseInput(getBookingStandardsForEditingInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const calendars = await deps.repos.calendars.listByPlace(input.placeId);
  const owners: BookingStandardOwnerKey[] = [
    { ownerType: "PLACE", ownerId: input.placeId },
    ...calendars.map(
      (calendar): BookingStandardOwnerKey => ({
        ownerType: "CALENDAR",
        ownerId: calendar.id,
      }),
    ),
  ];
  const rows = await deps.repos.bookingStandards.listForOwners({ owners });

  const rowsOf = (key: BookingStandardOwnerKey) => ({
    items: rows.items.filter(
      (row) => row.ownerType === key.ownerType && row.ownerId === key.ownerId,
    ),
    examples: rows.examples.filter(
      (row) => row.ownerType === key.ownerType && row.ownerId === key.ownerId,
    ),
  });
  const placeRows = rowsOf({ ownerType: "PLACE", ownerId: input.placeId });

  const editingFor = (
    own: { items: BookingStandardItemRecord[]; examples: BookingPitchExampleRecord[] },
    intent: BookingIntent,
    resolveWith: { calendarRows: OwnerBookingStandardRows | null },
  ) => ({
    items: own.items.filter((row) => row.intent === intent).map(toItemRow),
    examples: own.examples
      .filter((row) => row.intent === intent)
      .map(toExampleRow),
    effective: toEffectiveBookingStandardsWire(
      resolveBookingStandards({
        intent,
        calendarRows: resolveWith.calendarRows,
        placeRows,
      }),
    ),
  });

  return getBookingStandardsForEditingOutputSchema.parse({
    placeId: input.placeId,
    // The place's effective list is what a calendar with NO rows gets.
    place: Object.fromEntries(
      INTENTS.map((intent) => [
        intent,
        editingFor(placeRows, intent, { calendarRows: null }),
      ]),
    ),
    calendars: calendars.map((calendar) => {
      const own = rowsOf({ ownerType: "CALENDAR", ownerId: calendar.id });
      const intents = calendarRequestIntents(calendar);
      return {
        id: calendar.id,
        name: calendar.name,
        isDefault: calendar.isDefault,
        intents,
        standards: Object.fromEntries(
          intents.map((intent) => [
            intent,
            editingFor(own, intent, { calendarRows: own }),
          ]),
        ),
      };
    }),
  });
}
