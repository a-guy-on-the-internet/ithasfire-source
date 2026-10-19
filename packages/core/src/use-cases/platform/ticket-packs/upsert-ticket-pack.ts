import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { TicketTypeTemplateRecord } from "@th/types";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { plainTextMultilineOptional, plainTextRequired } from "../../../lib/sanitize-plain-text";
import { requirePlatformStaff } from "../../../lib/rbac";
import {
  MAX_PACK_TEMPLATES,
  ticketPackKeySchema,
  ticketPackTemplateInputSchema,
  ticketPackWithTemplatesSchema,
  type TicketPackTemplateInput,
} from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kept a plain (if `.strict()`) object so the transport can `.omit()` the
 * server-injected actor id — zod refuses `.omit()` on a refined schema. The
 * cross-field rule lives on {@link upsertTicketPackInputSchema} below, which
 * is what the use case parses with. Same split as
 * `upsertVolunteerPackInputSchemaBase`.
 */
export const upsertTicketPackInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    /** The upsert key. Present + known = edit; present + unknown = create. */
    key: ticketPackKeySchema,
    name: plainTextRequired(120),
    blurb: plainTextMultilineOptional(2000).nullish(),
    /**
     * Absent on create = DRAFT (the schema default). Publishing is a
     * separate, separately-audited action — see `setTicketPackStatus`.
     * Accepting it here too would make "save" and "publish" the same click.
     */
    sortOrder: z.number().int().min(0).max(9999).optional(),
    /**
     * Replace-set of the pack's catalogue templates, matched by name.
     * OMITTED = templates untouched (metadata-only edit). `[]` = delete all.
     */
    templates: z
      .array(ticketPackTemplateInputSchema)
      .max(MAX_PACK_TEMPLATES)
      .optional(),
  })
  .strict();

export const upsertTicketPackInputSchema = upsertTicketPackInputSchemaBase.refine(
  (d) =>
    d.templates === undefined ||
    new Set(d.templates.map((t) => t.name.trim().toLowerCase())).size ===
      d.templates.length,
  {
    // Mirrors the partial unique index
    // `TicketTypeTemplate_platform_pack_name_key`: one pack cannot list two
    // templates named "General admission". Caught here so the staff editor
    // gets a field error rather than a raw constraint violation.
    message: "template names must be unique within a pack",
    path: ["templates"],
  },
);

export const upsertTicketPackOutputSchema = z
  .object({ pack: ticketPackWithTemplatesSchema })
  .strict();

export type UpsertTicketPackInput = z.infer<typeof upsertTicketPackInputSchema>;
export type UpsertTicketPackOutput = z.infer<
  typeof upsertTicketPackOutputSchema
>;

export type UpsertTicketPackDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template diff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile a pack's catalogue templates against the payload, matched by
 * name (case-insensitively — the same comparison every template name check
 * in this codebase uses).
 *
 * Matching by name rather than wiping and recreating keeps template IDs
 * stable across an edit — owned forks reference their source only via
 * (packId, name), but stable ids keep audit trails and staff links honest.
 */
