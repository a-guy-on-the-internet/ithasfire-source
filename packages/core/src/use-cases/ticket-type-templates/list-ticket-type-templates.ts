import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { TicketTypeTemplateRecord } from "@th/types";
import { parseInput } from "../../lib/io";
import {
  listTicketTypeTemplatesInputSchema,
  listTicketTypeTemplatesResultSchema,
  type ListTicketTypeTemplatesResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";

export type ListTicketTypeTemplatesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Shadow key for fork identity (spec FR-006): an owned fork carries its
 * source pack's id as provenance plus the copied name — the same identity
 * the partial unique index `TicketTypeTemplate_platform_pack_name_key`
 * enforces on catalogue rows, so no owner ever sees two rows for the same
 * template.
 */
function packShadowKey(packId: string, name: string): string {
  return `${packId}:${name.toLowerCase()}`;
}

function toDto(template: TicketTypeTemplateRecord) {
  return {
    id: template.id,
    ownerScope: template.ownerScope,
    ownerId: template.ownerId,
    name: template.name,
    // Keys the entry schema no longer declares are stripped by the DTO
    // schema's stored-entry variant, not rejected.
    ticketTypes: template.ticketTypes,
    isPlatform: template.isPlatform,
    packId: template.packId,
    createdByHumanId: template.createdByHumanId,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

/**
 * The caller's own rows PLUS LIVE platform catalogue templates (spec
 * FR-006), each flagged `isPlatform` + `packId` so the UI can tag and group
 * them, with pack metadata riding along for the "From Ithas Fire" section.
 *
 * DRAFT packs' templates appear in no organizer-facing response — the repo
 * read is LIVE-only by construction. Shadowing: an owned fork matched on
 * (packId, name) case-insensitively hides its catalogue source in that
 * owner's list.
 */
export async function listTicketTypeTemplates(
  deps: ListTicketTypeTemplatesDeps,
  rawInput: unknown,
): Promise<ListTicketTypeTemplatesResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "listTicketTypeTemplates",
  });

  const input = parseInput(listTicketTypeTemplatesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await ensureTemplateOwnerAccess(
      tx,
      input.ownerScope,
      input.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      scopedLogger,
    );

    const [owned, platform, livePacks] = await Promise.all([
      tx.ticketTypeTemplates.list(input.ownerScope, input.ownerId),
      tx.ticketTypeTemplates.listLivePlatformTemplates(),
      tx.ticketTypeTemplates.listLivePacks(),
    ]);

    // Fork shadowing (FR-006): the owner's non-archived forks hide their
    // catalogue sources. `list` is owned-only and non-archived, so an
    // archived fork stops shadowing and the catalogue row resurfaces.
    const shadowKeys = new Set<string>();
    for (const row of owned) {
      if (row.packId) shadowKeys.add(packShadowKey(row.packId, row.name));
    }
    const visiblePlatform = platform.filter(
      (row) =>
        row.packId !== null &&
        !shadowKeys.has(packShadowKey(row.packId, row.name)),
    );

    // Only packs that still have a visible template — no empty groups.
    const visiblePackIds = new Set(
      visiblePlatform.map((row) => row.packId).filter(Boolean),
    );
    const packs = livePacks
      .filter((pack) => visiblePackIds.has(pack.id))
      .map((pack) => ({
        id: pack.id,
        key: pack.key,
        name: pack.name,
        blurb: pack.blurb,
        sortOrder: pack.sortOrder,
      }));

    return listTicketTypeTemplatesResultSchema.parse({
      items: [...owned.map(toDto), ...visiblePlatform.map(toDto)],
      packs,
    });
  });
}
