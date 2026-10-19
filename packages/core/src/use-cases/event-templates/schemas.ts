import { z } from "zod";

import { redactedFreeformDraftLocationSchema } from "../../lib/location/redact-draft-location";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";

const ownerScopeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

const templateLocationSchema = z.discriminatedUnion("kind", [
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

const visibilitySchema = z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]);

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

const ticketTypeStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

const ticketTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    priceCents: z.number().int().min(0),
    capacity: z.number().int().min(0),
    seatSectionId: z.uuid().nullable().optional(),
    status: ticketTypeStatusSchema.default("ACTIVE").optional(),
  })
  .strict();

const mediaSchema = z
  .object({
    bannerUrl: z.string().url().optional(),
    gallery: z.array(z.string().url()).max(20).optional(),
  })
  .strict();

const embedSchema = z
  .object({
    allowResale: z.boolean().optional(),
    showFees: z.boolean().optional(),
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

const templateDefaultsSchema = z
  .object({
    title: plainTextRequired(140).optional(),
    doorTimeMinsBefore: z.number().int().min(0).max(600).optional(),
    visibility: visibilitySchema.optional(),
    location: templateLocationSchema.optional(),
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
          if (names.has(ticketType.name.toLowerCase())) {
            ctx.addIssue({
              code: "custom",
              message: "ticket type names must be unique",
            });
            break;
          }
          names.add(ticketType.name.toLowerCase());
        }
      }),
    media: mediaSchema.optional(),
    embed: embedSchema.optional(),
  })
  .strict();

const templateOverridesSchema = templateDefaultsSchema.partial();

/**
 * The defaults as a READ returns them: the input shape, except that a
 * freeform location may come back REDACTED (`{ kind, label }`, no street or
 * coordinates) for a reader below the edit roles — see
 * `lib/location/redact-draft-location` (place-address-withholding N4).
 */
const templateDefaultsOutputSchema = templateDefaultsSchema
  .extend({
    location: z
      .union([templateLocationSchema, redactedFreeformDraftLocationSchema])
      .optional(),
  })
  .strict();

const eventTemplateDtoSchema = z
  .object({
    id: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280).nullable().optional(),
    active: z.boolean(),
    defaults: templateDefaultsOutputSchema.optional(),
    createdBy: z.uuid(),
    createdAt: z.date(),
    updatedAt: z.date(),
    archivedAt: z.date().nullable().optional(),
  })
  .strict();

const cursorSchema = z.string().min(1).max(256);

export const createEventTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: plainTextRequired(80),
    description: plainTextMultilineOptional(280).optional(),
    defaults: templateDefaultsSchema.optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const createEventTemplateResultSchema = z
  .object({
    templateId: z.uuid(),
  })
  .strict();

export const updateEventTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    templateId: z.uuid(),
    patch: z
      .object({
        name: plainTextRequired(80).optional(),
        description: plainTextMultilineOptional(280).nullable().optional(),
        defaults: templateDefaultsSchema.optional(),
        active: z.boolean().optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0, {
        message: "patch must include at least one field",
      }),
    clientKey: z.string().min(8),
  })
  .strict();

export const updateEventTemplateResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const archiveEventTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    templateId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const archiveEventTemplateResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const listEventTemplatesInputSchema = z
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

export const listEventTemplatesResultSchema = z
  .object({
    items: z.array(eventTemplateDtoSchema),
    nextCursor: cursorSchema.optional(),
  })
  .strict();

export const applyTemplateToEventDraftInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    templateId: z.uuid(),
    eventId: z.uuid(),
    overrides: templateOverridesSchema.optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const applyTemplateToEventDraftResultSchema = z
  .object({
    eventId: z.uuid(),
    appliedFields: z.array(z.string().trim().min(1)).max(200),
  })
  .strict();

export const eventTemplateDtoArraySchema = z.array(eventTemplateDtoSchema);

export type OwnerScope = z.infer<typeof ownerScopeSchema>;
export type TemplateDefaults = z.infer<typeof templateDefaultsSchema>;
export type TemplateOverrides = z.infer<typeof templateOverridesSchema>;
export type EventTemplateDTO = z.infer<typeof eventTemplateDtoSchema>;
export type CreateEventTemplateInput = z.infer<
  typeof createEventTemplateInputSchema
>;
export type CreateEventTemplateResult = z.infer<
  typeof createEventTemplateResultSchema
>;
export type UpdateEventTemplateInput = z.infer<
  typeof updateEventTemplateInputSchema
>;
export type UpdateEventTemplateResult = z.infer<
  typeof updateEventTemplateResultSchema
>;
export type ArchiveEventTemplateInput = z.infer<
  typeof archiveEventTemplateInputSchema
>;
export type ArchiveEventTemplateResult = z.infer<
  typeof archiveEventTemplateResultSchema
>;
export type ListEventTemplatesInput = z.infer<
  typeof listEventTemplatesInputSchema
>;
export type ListEventTemplatesResult = z.infer<
  typeof listEventTemplatesResultSchema
>;
export type ApplyTemplateToEventDraftInput = z.infer<
  typeof applyTemplateToEventDraftInputSchema
>;
export type ApplyTemplateToEventDraftResult = z.infer<
  typeof applyTemplateToEventDraftResultSchema
>;
