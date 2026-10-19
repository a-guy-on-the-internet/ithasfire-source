import { z } from "zod";

import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import {
  roleTemplateShiftDraftSchema,
  volunteerShiftAnchorSchema,
} from "../../volunteering/schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Volunteer packs — shared schemas
//
// Staff-curated catalogue content (FR-014 … FR-016). Everything here is
// STAFF_TECH-gated at the use case; nothing in this file is org-scoped.
// ─────────────────────────────────────────────────────────────────────────────

export const volunteerPackStatusSchema = z.enum(["DRAFT", "LIVE"]);

/**
 * Stable slug. Lowercase kebab so the seed path (FR-018) can key on it in
 * source and converge across dev / staging / prod, and so a re-seed updates
 * rather than duplicates.
 */
export const volunteerPackKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "key must be lowercase kebab-case (a-z, 0-9, single hyphens)",
  );

/** Ranking hints only — no FK, so a deleted category degrades ranking. */
const targetCategoryIdsSchema = z.array(z.string().uuid()).max(20);

export const MAX_PACK_ROLES = 50;

/**
 * One catalogue role in a pack payload. Deliberately has no `id`: roles are
 * matched by NAME within the pack, which is exactly the identity the partial
 * unique index `VolunteerRoleTemplate_platform_pack_name_key` enforces and
 * the identity an org's fork carries as provenance. Renaming a role in the
 * staff editor therefore reads as delete + create, which is honest — an org
 * that forked the old name keeps their copy and stops being shadowed by a
 * role that no longer exists under that name.
 */
export const volunteerPackRoleInputSchema = z.object({
  name: plainTextRequired(120),
  description: plainTextMultilineOptional(2000).nullish(),
  defaultCapacity: z.number().int().min(1).nullish(),
  sortOrder: z.number().int().min(0).optional(),
  /** Omitted = no shifts (the standing-crew shape). `[]` clears them. */
  shifts: z.array(roleTemplateShiftDraftSchema).max(25).optional(),
});

// ── Output record schemas ───────────────────────────────────────────────────

export const volunteerPackRecordSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string(),
    name: z.string(),
    blurb: z.string().nullable(),
    status: volunteerPackStatusSchema,
    targetCategoryIds: z.array(z.string()),
    rankFirst: z.boolean(),
    sortOrder: z.number().int(),
    curatedByHumanId: z.string().uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const volunteerPackWithCountsSchema = volunteerPackRecordSchema
  .extend({
    roleCount: z.number().int().min(0),
    forkCount: z.number().int().min(0),
  })
  .strict();

export const platformRoleTemplateShiftSchema = z
  .object({
    id: z.string().uuid(),
    templateId: z.string().uuid(),
    label: z.string(),
    startMinuteOfDay: z.number().int(),
    endMinuteOfDay: z.number().int(),
    startDayOffset: z.number().int(),
    endsNextDay: z.boolean(),
    capacity: z.number().int().nullable(),
    position: z.number().int(),
    anchor: volunteerShiftAnchorSchema,
    offsetMinutes: z.number().int(),
    notes: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const platformRoleTemplateSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    defaultCapacity: z.number().int().nullable(),
    sortOrder: z.number().int(),
    archived: z.boolean(),
    isPlatform: z.boolean(),
    packId: z.string().uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    shifts: z.array(platformRoleTemplateShiftSchema),
  })
  .strict();

export const volunteerPackWithRolesSchema = volunteerPackRecordSchema
  .extend({ roles: z.array(platformRoleTemplateSchema) })
  .strict();

export type VolunteerPackRoleInput = z.infer<
  typeof volunteerPackRoleInputSchema
>;
export { targetCategoryIdsSchema };
