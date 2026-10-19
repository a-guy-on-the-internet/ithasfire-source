import { z } from "zod";

import {
  MAX_DONATION_AMOUNT_CENTS,
  PWYW_SETTING_ABOVE_CAP_MESSAGE,
} from "../../lib/pricing/pay-what-you-want";

import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { MAX_TEMPLATE_OFFSET_MINUTES } from "../../lib/ticket-types/template-relative-schedule";

const ownerScopeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

/**
 * The FR-015 relative encoding: `{ anchor, offsetMinutes }`, signed, negative =
 * before. Mirrors `VolunteerRoleTemplateShift`'s anchor + offset pair; see
 * `lib/ticket-types/template-relative-schedule.ts` for why there is no doors
 * anchor and why the offset is elapsed rather than calendar time.
 *
 * The bound comes from that module so the schema and the resolver cannot drift.
 */
const relativeInstantSchema = z
  .object({
    anchor: z.enum(["EVENT_START", "EVENT_PUBLISH"]),
    offsetMinutes: z
      .number()
      .int()
      .min(-MAX_TEMPLATE_OFFSET_MINUTES)
      .max(MAX_TEMPLATE_OFFSET_MINUTES),
  })
  .strict();

/**
 * One saved ticket-type configuration. Mirrors upsertTicketTypeInputSchema's
 * fields, deliberately excluding the event-specific `seatSectionId` — it
 * would dangle when applied to a different event.
 *
 * `.strict()` is for WRITES. Stored templates are read through
 * {@link ticketTypeTemplateStoredEntrySchema}, which strips keys this schema no
 * longer declares instead of rejecting the whole template.
 */
export const ticketTypeTemplateEntrySchema = z
  .object({
    name: plainTextRequired(80),
    priceCents: z.number().int().min(0),
    pricingMode: z.enum(["FIXED", "ADJUSTABLE"]).default("FIXED"),
    minimumCents: z.number().int().min(0).nullable().optional().default(null),
    suggestedCents: z.number().int().min(0).nullable().optional().default(null),
    capacity: z.number().int().min(1),
    resaleAllowed: z.boolean().default(false),
    resaleCapCents: z.number().int().min(0).nullable().optional().default(null),
    transferAllowed: z.boolean().default(true),
    /**
     * RELATIVE sales window (FR-015) and relative scheduled price change
     * (FR-011). Never absolute instants — a template is reused across events,
     * so a stored timestamp is meaningless by its second use. Materialized at
     * APPLY time by `materializeTemplateEntrySchedule` (FR-016).
     *
     * All three default to null, so a template stored before 2026-08-12
     * round-trips through this schema unchanged (NFR-001).
     */
    salesOpen: relativeInstantSchema.nullable().optional().default(null),
    salesClose: relativeInstantSchema.nullable().optional().default(null),
    scheduledPriceChange: z
      .object({
        at: relativeInstantSchema,
        // 0 is legitimate — a tier that becomes free at T — hence `.min(0)`
        // and not `.positive()`, matching `upsertTicketTypeInputSchema`.
        priceCents: z.number().int().min(0),
      })
      .strict()
      .nullable()
      .optional()
      .default(null),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // Early rejection of a config upsertTicketType would refuse at apply time.
    if (
      entry.pricingMode === "ADJUSTABLE" &&
      entry.suggestedCents != null &&
      entry.suggestedCents < (entry.minimumCents ?? 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "suggestedCents must be >= minimumCents",
      });
    }

    // Same early-rejection principle: `upsertTicketType` SILENTLY CLEARS a
    // scheduled price on an ADJUSTABLE tier (there is no list price to flip
    // when the buyer names the amount), and unlike every other degradation in
    // this feature that one produces no warning anywhere — it would be the
    // single genuinely silent drop. Refusing the write closes it while the
    // combination is still unreachable, rather than after someone authors it.
    // The WINDOW is deliberately not restricted: a pay-what-you-can tier that
    // only opens at doors-time is coherent, and `upsertTicketType` keeps it.
    if (
      entry.pricingMode === "ADJUSTABLE" &&
      entry.scheduledPriceChange != null
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "scheduledPriceChange is not supported on an ADJUSTABLE ticket type",
      });
    }

    // A window that is inverted NO MATTER WHICH EVENT it lands on is a stored
    // mistake, not an apply-time degradation: when both bounds share an anchor,
    // the anchor cancels and the ordering is decided here and forever. Rejected
    // at the write boundary so the FR-016 warning path never has to spend a
    // warning on something the organizer could have been told about while they
    // were still looking at the form. Mixed anchors genuinely depend on the
    // event and are left to apply time.
    if (
      entry.salesOpen != null &&
      entry.salesClose != null &&
      entry.salesOpen.anchor === entry.salesClose.anchor &&
      entry.salesOpen.offsetMinutes >= entry.salesClose.offsetMinutes
    ) {
      ctx.addIssue({
        code: "custom",
        message: "salesOpen must be before salesClose",
      });
    }
  });

