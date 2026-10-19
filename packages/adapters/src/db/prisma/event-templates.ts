import { Prisma } from "@prisma/client";
import type {
  ArchiveEventTemplateRepoInput,
  CreateEventTemplateRepoInput,
  EventTemplateListFilters,
  EventTemplateListResult,
  EventTemplateRecord,
  TemplateDefaults,
  TemplateOwnerScope,
  UpdateEventTemplateRepoPatch,
} from "@th/types";
import type { EventTemplateRepo } from "@th/ports/repos/event-templates";

import type { PrismaClientOrTx } from "./types";

const ORDER_BY: Prisma.EventTemplateOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

function buildCursor(template: { createdAt: Date; id: string }): string {
  return `${template.createdAt.getTime()}::${template.id}`;
}

function parseCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [timestamp, id] = cursor.split("::");
  if (!timestamp || !id) {
    return null;
  }

  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) {
    return null;
  }

  return { createdAt: new Date(ms), id };
}

function mapTemplate(model: {
  id: string;
  ownerScope: TemplateOwnerScope;
  ownerId: string;
  name: string;
  description: string | null;
  active: boolean;
  defaults: Prisma.JsonValue | null;
  createdByHumanId: string | null;
  updatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}): EventTemplateRecord {
  return {
    id: model.id,
    ownerScope: model.ownerScope,
    ownerId: model.ownerId,
    name: model.name,
    description: model.description,
    active: model.active,
    defaults: (model.defaults ?? null) as TemplateDefaults | null,
    createdByHumanId: model.createdByHumanId,
    updatedByHumanId: model.updatedByHumanId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    archivedAt: model.archivedAt,
  };
}

function toJsonValue(
  value: TemplateDefaults | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return Prisma.DbNull;
  }
  return value as Prisma.InputJsonValue;
}

function makeNameFilter(
  ownerScope: TemplateOwnerScope,
  ownerId: string,
  normalizedName: string,
) {
  return {
    ownerScope,
    ownerId,
    name: { equals: normalizedName, mode: "insensitive" as const },
  } satisfies Prisma.EventTemplateWhereInput;
}

function applySearchFilters(
  filters: EventTemplateListFilters,
): Prisma.EventTemplateWhereInput {
  const clauses: Prisma.EventTemplateWhereInput[] = [
    { ownerScope: filters.ownerScope },
    { ownerId: filters.ownerId },
  ];

  if (filters.activeOnly) {
    clauses.push({ active: true, archivedAt: null });
  }

  if (filters.q) {
    clauses.push({ name: { contains: filters.q, mode: "insensitive" } });
  }

  return { AND: clauses };
}

export function makeEventTemplatesRepo(p: PrismaClientOrTx): EventTemplateRepo {
  return {
    async getById(id) {
      const template = await p.eventTemplate.findUnique({ where: { id } });
      return template ? mapTemplate(template) : null;
    },
    async findByName(ownerScope, ownerId, normalizedName) {
      const template = await p.eventTemplate.findFirst({
        where: makeNameFilter(ownerScope, ownerId, normalizedName),
      });
      return template ? mapTemplate(template) : null;
    },
    async create(input) {
      const template = await p.eventTemplate.create({
        data: {
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          description: input.description,
          defaults: toJsonValue(input.defaults),
          active: input.active,
          createdByHumanId: input.createdByHumanId,
          updatedByHumanId: input.createdByHumanId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
        } satisfies Prisma.EventTemplateUncheckedCreateInput,
      });

      return mapTemplate(template);
    },
    async update(templateId, patch) {
      const data: Prisma.EventTemplateUncheckedUpdateInput = {
        updatedByHumanId: patch.updatedByHumanId,
        updatedAt: patch.updatedAt,
      };

      if (
        Object.prototype.hasOwnProperty.call(patch, "name") &&
        patch.name !== undefined
      ) {
        data.name = patch.name;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "description")) {
        data.description = patch.description ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "defaults")) {
        data.defaults = toJsonValue(patch.defaults);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "active")) {
        if (typeof patch.active === "boolean") {
          data.active = patch.active;
          if (patch.active) {
            data.archivedAt = null;
          }
        }
      }

      const updated = await p.eventTemplate.update({
        where: { id: templateId },
        data,
      });
      return mapTemplate(updated);
    },
    async archive(input) {
      const archived = await p.eventTemplate.update({
        where: { id: input.templateId },
        data: {
          active: false,
          archivedAt: input.archivedAt,
          updatedAt: input.archivedAt,
          updatedByHumanId: input.archivedByHumanId,
        } satisfies Prisma.EventTemplateUncheckedUpdateInput,
      });
      return mapTemplate(archived);
    },
    async list(filters) {
      const baseWhere = applySearchFilters(filters);
      const cursorData = filters.cursor ? parseCursor(filters.cursor) : null;
      const where = cursorData
        ? {
            AND: [
              baseWhere,
              {
                OR: [
                  { createdAt: { lt: cursorData.createdAt } },
                  {
                    AND: [
                      { createdAt: cursorData.createdAt },
                      { id: { lt: cursorData.id } },
                    ],
                  },
                ],
              },
            ],
          }
        : baseWhere;

      const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));

      const templates = await p.eventTemplate.findMany({
        where,
        orderBy: ORDER_BY,
        take: limit + 1,
      });

      const items = templates.slice(0, limit).map(mapTemplate);
      const nextTemplate =
        templates.length > limit ? templates[limit] : undefined;
      const nextCursor = nextTemplate ? buildCursor(nextTemplate) : undefined;

      return { items, nextCursor } satisfies EventTemplateListResult;
    },
  };
}
