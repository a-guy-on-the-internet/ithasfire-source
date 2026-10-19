import { z } from "zod";

import { redactedFreeformDraftLocationSchema } from "../../lib/location/redact-draft-location";
import {
  plainTextMultilineOptional,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";

const ownerScopeSchema = z.enum(["ORGANIZATION", "HUMAN"]);
const scheduleKindSchema = z.enum(["RRULE", "FIXED_DATES"]);
const occurrenceStatusSchema = z.enum([
  "PLANNED",
  "SKIPPED",
  "GENERATED",
  "PUBLISHED",
  "CANCELLED",
  "DETACHED",
]);
const resyncModeSchema = z.enum(["template_only", "series_only", "full"]);

const isoDateTimeSchema = z.string().refine((value) => {
  if (!value) {
    return false;
  }
  if (typeof value !== "string") {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}, "invalid_datetime");

function isValidIana(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(
      new Date("2020-01-01T00:00:00Z"),
    );
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => isValidIana(value), { message: "invalid_timezone" });

const locationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("place"),
      placeId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("saved-location"),
      savedLocationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("freeform"),
      addressText: plainTextRequired(200),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const payoutTermsLineSchema = z
  .object({
    payeeId: z.uuid(),
    percent: z.number().int().min(0).max(100),
    floorCents: z.number().int().min(0),
    capPercent: z.number().int().min(0).max(100).nullable().optional(),
    priority: z.number().int().min(0).max(100).optional(),
    rounding: z.enum(["FLOOR", "NEAREST"]).optional(),
  })
  .strict();
/** @deprecated Use `payoutTermsLineSchema` */
const agreementLineSchema = payoutTermsLineSchema;

const payoutTermsDraftSchema = z
  .object({
    lines: z.array(payoutTermsLineSchema).min(1),
    // INERT: parsed because stored template/series JSON carries it, but
    // nothing maps it onto PayoutTerms.feeMode (and there is no per-event fee
    // mode to set; docs/decisions/fee-mode-switch-dropped.md). Do not wire it.
    feeMode: z.enum(["INCLUSIVE", "ON_TOP"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const totals = new Map<number, number>();
    for (const line of value.lines) {
      const key = line.priority ?? 0;
      totals.set(key, (totals.get(key) ?? 0) + line.percent);
    }
    for (const [priority, total] of totals) {
      if (total > 100) {
        ctx.addIssue({
          code: "custom",
          message: `payout terms lines exceed 100% for priority ${priority}`,
        });
      }
    }
  });
/** @deprecated Use `payoutTermsDraftSchema` */
const agreementDraftSchema = payoutTermsDraftSchema;

const ticketTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    priceCents: z.number().int().min(0),
    capacity: z.number().int().min(0),
    seatSectionId: z.uuid().nullable().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE").optional(),
  })
  .strict();

function dedupeStringArray(max: number) {
  return z
    .array(z.string().trim().min(1).max(64))
    .max(max)
    .transform((values) => {
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const value of values) {
        if (!seen.has(value)) {
          seen.add(value);
          deduped.push(value);
        }
      }
      return deduped;
    });
}

const stringSet32 = dedupeStringArray(32);

const seriesDefaultsSchema = z
  .object({
    titlePrefix: plainTextRequired(120).optional(),
    location: locationSchema.optional(),
    categories: stringSet32.optional(),
    types: stringSet32.optional(),
    attributes: stringSet32.optional(),
    feePolicyId: z.uuid().optional(),
    // PAYOUT ROUTING (owner ruling 2026-09-28): payee lines + fee mode. Writes
    // are guarded by `guardPayoutTermsDraftWrite` (a human's delegates cannot
    // set it). Nothing materialises it today; whatever first turns it into
    // real PayoutTerms MUST re-check `ensurePayoutRoutingActor` for the actor
    // doing so — a delegate applying the principal's template/series must
    // not be the one who activates its payout routing.
    payoutTermsDraft: payoutTermsDraftSchema.optional(),
    ticketTypes: z
      .array(ticketTypeSchema)
      .max(50)
      .optional()
      .superRefine((ticketTypes, ctx) => {
        if (!ticketTypes) {
          return;
        }
        const names = new Set<string>();
        for (const ticketType of ticketTypes) {
          const normalized = ticketType.name.trim().toLowerCase();
          if (names.has(normalized)) {
            ctx.addIssue({
              code: "custom",
              message: "ticket type names must be unique",
            });
            break;
          }
          names.add(normalized);
        }
      }),
  })
  .strict();

const occurrenceOverridesSchema = z
  .object({
    title: plainTextRequired(140).optional(),
    location: locationSchema.optional(),
    types: stringSet32.optional(),
    attributes: stringSet32.optional(),
    /** Manually added one-off date (addSeriesOccurrence) — reconcile-proof. */
    manual: z.boolean().optional(),
    /** Stored values are sanitized at write time (skip/add inputs). */
    skipNote: z.string().max(200).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();

const scheduleSchema = z
  .object({
    kind: scheduleKindSchema,
    rrule: z.string().trim().min(1).max(500).optional(),
    dtstart: isoDateTimeSchema.optional(),
    until: isoDateTimeSchema.optional(),
    dates: z
      .array(isoDateTimeSchema)
      .min(1)
      .max(1000)
      .optional()
      .transform((dates) => {
        if (!dates) {
          return dates;
        }
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const value of dates) {
          if (!seen.has(value)) {
            seen.add(value);
            deduped.push(value);
          }
        }
        return deduped;
      }),
    windowStart: isoDateTimeSchema.optional(),
    windowEnd: isoDateTimeSchema.optional(),
    maxOccurrencesPerExpand: z.number().int().min(1).max(500).default(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "RRULE") {
      if (!value.rrule) {
        ctx.addIssue({
          code: "custom",
          path: ["rrule"],
          message: "rrule_required",
        });
      }
      if (!value.dtstart) {
        ctx.addIssue({
          code: "custom",
          path: ["dtstart"],
          message: "dtstart_required",
        });
      }
      if (value.dates) {
        ctx.addIssue({
          code: "custom",
          path: ["dates"],
          message: "dates_not_allowed",
        });
      }
    }
    if (value.kind === "FIXED_DATES") {
      if (!value.dates || value.dates.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["dates"],
          message: "dates_required",
        });
      }
      if (value.rrule) {
        ctx.addIssue({
          code: "custom",
          path: ["rrule"],
          message: "rrule_not_allowed",
        });
      }
      if (value.dtstart) {
        ctx.addIssue({
          code: "custom",
          path: ["dtstart"],
          message: "dtstart_not_allowed",
        });
      }
      if (value.until) {
        ctx.addIssue({
          code: "custom",
          path: ["until"],
          message: "until_not_allowed",
        });
      }
    }
    if (value.windowStart && value.windowEnd) {
      if (
        new Date(value.windowStart).getTime() >
        new Date(value.windowEnd).getTime()
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["windowEnd"],
          message: "window_end_before_start",
        });
      }
    }
  });