/**
 * One entry as a template is READ BACK from storage (the JSON column). Same
 * fields as {@link ticketTypeTemplateEntrySchema}, but unknown keys are
 * STRIPPED rather than rejected: a field removed from the schema (e.g. the
 * per-type door price, removed by door-sales-same-price-and-tax spec FR-012)
 * stays in rows saved before its removal, and one stale key must not make
 * every template list, fork and pack page that contains the row throw.
 */
export const ticketTypeTemplateStoredEntrySchema =
  ticketTypeTemplateEntrySchema.strip();

/**
 * One entry as a template is WRITTEN (created, or saved as a platform pack):
 * the stored shape plus the checkout cap on a pay-what-you-want minimum and
 * suggestion — a template carrying either above it could never be applied
 * (`upsertTicketType` refuses it). Deliberately NOT on
 * `ticketTypeTemplateEntrySchema`, which also READS stored templates: one
 * saved before the cap must still load (and is refused, by name, at apply).
 */
export const ticketTypeTemplateEntryWriteSchema =
  ticketTypeTemplateEntrySchema.superRefine((entry, ctx) => {
    for (const field of ["minimumCents", "suggestedCents"] as const) {
      const cents = entry[field];
      if (cents != null && cents > MAX_DONATION_AMOUNT_CENTS) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: PWYW_SETTING_ABOVE_CAP_MESSAGE,
        });
      }
    }
  });

export const ticketTypeTemplateEntriesSchema = z
  .array(ticketTypeTemplateEntryWriteSchema)
  .min(1)
  .max(50)
  .superRefine((entries, ctx) => {
    const names = new Set<string>();
    for (const entry of entries) {
      if (names.has(entry.name.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          message: "ticket type names must be unique",
        });
        break;
      }
      names.add(entry.name.toLowerCase());
    }
  });

export const ticketTypeTemplateDtoSchema = z
  .object({
    id: z.uuid(),
    ownerScope: ownerScopeSchema,
    /**
     * Null = platform catalogue row (spec FR-002). Every consumer of this
     * field resolves the null deliberately — no non-null assertions.
     */
    ownerId: z.uuid().nullable(),
    name: z.string().trim().min(1).max(80),
    ticketTypes: z.array(ticketTypeTemplateStoredEntrySchema).min(1),
    /** True only on catalogue rows — read-only to organizers (FR-005). */
    isPlatform: z.boolean(),
    /** Owning pack on a platform row; fork provenance on an owned row. */
    packId: z.uuid().nullable(),
    createdByHumanId: z.uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

/** Pack metadata for grouping the dialog's "From Ithas Fire" section. */
export const ticketPackSummarySchema = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    blurb: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .strict();

export const createTicketTypeTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: plainTextRequired(80),
    ticketTypes: ticketTypeTemplateEntriesSchema,
    clientKey: z.string().min(8),
  })
  .strict();

export const createTicketTypeTemplateResultSchema = z
  .object({
    templateId: z.uuid(),
  })
  .strict();

export const listTicketTypeTemplatesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
  })
  .strict();

export const listTicketTypeTemplatesResultSchema = z
  .object({
    /**
     * The caller's own rows PLUS LIVE platform templates (spec FR-006),
     * with fork shadowing already applied: an owned fork matched on
     * (packId, name) hides its catalogue source.
     */
    items: z.array(ticketTypeTemplateDtoSchema),
    /** LIVE packs referenced by platform items, in curation order. */
    packs: z.array(ticketPackSummarySchema),
  })
  .strict();

