import { Prisma } from "@prisma/client";
import type {
  TemplateOwnerScope,
  TicketPackRecord,
  TicketPackStatus,
  TicketPackWithCountsRecord,
  TicketTypeTemplateEntry,
  TicketTypeTemplateRecord,
  CreateTicketPackInput,
  CreatePlatformTicketTypeTemplateInput,
  UpdatePlatformTicketTypeTemplateInput,
  UpdateTicketPackInput,
} from "@th/types";
import type { TicketTypeTemplatesRepo } from "@th/ports/repos/ticket-type-templates";
import { fail } from "@th/errors";

import type { PrismaClientOrTx } from "./types";

const ORDER_BY: Prisma.TicketTypeTemplateOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

const PACK_ORDER_BY: Prisma.TicketPackOrderByWithRelationInput[] = [
  { sortOrder: "asc" },
  { name: "asc" },
];

function mapTemplate(model: {
  id: string;
  ownerScope: TemplateOwnerScope;
  ownerId: string | null;
  name: string;
  ticketTypes: Prisma.JsonValue;
  isPlatform: boolean;
  packId: string | null;
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}): TicketTypeTemplateRecord {
  return {
    id: model.id,
    ownerScope: model.ownerScope,
    ownerId: model.ownerId,
    name: model.name,
    // Entries are validated by the use-case schema at write time; the column
    // only ever holds TicketTypeTemplateEntry[]. Rows saved before a field was
    // removed from the schema may still carry its key; the use-case DTO
    // schema strips it on read (ticketTypeTemplateStoredEntrySchema).
    ticketTypes: (model.ticketTypes ?? []) as unknown as TicketTypeTemplateEntry[],
    isPlatform: model.isPlatform,
    packId: model.packId,
    createdByHumanId: model.createdByHumanId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    archivedAt: model.archivedAt,
  };
}

