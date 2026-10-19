import { Prisma as PrismaNamespace } from "@prisma/client";
import type { AuditRepo } from "@th/ports/repos/audit";
import type {
  AuditLogListItem,
  ListAuditLogsForEntityInput,
  ListAuditLogsInput,
  ListAuditLogsResult,
} from "@th/types";

import type { PrismaClientOrTx } from "./types";

/** Best-effort extraction of `data.actorHumanId` — untyped JSON, never throws. */
function extractActorHumanId(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const value = (data as Record<string, unknown>).actorHumanId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Most rows one `listForEntity` call returns, whatever the caller asks. */
export const LIST_AUDIT_FOR_ENTITY_MAX = 500;

function toListItem(row: {
  id: string;
  entity: string;
  entityId: string | null;
  action: string;
  data: unknown;
  at: Date;
}): AuditLogListItem {
  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entityId,
    action: row.action,
    data: row.data,
    actorHumanId: extractActorHumanId(row.data),
    at: row.at,
  };
}

export function makeAuditRepo(p: PrismaClientOrTx): AuditRepo {
  return {
    log: (entry) =>
      p.auditLog
        .create({
          data: {
            entity: entry.entity,
            entityId: entry.entityId ?? null,
            action: entry.action,
            data: entry.data ?? {},
            at: entry.at ?? new Date(),
          },
        })
        .then(() => undefined),

    list: async (input: ListAuditLogsInput): Promise<ListAuditLogsResult> => {
      const {
        entity,
        action,
        entityId,
        actorHumanId,
        atGte,
        atLte,
        sort = "at_desc",
        limit = 25,
        offset = 0,
      } = input;

      const trimmedEntity = entity?.trim();
      const trimmedAction = action?.trim();

      const where = {
        ...(trimmedEntity
          ? { entity: { contains: trimmedEntity, mode: "insensitive" as const } }
          : {}),
        ...(trimmedAction
          ? { action: { contains: trimmedAction, mode: "insensitive" as const } }
          : {}),
        ...(entityId ? { entityId } : {}),
        ...(atGte || atLte
          ? {
              at: {
                ...(atGte ? { gte: atGte } : {}),
                ...(atLte ? { lte: atLte } : {}),
              },
            }
          : {}),
        // Best-effort JSON-path filter — see ListAuditLogsInput doc comment
        // re: no expression index backing this path.
        ...(actorHumanId
          ? { data: { path: ["actorHumanId"], equals: actorHumanId } }
          : {}),
      } as PrismaNamespace.AuditLogWhereInput;

      const [total, rows] = await Promise.all([
        p.auditLog.count({ where }),
        p.auditLog.findMany({
          where,
          orderBy: { at: sort === "at_asc" ? "asc" : "desc" },
          skip: offset,
          take: limit,
        }),
      ]);

      const items: AuditLogListItem[] = rows.map(toListItem);

      return { items, total };
    },

    listForEntity: async (
      input: ListAuditLogsForEntityInput,
    ): Promise<AuditLogListItem[]> => {
      if (input.actions.length === 0) return [];
      // A non-finite limit (NaN, Infinity) reads one row, never all of them.
      const take = Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.trunc(input.limit), 1), LIST_AUDIT_FOR_ENTITY_MAX)
        : 1;
      // Exact filters only, so the (entity, entityId, action, at) index
      // (AuditLog_entity_entityId_action_at_idx) serves the match, the `at`
      // order and the `after` bound.
      const rows = await p.auditLog.findMany({
        where: {
          entity: input.entity,
          entityId: input.entityId,
          action: { in: [...input.actions] },
          ...(input.after ? { at: { gt: input.after } } : {}),
        },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take,
      });
      return rows.map(toListItem);
    },
  };
}