/**
 * A location as a READ returns it: the input shape, or — for a reader below
 * the edit roles — a REDACTED freeform (`{ kind, label }`, no street, no
 * coordinates). See `lib/location/redact-draft-location` (N4).
 */
const locationOutputSchema = z.union([
  locationSchema,
  redactedFreeformDraftLocationSchema,
]);
const seriesDefaultsOutputSchema = seriesDefaultsSchema
  .extend({ location: locationOutputSchema.optional() })
  .strict();
const occurrenceOverridesOutputSchema = occurrenceOverridesSchema
  .extend({ location: locationOutputSchema.optional() })
  .strict();

const eventSeriesDtoSchema = z
  .object({
    id: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable(),
    active: z.boolean(),
    timezone: timeZoneSchema,
    schedule: scheduleSchema,
    templateId: z.uuid().nullable(),
    defaults: seriesDefaultsOutputSchema.nullable().optional(),
    // Null when the creating account has been deleted (creator detached).
    createdByHumanId: z.uuid().nullable(),
    updatedByHumanId: z.uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    archivedAt: z.date().nullable(),
  })
  .strict();

const eventSeriesOccurrenceDtoSchema = z
  .object({
    id: z.uuid(),
    seriesId: z.uuid(),
    ordinal: z.number().int().min(1),
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    status: occurrenceStatusSchema,
    eventId: z.uuid().nullable(),
    overrides: occurrenceOverridesOutputSchema.nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

const cursorSchema = z.string().trim().min(1).max(256);

export const createEventSeriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: plainTextRequired(120),
    description: plainTextMultilineOptional(500).optional(),
    timezone: timeZoneSchema,
    schedule: scheduleSchema,
    templateId: z.uuid().optional(),
    defaults: seriesDefaultsSchema.optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const createEventSeriesResultSchema = z
  .object({
    seriesId: z.uuid(),
  })
  .strict();

export const updateEventSeriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    patch: z
      .object({
        name: plainTextRequired(120).optional(),
        description: plainTextMultilineOptional(500).nullable().optional(),
        timezone: timeZoneSchema.optional(),
        schedule: scheduleSchema.optional(),
        templateId: z.uuid().nullable().optional(),
        defaults: seriesDefaultsSchema.optional(),
        active: z.boolean().optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0, {
        message: "patch must include at least one field",
      }),
    clientKey: z.string().min(8),
  })
  .strict();

export const updateEventSeriesResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const archiveEventSeriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const archiveEventSeriesResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const expandSeriesInputSchemaBase = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    windowStart: isoDateTimeSchema.optional(),
    windowEnd: isoDateTimeSchema.optional(),
    maxOccurrences: z.number().int().min(1).max(500).optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const expandSeriesInputSchema = expandSeriesInputSchemaBase.superRefine(
  (value, ctx) => {
    if (!value.windowStart && !value.windowEnd) {
      ctx.addIssue({
        code: "custom",
        path: ["windowStart"],
        message: "window_bounds_required",
      });
    }
    if (value.windowStart && value.windowEnd) {
      if (
        new Date(value.windowStart).getTime() >
        new Date(value.windowEnd).getTime()
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["windowEnd"],
          message: "window_end_before_start",
        });
      }
    }
  },
);