function mapPack(model: {
  id: string;
  key: string;
  name: string;
  blurb: string | null;
  status: TicketPackStatus;
  sortOrder: number;
  curatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TicketPackRecord {
  return {
    id: model.id,
    key: model.key,
    name: model.name,
    blurb: model.blurb,
    status: model.status,
    sortOrder: model.sortOrder,
    curatedByHumanId: model.curatedByHumanId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

export function makeTicketTypeTemplatesRepo(
  p: PrismaClientOrTx,
): TicketTypeTemplatesRepo {
  return {
    async getById(id) {
      const template = await p.ticketTypeTemplate.findUnique({ where: { id } });
      return template ? mapTemplate(template) : null;
    },
    async findByName(ownerScope, ownerId, normalizedName) {
      // OWNED rows only: `ownerId` equality never matches a NULL catalogue
      // row; `isPlatform: false` is pinned anyway so a mis-shaped row
      // (flag set WITH an ownerId) still cannot surface as "yours".
      const template = await p.ticketTypeTemplate.findFirst({
        where: {
          ownerScope,
          ownerId,
          isPlatform: false,
          name: { equals: normalizedName, mode: "insensitive" },
        },
      });
      return template ? mapTemplate(template) : null;
    },
    async create(input) {
      const template = await p.ticketTypeTemplate.create({
        data: {
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          ticketTypes: input.ticketTypes as unknown as Prisma.InputJsonValue,
          // Fork provenance only — `isPlatform` is deliberately not settable
          // here, so no organizer-facing path can mint a catalogue row.
          packId: input.packId ?? null,
          createdByHumanId: input.createdByHumanId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
        } satisfies Prisma.TicketTypeTemplateUncheckedCreateInput,
      });
      return mapTemplate(template);
    },
    async list(ownerScope, ownerId) {
      // OWNED rows only — the platform union is `listLivePlatformTemplates`.
      const templates = await p.ticketTypeTemplate.findMany({
        where: { ownerScope, ownerId, isPlatform: false, archivedAt: null },
        orderBy: ORDER_BY,
      });
      return templates.map(mapTemplate);
    },
    async archive(input) {
      const archived = await p.ticketTypeTemplate.update({
        where: { id: input.templateId },
        data: {
          archivedAt: input.archivedAt,
          updatedAt: input.archivedAt,
        } satisfies Prisma.TicketTypeTemplateUncheckedUpdateInput,
      });
      return mapTemplate(archived);
    },

    // ── Platform catalogue reads (organizer-facing) ───────────────────────
    //
    // LIVE-ONLY by construction: DRAFT packs' templates cannot come back
    // from these two, so unpublished curation work cannot leak through an
    // organizer path even if a caller's filtering changed (spec FR-006).

    async listLivePlatformTemplates() {
      const templates = await p.ticketTypeTemplate.findMany({
        where: {
          ownerId: null,
          isPlatform: true,
          archivedAt: null,
          pack: { status: "LIVE" },
        },
        orderBy: [
          { pack: { sortOrder: "asc" } },
          { pack: { name: "asc" } },
          { name: "asc" },
        ],
      });
      return templates.map(mapTemplate);
    },

    async listLivePacks() {
      const packs = await p.ticketPack.findMany({
        where: { status: "LIVE" },
        orderBy: PACK_ORDER_BY,
      });
      return packs.map(mapPack);
    },

    // ── Packs (staff catalogue) ───────────────────────────────────────────
    //
    // STATUS-BLIND, all of it. Callers gate on STAFF_TECH; nothing here is
    // reachable from an organizer-facing use case.

    async createPack(input: CreateTicketPackInput) {
      try {
        const row = await p.ticketPack.create({
          data: {
            key: input.key,
            name: input.name,
            blurb: input.blurb ?? null,
            ...(input.status !== undefined && { status: input.status }),
            sortOrder: input.sortOrder ?? 0,
            curatedByHumanId: input.curatedByHumanId ?? null,
          },
        });
        return mapPack(row);
      } catch (error) {
        // P2002 on create can only be `TicketPack_key_key` — the race loser
        // of two staff creating the same key. Same translation as
        // VOLUNTEER_PACK_KEY_TAKEN in the volunteering adapter.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("TICKET_PACK_KEY_TAKEN", { cause: error });
        }
        throw error;
      }
    },

    async updatePack(id: string, input: UpdateTicketPackInput) {
      const row = await p.ticketPack.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.blurb !== undefined && { blurb: input.blurb }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          ...(input.curatedByHumanId !== undefined && {
            curatedByHumanId: input.curatedByHumanId,
          }),
        },
      });
      return mapPack(row);
    },

    async getPack(id) {
      const row = await p.ticketPack.findUnique({ where: { id } });
      return row ? mapPack(row) : null;
    },

    async getPackByKey(key) {
      const row = await p.ticketPack.findUnique({ where: { key } });
      return row ? mapPack(row) : null;
    },

    /**
     * Counts come from grouped aggregates over the SAME `packId` column,
     * split on `isPlatform` — catalogue rows the pack owns vs owned forks
     * descended from it. Entry counts need the Json payloads, but only for
     * platform rows, fetched once for all packs (no N+1).
     */
    async listPacks(opts?: { status?: TicketPackStatus }) {
      const rows = await p.ticketPack.findMany({
        where: { ...(opts?.status ? { status: opts.status } : {}) },
        orderBy: PACK_ORDER_BY,
      });
      if (rows.length === 0) return [];

      const packIds = rows.map((row) => row.id);
      const [platformRows, forkCounts] = await Promise.all([
        p.ticketTypeTemplate.findMany({
          where: { packId: { in: packIds }, isPlatform: true },
          select: { packId: true, ticketTypes: true },
        }),
        p.ticketTypeTemplate.groupBy({
          by: ["packId"],
          where: { packId: { in: packIds }, isPlatform: false },
          _count: { _all: true },
        }),
      ]);

      const templateByPack = new Map<string, number>();
      const entryByPack = new Map<string, number>();
      for (const row of platformRows) {
        if (!row.packId) continue;
        templateByPack.set(row.packId, (templateByPack.get(row.packId) ?? 0) + 1);
        const entries = Array.isArray(row.ticketTypes) ? row.ticketTypes : [];
        entryByPack.set(
          row.packId,
          (entryByPack.get(row.packId) ?? 0) + entries.length,
        );
      }
      const forkByPack = new Map<string, number>();
      for (const group of forkCounts) {
        if (group.packId) forkByPack.set(group.packId, group._count._all);
      }

      return rows.map(
        (row): TicketPackWithCountsRecord => ({
          ...mapPack(row),
          templateCount: templateByPack.get(row.id) ?? 0,
          entryCount: entryByPack.get(row.id) ?? 0,
          forkCount: forkByPack.get(row.id) ?? 0,
        }),
      );
    },

    async deletePack(id) {
      await p.ticketPack.delete({ where: { id } });
    },

    async getPackWithTemplates(id) {
      const row = await p.ticketPack.findUnique({
        where: { id },
        include: {
          templates: {
            where: { isPlatform: true },
            orderBy: [{ name: "asc" }],
          },
        },
      });
      if (!row) return null;
      return {
        ...mapPack(row),
        templates: row.templates.map(mapTemplate),
      };
    },

    // ── Platform (catalogue) templates ────────────────────────────────────

    async createPlatformTemplate(
      input: CreatePlatformTicketTypeTemplateInput,
    ) {
      try {
        const row = await p.ticketTypeTemplate.create({
          data: {
            // PLATFORM-ONLY write: both fixed here, not caller-settable.
            ownerId: null,
            isPlatform: true,
            // `ownerScope` is NOT NULL in the schema; ORGANIZATION by
            // convention on catalogue rows, and ignored (spec FR-002).
            ownerScope: "ORGANIZATION",
            packId: input.packId,
            name: input.name,
            ticketTypes: input.ticketTypes as unknown as Prisma.InputJsonValue,
            createdByHumanId: null,
            archivedAt: null,
          } satisfies Prisma.TicketTypeTemplateUncheckedCreateInput,
        });
        return mapTemplate(row);
      } catch (error) {
        // P2002 here can only be the partial unique
        // `TicketTypeTemplate_platform_pack_name_key`: two staff upserting
        // the same pack concurrently, both adding "General admission".
        // TEMPLATE_NAME_TAKEN is the code the owned-side collision already
        // uses and maps to CONFLICT.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("TEMPLATE_NAME_TAKEN", { cause: error });
        }
        throw error;
      }
    },

    async updatePlatformTemplate(
      id: string,
      input: UpdatePlatformTicketTypeTemplateInput,
    ) {
      // ID-scoped but PLATFORM-PINNED: an owned row's id passed here throws
      // P2025 (no match) rather than mutating someone's template.
      const result = await p.ticketTypeTemplate.updateMany({
        where: { id, isPlatform: true },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.ticketTypes !== undefined && {
            ticketTypes: input.ticketTypes as unknown as Prisma.InputJsonValue,
          }),
        },
      });
      if (result.count === 0) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      const fresh = await p.ticketTypeTemplate.findUnique({ where: { id } });
      if (!fresh) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      return mapTemplate(fresh);
    },

    async deletePlatformTemplates(ids) {
      if (ids.length === 0) return 0;
      const result = await p.ticketTypeTemplate.deleteMany({
        where: { id: { in: ids }, isPlatform: true },
      });
      return result.count;
    },

    async deletePlatformTemplatesByPack(packId) {
      const result = await p.ticketTypeTemplate.deleteMany({
        where: { packId, isPlatform: true },
      });
      return result.count;
    },

    async countPlatformTemplatesByPack(packId) {
      return p.ticketTypeTemplate.count({
        where: { packId, isPlatform: true },
      });
    },
  };
}
