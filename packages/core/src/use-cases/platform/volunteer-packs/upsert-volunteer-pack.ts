import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { RoleTemplateRecord } from "@th/ports/repos/volunteering";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import { requirePlatformStaff } from "../../../lib/rbac";
import {
  MAX_PACK_ROLES,
  targetCategoryIdsSchema,
  volunteerPackKeySchema,
  volunteerPackRoleInputSchema,
  volunteerPackWithRolesSchema,
  type VolunteerPackRoleInput,
} from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kept a plain (if `.strict()`) object so the transport can `.omit()` the
 * server-injected actor id — zod refuses `.omit()` on a refined schema. The
 * cross-field rule lives on {@link upsertVolunteerPackInputSchema} below,
 * which is what the use case parses with, so the check still runs server-side
 * whatever the transport hands it. Same split as
 * `createVolunteerAskInputSchemaBase`.
 */
export const upsertVolunteerPackInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    /** The upsert key. Present + known = edit; present + unknown = create. */
    key: volunteerPackKeySchema,
    name: plainTextRequired(120),
    blurb: plainTextMultilineOptional(2000).nullish(),
    /**
     * Absent on create = DRAFT (the schema default). Publishing is a separate,
     * separately-audited action — see `setVolunteerPackStatus`. Accepting it
     * here too would make "save" and "publish" the same click.
     */
    targetCategoryIds: targetCategoryIdsSchema.optional(),
    rankFirst: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    /**
     * Replace-set of the pack's catalogue roles, matched by name.
     * OMITTED = roles untouched (metadata-only edit). `[]` = delete them all.
     */
    roles: z.array(volunteerPackRoleInputSchema).max(MAX_PACK_ROLES).optional(),
  })
  .strict();

export const upsertVolunteerPackInputSchema =
  upsertVolunteerPackInputSchemaBase.refine(
    (d) =>
      d.roles === undefined ||
      new Set(d.roles.map((r) => r.name.trim().toLowerCase())).size ===
        d.roles.length,
    {
      // Mirrors the partial unique index
      // `VolunteerRoleTemplate_platform_pack_name_key`: one pack cannot list
      // two roles named "Door". Caught here so the staff editor gets a field
      // error rather than a raw constraint violation.
      message: "role names must be unique within a pack",
      path: ["roles"],
    },
  );

export const upsertVolunteerPackOutputSchema = z
  .object({ pack: volunteerPackWithRolesSchema })
  .strict();

export type UpsertVolunteerPackInput = z.infer<
  typeof upsertVolunteerPackInputSchema
>;
export type UpsertVolunteerPackOutput = z.infer<
  typeof upsertVolunteerPackOutputSchema
>;

export type UpsertVolunteerPackDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Role diff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile a pack's catalogue roles against the payload, matched by name
 * (case-insensitively — the same comparison every template name check in this
 * codebase uses).
 *
 * Matching by name rather than wiping and recreating is what keeps role IDs
 * stable across an edit: `EventVolunteerRole.templateId` points at them, and
 * churning the ids would sever every event's link to the catalogue role it was
 * created from for the sake of a description typo.
 */