export const expandSeriesResultSchema = z
  .object({
    seriesId: z.uuid(),
    occurrencesCreated: z.number().int().min(0),
    occurrences: z.array(eventSeriesOccurrenceDtoSchema),
  })
  .strict();

// ── Reconcile Series Schedule ──

const pendingConfirmationItemSchema = z
  .object({
    occurrenceId: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string(),
    startsAt: isoDateTimeSchema,
    deferredOrderCount: z.number().int().min(0),
    capturedOrderCount: z.number().int().min(0),
  })
  .strict();

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const reconcileSeriesScheduleInputSchemaBase = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    windowStart: isoDateTimeSchema,
    windowEnd: isoDateTimeSchema,
    maxOccurrences: z.number().int().min(1).max(500).optional(),
    confirmedCancellations: z.array(z.uuid()).max(500).optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const reconcileSeriesScheduleInputSchema =
  reconcileSeriesScheduleInputSchemaBase.superRefine((value, ctx) => {
    if (
      new Date(value.windowStart).getTime() >
      new Date(value.windowEnd).getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "window_end_before_start",
      });
    }
  });

export const reconcileSeriesScheduleResultSchema = z
  .object({
    seriesId: z.uuid(),
    planned: z
      .object({
        added: z.number().int().min(0),
        removed: z.number().int().min(0),
      })
      .strict(),
    generated: z
      .object({
        detached: z.number().int().min(0),
        kept: z.number().int().min(0),
      })
      .strict(),
    published: z
      .object({
        detached: z.number().int().min(0),
        kept: z.number().int().min(0),
        pendingConfirmation: z.array(pendingConfirmationItemSchema).max(500),
      })
      .strict(),
  })
  .strict();

// ── Convert Event To Series ─────────────────────────────────────────────────

export const convertEventToSeriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /** Series name. Defaults to the event title when omitted. */
    name: plainTextRequired(120).optional(),
    schedule: scheduleSchema,
    clientKey: z.string().min(8),
  })
  .strict();

export const convertEventToSeriesResultSchema = z
  .object({
    seriesId: z.uuid(),
    occurrenceId: z.uuid(),
  })
  .strict();

export type ConvertEventToSeriesInput = z.infer<
  typeof convertEventToSeriesInputSchema
>;
export type ConvertEventToSeriesResult = z.infer<
  typeof convertEventToSeriesResultSchema
>;

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const generateEventsFromSeriesInputSchemaBase = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    occurrenceIds: z.array(z.uuid()).max(500).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const generateEventsFromSeriesInputSchema =
  generateEventsFromSeriesInputSchemaBase.superRefine((value, ctx) => {
    if (
      (!value.occurrenceIds || value.occurrenceIds.length === 0) &&
      !value.limit
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["occurrenceIds"],
        message: "occurrence_ids_or_limit_required",
      });
    }
  });