export const archiveTicketTypeTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    templateId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const archiveTicketTypeTemplateResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const applyTicketTypeTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    templateId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

/**
 * One entry's relative schedule or window could not be materialized against
 * this event and was dropped (FR-016).
 *
 * PER-ENTRY AND NAMED, not a counter. `generate-events-from-series` reports
 * the same class of drop as
 * `scheduledPricesDropped` / `salesWindowsDropped` totals, which is right for
 * it: it runs over N generated events, nobody is watching a specific tier,
 * and the counter is a "go and look" signal. A template apply is different —
 * one event, a handful of entries, an organizer sitting in front of the dialog
 * who can fix the offending tier immediately. So the entry is named and the
 * reason is machine-readable.
 */
export const applyTicketTypeTemplateWarningSchema = z
  .object({
    /** The template entry's name — the same string that lands in `created`. */
    entryName: z.string(),
    field: z.enum(["salesWindow", "scheduledPrice"]),
    /** Mirrors `TemplateScheduleDropReason` — core owns the vocabulary. */
    reason: z.enum(["already_elapsed", "inverted", "unresolvable"]),
  })
  .strict();

export const applyTicketTypeTemplateResultSchema = z
  .object({
    /** Ticket-type names created on the event by this apply. */
    created: z.array(z.string()),
    /** Names skipped because the event already had a ticket type with them. */
    skipped: z.array(z.string()),
    /**
     * Relative schedules/windows dropped during materialization (FR-016). The
     * ticket type IS created — just without the field that could not resolve —
     * so an entry can appear in both `created` and here.
     *
     * `.optional().default([])` rather than plain-required for ONE reason: the
     * apply path replays a STORED response under its idempotency key
     * (TTL 120s), and a response written by the previous deploy has no
     * `warnings`. Required would make the tRPC `.output()` parse throw on a
     * replay for two minutes after every rollout, turning a harmless shape
     * change into a user-visible error.
     */
    warnings: z
      .array(applyTicketTypeTemplateWarningSchema)
      .optional()
      .default([]),
  })
  .strict();

export const forkPlatformTicketTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    templateId: z.uuid(),
    /** Explicit target name — the TEMPLATE_NAME_TAKEN retry path (FR-009). */
    name: plainTextRequired(80).optional(),
  })
  .strict();

export const forkPlatformTicketTemplateResultSchema = z
  .object({ template: ticketTypeTemplateDtoSchema })
  .strict();

export type TicketTypeTemplateEntryInput = z.infer<
  typeof ticketTypeTemplateEntrySchema
>;
export type ForkPlatformTicketTemplateInput = z.infer<
  typeof forkPlatformTicketTemplateInputSchema
>;
export type ForkPlatformTicketTemplateResult = z.infer<
  typeof forkPlatformTicketTemplateResultSchema
>;
export type TicketTypeTemplateDTO = z.infer<typeof ticketTypeTemplateDtoSchema>;
export type CreateTicketTypeTemplateInput = z.infer<
  typeof createTicketTypeTemplateInputSchema
>;
export type CreateTicketTypeTemplateResult = z.infer<
  typeof createTicketTypeTemplateResultSchema
>;
export type ListTicketTypeTemplatesInput = z.infer<
  typeof listTicketTypeTemplatesInputSchema
>;
export type ListTicketTypeTemplatesResult = z.infer<
  typeof listTicketTypeTemplatesResultSchema
>;
export type ArchiveTicketTypeTemplateInput = z.infer<
  typeof archiveTicketTypeTemplateInputSchema
>;
export type ArchiveTicketTypeTemplateResult = z.infer<
  typeof archiveTicketTypeTemplateResultSchema
>;
export type ApplyTicketTypeTemplateInput = z.infer<
  typeof applyTicketTypeTemplateInputSchema
>;
export type ApplyTicketTypeTemplateResult = z.infer<
  typeof applyTicketTypeTemplateResultSchema
>;
export type ApplyTicketTypeTemplateWarning = z.infer<
  typeof applyTicketTypeTemplateWarningSchema
>;