async function reconcilePackRoles(
  tx: TxRepos,
  packId: string,
  existing: RoleTemplateRecord[],
  desired: VolunteerPackRoleInput[],
): Promise<{ created: number; updated: number; deleted: number }> {
  const byName = new Map(
    existing.map((row) => [row.name.trim().toLowerCase(), row] as const),
  );

  let created = 0;
  let updated = 0;

  for (const [index, role] of desired.entries()) {
    const match = byName.get(role.name.trim().toLowerCase());
    const sortOrder = role.sortOrder ?? index;

    let templateId: string;
    if (match) {
      // ID-SCOPED update. Safe here because `existing` came from
      // `getPackWithRoles`, whose role selection pins `isPlatform: true` —
      // an org's fork carrying the same packId is never in this list.
      await tx.volunteering.updateRoleTemplate(match.id, {
        name: role.name,
        description: role.description ?? null,
        defaultCapacity: role.defaultCapacity ?? null,
        sortOrder,
      });
      templateId = match.id;
      byName.delete(role.name.trim().toLowerCase());
      updated += 1;
    } else {
      const row = await tx.volunteering.createPlatformRoleTemplate({
        packId,
        name: role.name,
        description: role.description ?? null,
        defaultCapacity: role.defaultCapacity ?? null,
        sortOrder,
      });
      templateId = row.id;
      created += 1;
    }

    if (role.shifts !== undefined) {
      // Replace-set, same as the org editor. Anchor fields ride along — a
      // catalogue preset is the main reason they exist.
      await tx.volunteering.upsertRoleTemplateShifts(
        templateId,
        role.shifts.map((shift, position) => ({
          label: shift.label,
          startMinuteOfDay: shift.startMinuteOfDay,
          endMinuteOfDay: shift.endMinuteOfDay,
          startDayOffset: shift.startDayOffset ?? 0,
          endsNextDay:
            shift.endsNextDay ?? shift.endMinuteOfDay < shift.startMinuteOfDay,
          capacity: shift.capacity ?? null,
          position: shift.position ?? position,
          anchor: shift.anchor ?? "WALL_CLOCK",
          offsetMinutes:
            (shift.anchor ?? "WALL_CLOCK") === "WALL_CLOCK"
              ? 0
              : (shift.offsetMinutes ?? 0),
          notes: shift.notes ?? null,
        })),
      );
    }
  }

  // Whatever the payload no longer names is removed. PLATFORM-ONLY delete:
  // the repo pins `isPlatform: true`, so org forks are untouchable from here.
  const staleIds = [...byName.values()].map((row) => row.id);
  const deleted = await tx.volunteering.deletePlatformRoleTemplates(staleIds);

  return { created, updated, deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or edit a volunteer pack and, optionally, its catalogue roles and
 * shift presets (FR-014). Mirrors `upsertFeaturedItem`.
 *
 * A pack is created DRAFT and stays at whatever status it already has —
 * publishing is `setVolunteerPackStatus`, so "save my typo fix" can never
 * ship an unfinished pack to every organizer, and the two get separate audit
 * rows.
 *
 * Roles are reconciled BY NAME (see `reconcilePackRoles`), which is also the
 * identity an org's fork carries as provenance. Omitting `roles` entirely
 * leaves them alone; passing `[]` empties the pack.
 *
 * Auth: STAFF_TECH (ADMIN + DEVELOPER). Writes one AuditLog row per call
 * (FR-015) naming the actor, inside the same transaction as the write.
 */
export async function upsertVolunteerPack(
  deps: UpsertVolunteerPackDeps,
  rawInput: unknown,
): Promise<UpsertVolunteerPackOutput> {
  const input = parseInput(upsertVolunteerPackInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const pack = await deps.repos.tx(async (tx) => {
    const prior = await tx.volunteering.getPackByKey(input.key);

    const packRow = prior
      ? await tx.volunteering.updatePack(prior.id, {
          name: input.name,
          // OMITTED = untouched, same as its neighbours below. Unconditional
          // `input.blurb ?? null` here meant a metadata-only edit
          // (`{ key, name }` — the staff editor's typo fix) NULLed a
          // staff-authored blurb with no confirmation and no old value in the
          // audit row. `null` still clears it explicitly: the field is
          // `.nullish()`, so the two cases are distinguishable.
          ...(input.blurb !== undefined && { blurb: input.blurb ?? null }),
          ...(input.targetCategoryIds !== undefined && {
            targetCategoryIds: input.targetCategoryIds,
          }),
          ...(input.rankFirst !== undefined && { rankFirst: input.rankFirst }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          curatedByHumanId: input.actorHumanId,
        })
      : await tx.volunteering.createPack({
          key: input.key,
          name: input.name,
          blurb: input.blurb ?? null,
          // New packs are DRAFT. Publishing is a separate, audited action.
          status: "DRAFT",
          targetCategoryIds: input.targetCategoryIds ?? [],
          rankFirst: input.rankFirst ?? false,
          sortOrder: input.sortOrder ?? 0,
          curatedByHumanId: input.actorHumanId,
        });

    let roleDiff: { created: number; updated: number; deleted: number } | null =
      null;
    if (input.roles !== undefined) {
      const current = await tx.volunteering.getPackWithRoles(packRow.id);
      roleDiff = await reconcilePackRoles(
        tx,
        packRow.id,
        current?.roles ?? [],
        input.roles,
      );
    }

    await tx.audit.log({
      entity: "volunteer_pack",
      entityId: packRow.id,
      action: prior ? "volunteer_pack.updated" : "volunteer_pack.created",
      data: {
        actorHumanId: input.actorHumanId,
        key: packRow.key,
        name: packRow.name,
        status: packRow.status,
        ...(roleDiff ? { roles: roleDiff } : {}),
      },
      at: deps.clock.now(),
    });

    const fresh = await tx.volunteering.getPackWithRoles(packRow.id);
    if (!fresh) {
      // Unreachable: written in this transaction.
      throw fail("VOLUNTEER_PACK_NOT_FOUND");
    }
    return fresh;
  });

  deps.logger?.info("upsertVolunteerPack.completed", {
    packId: pack.id,
    key: pack.key,
    roleCount: pack.roles.length,
  });

  return upsertVolunteerPackOutputSchema.parse({ pack });
}