export const generateEventsFromSeriesResultSchema = z
  .object({
    generated: z
      .array(
        z
          .object({
            occurrenceId: z.uuid(),
            eventId: z.uuid(),
            /**
             * How many of this draft's copied ticket types had an
             * ALREADY-ELAPSED scheduled price change nulled (Q-005). Generating
             * February dates from a source whose early-bird deadline was in
             * January would otherwise hand every occurrence a schedule that
             * fires the moment it publishes. 0 for the overwhelming majority.
             */
            scheduledPricesDropped: z.number().int().nonnegative(),
            /**
             * CAVEAT, because a 0 here is easy to misread: this counts
             * ALREADY-ELAPSED schedules, measured against GENERATE time — not
             * against the occurrence's own date. A future-but-stale flip
             * instant copies silently and is not counted. `0` means "nothing
             * had already fired", never "the schedules suit these dates".
             */
            /**
             * How many of this draft's copied ticket types had an
             * ALREADY-CLOSED sales window nulled (FR-014). Same convention and
             * same reason as `scheduledPricesDropped`: `salesCloseAt` is an
             * absolute instant, so a February occurrence generated from a
             * source whose advance tier closed in January would be born with a
             * tier nobody can buy. 0 for the overwhelming majority.
             */
            salesWindowsDropped: z.number().int().nonnegative(),
            /**
             * SAME CAVEAT as `scheduledPricesDropped`: already-CLOSED windows
             * only, measured against generate time. An advance window closing
             * 2026-09-01 copied onto a December occurrence is stale but NOT
             * counted here. The stricter "closes before the occurrence starts"
             * rule is deliberately not used — it would null every advance tier.
             * See the guard in generate-events-from-series.ts.
             */
          })
          .strict(),
      )
      .max(500),
    skipped: z.array(z.uuid()).max(500),
  })
  .strict();

// ── Sync Series Drafts (propagate pivot-event edits to sibling drafts) ──────

export const syncSeriesDraftsScopeSchema = z.enum(["future", "all"]);

export const syncSeriesDraftsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    /** The just-saved pivot event whose definition is propagated. */
    sourceEventId: z.uuid(),
    scope: syncSeriesDraftsScopeSchema,
    clientKey: z.string().min(8),
    /**
     * arrival-areas FR-015, owner Q13 (2026-10-17): "Also replace parking and
     * drop-off areas on these shows", unticked by default. False leaves each
     * sibling draft's own event-only areas and hides exactly as they are
     * (the FR-014 switch-off for a moved draft still runs); true makes them
     * the source's.
     */
    includeArrivalAreas: z.boolean().default(false),
  })
  .strict();

/**
 * Counter semantics (see syncSeriesDrafts docstring for the full table):
 * - `updatedDraftCount`      — GENERATED-occurrence drafts overwritten.
 * - `skippedPublishedCount`  — dates left alone because they moved past
 *   draft: PUBLISHED occurrences (future-only under scope "future"; all under
 *   scope "all") PLUS targets whose event was published/archived/cancelled
 *   out-of-band (or whose row is gone) at write time — one folded bucket.
 * - `skippedPastCount`       — scope "future" only: GENERATED drafts whose
 *   EVENT startsAt is not strictly after now (targets are classified by the
 *   linked event's date; published dates use the occurrence's date).
 * The source event's own occurrence is never counted anywhere.
 */
export const syncSeriesDraftsResultSchema = z
  .object({
    updatedDraftCount: z.number().int().min(0),
    skippedPublishedCount: z.number().int().min(0),
    skippedPastCount: z.number().int().min(0),
  })
  .strict();

export type SyncSeriesDraftsScope = z.infer<typeof syncSeriesDraftsScopeSchema>;
export type SyncSeriesDraftsInput = z.infer<typeof syncSeriesDraftsInputSchema>;
export type SyncSeriesDraftsResult = z.infer<
  typeof syncSeriesDraftsResultSchema
>;

export const resyncDraftFromSeriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    occurrenceId: z.uuid(),
    mode: resyncModeSchema,
    clientKey: z.string().min(8),
  })
  .strict();

export const resyncDraftFromSeriesResultSchema = z
  .object({
    eventId: z.uuid(),
    appliedFields: z.array(z.string().trim().min(1)).max(200),
  })
  .strict();

export const listSeriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    activeOnly: z.boolean().optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
    cursor: cursorSchema.optional(),
  })
  .strict();