async function reconcilePackTemplates(
  tx: TxRepos,
  packId: string,
  existing: TicketTypeTemplateRecord[],
  desired: TicketPackTemplateInput[],
): Promise<{ created: number; updated: number; deleted: number }> {
  const byName = new Map(
    existing.map((row) => [row.name.trim().toLowerCase(), row] as const),
  );

  let created = 0;
  let updated = 0;

  for (const template of desired) {
    const match = byName.get(template.name.trim().toLowerCase());
    if (match) {
      // ID-SCOPED update. Safe here because `existing` came from
      // `getPackWithTemplates`, whose selection pins `isPlatform: true` —
      // an owner's fork carrying the same packId is never in this list.
      await tx.ticketTypeTemplates.updatePlatformTemplate(match.id, {
        name: template.name,
        ticketTypes: template.ticketTypes,
      });
      byName.delete(template.name.trim().toLowerCase());
      updated += 1;
    } else {
      await tx.ticketTypeTemplates.createPlatformTemplate({
        packId,
        name: template.name,
        ticketTypes: template.ticketTypes,
      });
      created += 1;
    }
  }

  // Whatever the payload no longer names is removed. PLATFORM-ONLY delete:
  // the repo pins `isPlatform: true`, so owned forks are untouchable here.
  const staleIds = [...byName.values()].map((row) => row.id);
  const deleted = await tx.ticketTypeTemplates.deletePlatformTemplates(
    staleIds,
  );

  return { created, updated, deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or edit a ticket pack and, optionally, its catalogue templates
 * (spec FR-012). Mirrors `upsertVolunteerPack`.
 *
 * A pack is created DRAFT and stays at whatever status it already has —
 * publishing is `setTicketPackStatus`, so "save my typo fix" can never ship
 * an unfinished pack to every organizer, and the two get separate audit rows.
 *
 * Templates are reconciled BY NAME (see `reconcilePackTemplates`); entries
 * go through the same zod schema the org flow uses, so a catalogue entry is
 * always one an organizer could have typed. Omitting `templates` entirely
 * leaves them alone; passing `[]` empties the pack.
 *
 * Auth: STAFF_TECH (ADMIN + DEVELOPER). Writes one AuditLog row per call
 * (entity "ticket_pack") naming the actor, inside the same transaction.
 */
export async function upsertTicketPack(
  deps: UpsertTicketPackDeps,
  rawInput: unknown,
): Promise<UpsertTicketPackOutput> {
  const input = parseInput(upsertTicketPackInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const pack = await deps.repos.tx(async (tx) => {
    const prior = await tx.ticketTypeTemplates.getPackByKey(input.key);

    const packRow = prior
      ? await tx.ticketTypeTemplates.updatePack(prior.id, {
          name: input.name,
          // OMITTED = untouched. `null` still clears explicitly — the field
          // is `.nullish()`, so the two cases stay distinguishable (the
          // volunteer upsert's metadata-only-edit lesson).
          ...(input.blurb !== undefined && { blurb: input.blurb ?? null }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          curatedByHumanId: input.actorHumanId,
        })
      : await tx.ticketTypeTemplates.createPack({
          key: input.key,
          name: input.name,
          blurb: input.blurb ?? null,
          // New packs are DRAFT. Publishing is a separate, audited action.
          status: "DRAFT",
          sortOrder: input.sortOrder ?? 0,
          curatedByHumanId: input.actorHumanId,
        });

    let templateDiff: {
      created: number;
      updated: number;
      deleted: number;
    } | null = null;
    if (input.templates !== undefined) {
      const current = await tx.ticketTypeTemplates.getPackWithTemplates(
        packRow.id,
      );
      templateDiff = await reconcilePackTemplates(
        tx,
        packRow.id,
        current?.templates ?? [],
        input.templates,
      );
    }

    await tx.audit.log({
      entity: "ticket_pack",
      entityId: packRow.id,
      action: prior ? "ticket_pack.updated" : "ticket_pack.created",
      data: {
        actorHumanId: input.actorHumanId,
        key: packRow.key,
        name: packRow.name,
        status: packRow.status,
        ...(templateDiff ? { templates: templateDiff } : {}),
      },
      at: deps.clock.now(),
    });

    const fresh = await tx.ticketTypeTemplates.getPackWithTemplates(packRow.id);
    if (!fresh) {
      // Unreachable: written in this transaction.
      throw fail("TICKET_PACK_NOT_FOUND");
    }
    return fresh;
  });

  deps.logger?.info("upsertTicketPack.completed", {
    packId: pack.id,
    key: pack.key,
    templateCount: pack.templates.length,
  });

  return upsertTicketPackOutputSchema.parse({ pack });
}
