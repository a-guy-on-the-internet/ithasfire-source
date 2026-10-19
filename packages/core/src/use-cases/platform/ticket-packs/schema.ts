import { z } from "zod";

import { plainTextRequired } from "../../../lib/sanitize-plain-text";
import {
  ticketPackSummarySchema,
  ticketTypeTemplateDtoSchema,
  ticketTypeTemplateEntriesSchema,
} from "../../ticket-type-templates/schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Ticket packs — shared schemas
//
// Staff-curated catalogue content (ticket-type-packs spec FR-012). Everything
// here is STAFF_TECH-gated at the use case; nothing in this file is
// owner-scoped. Mirrors platform/volunteer-packs/schema.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const ticketPackStatusSchema = z.enum(["DRAFT", "LIVE"]);

/**
 * Stable slug. Lowercase kebab so the seed path (FR-013) can key on it in
 * source and converge across dev / staging / prod, and so a re-seed updates
 * rather than duplicates.
 */
export const ticketPackKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "key must be lowercase kebab-case (a-z, 0-9, single hyphens)",
  );

export const MAX_PACK_TEMPLATES = 20;

/**
 * One catalogue template in a pack payload. Deliberately has no `id`:
 * templates are matched by NAME within the pack — exactly the identity the
 * partial unique index `TicketTypeTemplate_platform_pack_name_key` enforces
 * and the identity an owner's fork carries as provenance. Renaming a
 * template in the staff editor therefore reads as delete + create, which is
 * honest — an owner who forked the old name keeps their copy and stops
 * being shadowed by a template that no longer exists under that name.
 *
 * Entries go through the SAME zod schema the org flow uses (FR-012 — a
 * catalogue entry is always one an organizer could have typed).
 */
export const ticketPackTemplateInputSchema = z
  .object({
    // Staff-authored free text rendered to organizers — sanitized on input
    // (NFR-005), escaped at the sink.
    name: plainTextRequired(80),
    ticketTypes: ticketTypeTemplateEntriesSchema,
  })
  .strict();

// ── Output record schemas ───────────────────────────────────────────────────

export const ticketPackRecordSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string(),
    name: z.string(),
    blurb: z.string().nullable(),
    status: ticketPackStatusSchema,
    sortOrder: z.number().int(),
    curatedByHumanId: z.string().uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const ticketPackWithCountsSchema = ticketPackRecordSchema
  .extend({
    templateCount: z.number().int().min(0),
    entryCount: z.number().int().min(0),
    forkCount: z.number().int().min(0),
  })
  .strict();

/**
 * Full RECORD shape (archivedAt included) — the staff editor round-trips
 * repo records, unlike the organizer-facing DTO which strips it. Mirrors
 * `platformRoleTemplateSchema` carrying `archived`.
 */
export const platformTicketTemplateSchema = ticketTypeTemplateDtoSchema
  .extend({ archivedAt: z.date().nullable() })
  .strict();

export const ticketPackWithTemplatesSchema = ticketPackRecordSchema
  .extend({ templates: z.array(platformTicketTemplateSchema) })
  .strict();

export type TicketPackTemplateInput = z.infer<
  typeof ticketPackTemplateInputSchema
>;
export { ticketPackSummarySchema };