export const listSeriesResultSchema = z
  .object({
    items: z.array(eventSeriesDtoSchema),
    nextCursor: cursorSchema.optional(),
  })
  .strict();

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const listOccurrencesInputSchemaBase = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    range: z
      .object({
        start: isoDateTimeSchema,
        end: isoDateTimeSchema,
      })
      .strict()
      .optional(),
    status: z.array(occurrenceStatusSchema).min(1).max(5).optional(),
    limit: z.number().int().min(1).max(200).default(50).optional(),
    cursor: cursorSchema.optional(),
  })
  .strict();

export const listOccurrencesInputSchema =
  listOccurrencesInputSchemaBase.superRefine((value, ctx) => {
    if (value.range) {
      if (
        new Date(value.range.start).getTime() >
        new Date(value.range.end).getTime()
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["range", "end"],
          message: "range_end_before_start",
        });
      }
    }
  });

export const listOccurrencesResultSchema = z
  .object({
    items: z.array(eventSeriesOccurrenceDtoSchema),
    nextCursor: cursorSchema.optional(),
  })
  .strict();

// ── Public series dates (buyer-facing date switcher) ───────────────────────
export const listPublicSeriesDatesInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const publicSeriesDateSchema = z
  .object({
    occurrenceId: z.uuid(),
    eventId: z.uuid(),
    slug: z.string().min(1),
    title: z.string().min(1),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    timezone: z.string().min(1),
    isCurrent: z.boolean(),
  })
  .strict();

export const listPublicSeriesDatesResultSchema = z
  .object({
    seriesId: z.uuid().nullable(),
    seriesName: z.string().nullable(),
    dates: z.array(publicSeriesDateSchema),
  })
  .strict();

export type OwnerScope = z.infer<typeof ownerScopeSchema>;
export type SeriesSchedule = z.infer<typeof scheduleSchema>;
export type SeriesDefaults = z.infer<typeof seriesDefaultsSchema>;
export type SeriesDTO = z.infer<typeof eventSeriesDtoSchema>;
export type SeriesOccurrenceDTO = z.infer<
  typeof eventSeriesOccurrenceDtoSchema
>;
export type CreateEventSeriesInput = z.infer<
  typeof createEventSeriesInputSchema
>;
export type CreateEventSeriesResult = z.infer<
  typeof createEventSeriesResultSchema
>;
export type UpdateEventSeriesInput = z.infer<
  typeof updateEventSeriesInputSchema
>;
export type UpdateEventSeriesResult = z.infer<
  typeof updateEventSeriesResultSchema
>;
export type ArchiveEventSeriesInput = z.infer<
  typeof archiveEventSeriesInputSchema
>;
export type ArchiveEventSeriesResult = z.infer<
  typeof archiveEventSeriesResultSchema
>;
export type ExpandSeriesInput = z.infer<typeof expandSeriesInputSchema>;
export type ExpandSeriesResult = z.infer<typeof expandSeriesResultSchema>;
export type GenerateEventsFromSeriesInput = z.infer<
  typeof generateEventsFromSeriesInputSchema
>;
export type GenerateEventsFromSeriesResult = z.infer<
  typeof generateEventsFromSeriesResultSchema
>;
export type ResyncDraftFromSeriesInput = z.infer<
  typeof resyncDraftFromSeriesInputSchema
>;
export type ResyncDraftFromSeriesResult = z.infer<
  typeof resyncDraftFromSeriesResultSchema
>;
export type ListSeriesInput = z.infer<typeof listSeriesInputSchema>;
export type ListSeriesResult = z.infer<typeof listSeriesResultSchema>;
export type ListOccurrencesInput = z.infer<typeof listOccurrencesInputSchema>;
export type ListOccurrencesResult = z.infer<typeof listOccurrencesResultSchema>;
export type ListPublicSeriesDatesInput = z.infer<
  typeof listPublicSeriesDatesInputSchema
>;
export type PublicSeriesDate = z.infer<typeof publicSeriesDateSchema>;
export type ListPublicSeriesDatesResult = z.infer<
  typeof listPublicSeriesDatesResultSchema
>;
export type ReconcileSeriesScheduleInput = z.infer<
  typeof reconcileSeriesScheduleInputSchema
>;
export type ReconcileSeriesScheduleResult = z.infer<
  typeof reconcileSeriesScheduleResultSchema
>;

// ── Cancel Event Series ─────────────────────────────────────────────────────

export const cancelEventSeriesScopeSchema = z.enum([
  "this_only",
  "this_and_future",
  "all",
]);

export const cancelEventSeriesInputSchema = z.object({
  actorHumanId: z.uuid(),
  seriesId: z.uuid(),
  occurrenceId: z.uuid(),
  scope: cancelEventSeriesScopeSchema,
  clientKey: z.string().min(8),
});

export const cancelEventSeriesResultSchema = z.object({
  seriesId: z.string(),
  scope: cancelEventSeriesScopeSchema,
  cancelledCount: z.number().int().nonnegative(),
  refundedEventCount: z.number().int().nonnegative(),
  failedEventCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  seriesArchived: z.boolean(),
});

export type CancelEventSeriesScope = z.infer<
  typeof cancelEventSeriesScopeSchema
>;
export type CancelEventSeriesInput = z.infer<
  typeof cancelEventSeriesInputSchema
>;
export type CancelEventSeriesResult = z.infer<
  typeof cancelEventSeriesResultSchema
>;

// ── Dates page: skip / restore occurrence ───────────────────────────────────

export const skipOccurrenceInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    occurrenceId: z.uuid(),
    note: plainTextOptional(200).optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const skipOccurrenceResultSchema = z
  .object({
    occurrenceId: z.uuid(),
    status: z.literal("SKIPPED"),
  })
  .strict();

export const restoreOccurrenceInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    occurrenceId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const restoreOccurrenceResultSchema = z
  .object({
    occurrenceId: z.uuid(),
    status: z.literal("PLANNED"),
  })
  .strict();

export type SkipOccurrenceInput = z.infer<typeof skipOccurrenceInputSchema>;
export type SkipOccurrenceResult = z.infer<typeof skipOccurrenceResultSchema>;
export type RestoreOccurrenceInput = z.infer<
  typeof restoreOccurrenceInputSchema
>;
export type RestoreOccurrenceResult = z.infer<
  typeof restoreOccurrenceResultSchema
>;

// ── Dates page: add a manual one-off date ───────────────────────────────────

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const addSeriesOccurrenceInputSchemaBase = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema.optional(),
    note: plainTextOptional(200).optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const addSeriesOccurrenceInputSchema =
  addSeriesOccurrenceInputSchemaBase.superRefine((value, ctx) => {
    if (
      value.endsAt &&
      Date.parse(value.endsAt) <= Date.parse(value.startsAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "ends_before_start",
      });
    }
  });

export const addSeriesOccurrenceResultSchema = z
  .object({
    occurrenceId: z.uuid(),
  })
  .strict();

export type AddSeriesOccurrenceInput = z.infer<
  typeof addSeriesOccurrenceInputSchema
>;
export type AddSeriesOccurrenceResult = z.infer<
  typeof addSeriesOccurrenceResultSchema
>;

// ── Dates page: admin list (occurrence + linked-event summary) ──────────────

export const listSeriesDatesForAdminInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  })
  .strict();

const seriesDateAdminEventSchema = z
  .object({
    eventId: z.uuid(),
    title: z.string(),
    slug: z.string().nullable(),
    status: z.enum([
      "DRAFT",
      "PUBLISHED",
      "ARCHIVED",
      "CANCELLED",
      "COMPLETED",
    ]),
    ticketTypeCount: z.number().int().min(0),
    soldCount: z.number().int().min(0),
  })
  .strict();

const seriesDateAdminRowSchema = z
  .object({
    occurrenceId: z.uuid(),
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    status: occurrenceStatusSchema,
    manual: z.boolean(),
    skipNote: z.string().nullable(),
    note: z.string().nullable(),
    /** Null when no event is linked (or the linked event row is gone). */
    event: seriesDateAdminEventSchema.nullable(),
  })
  .strict();

export const listSeriesDatesForAdminResultSchema = z
  .object({
    series: z
      .object({
        seriesId: z.uuid(),
        name: z.string(),
        timezone: z.string(),
        schedule: z
          .object({
            kind: scheduleKindSchema,
            rrule: z.string().nullable(),
            until: z.string().nullable(),
          })
          .strict(),
        totalCount: z.number().int().min(0),
      })
      .strict(),
    items: z.array(seriesDateAdminRowSchema),
    nextCursor: cursorSchema.optional(),
  })
  .strict();

export type ListSeriesDatesForAdminInput = z.infer<
  typeof listSeriesDatesForAdminInputSchema
>;
export type SeriesDateAdminRow = z.infer<typeof seriesDateAdminRowSchema>;
export type ListSeriesDatesForAdminResult = z.infer<
  typeof listSeriesDatesForAdminResultSchema
>;
