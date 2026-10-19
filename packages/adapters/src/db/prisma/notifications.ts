import { Prisma } from "@prisma/client";

import type {
  NotificationsRepo,
  NotificationRecord,
} from "@th/ports/repos/notifications";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const notificationSelect = {
  id: true,
  humanId: true,
  title: true,
  body: true,
  kind: true,
  metadata: true,
  tags: true,
  expiresAt: true,
  readAt: true,
  actionLabel: true,
  actionHref: true,
  actionRoute: true,
  templateKey: true,
  templateVersion: true,
  templateVariables: true,
  createdAt: true,
  updatedAt: true,
} as const;

const toNullableJson = (value: unknown): Prisma.NullableJsonNullValueInput =>
  (value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue)) as Prisma.NullableJsonNullValueInput;

type NotificationRow = Prisma.NotificationGetPayload<{
  select: typeof notificationSelect;
}>;

export function makeNotificationsRepo(p: PrismaClientOrTx): NotificationsRepo {
  return {
    create: async (input) => {
      const created = await p.notification.create({
        data: {
          humanId: input.humanId,
          title: input.title ?? null,
          body: input.body,
          kind: input.kind,
          metadata:
            typeof input.metadata === "undefined"
              ? undefined
              : toNullableJson(input.metadata),
          tags: input.tags ?? undefined,
          expiresAt:
            typeof input.expiresAt === "undefined"
              ? undefined
              : input.expiresAt,
          actionLabel: input.action?.label ?? undefined,
          actionHref: input.action?.href ?? undefined,
          actionRoute: input.action?.route ?? undefined,
          templateKey: input.template?.key ?? undefined,
          templateVersion: input.template?.version ?? undefined,
          templateVariables:
            typeof input.template?.variables === "undefined"
              ? undefined
              : toNullableJson(input.template?.variables ?? null),
        },
        select: { id: true, createdAt: true },
      });

      return created;
    },

    getById: async (id) => {
      const row = await p.notification.findUnique({
        where: { id },
        select: notificationSelect,
      });
      if (!row) return null;
      return mapNotification(row);
    },

    listByHuman: async (input) => {
      const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

      const where: Prisma.NotificationWhereInput = { humanId: input.humanId };
      if (input.read === true) where.readAt = { not: null };
      else if (input.read === false) where.readAt = null;
      if (input.cursor) where.createdAt = { lt: input.cursor };

      const rows = await p.notification.findMany({
        where,
        select: notificationSelect,
        orderBy: { createdAt: "desc" },
        take: limit + 1, // fetch one extra to detect next page
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(
        mapNotification,
      );
      const nextCursor =
        hasMore && items.length > 0 ? items[items.length - 1]!.createdAt : null;

      return { items, nextCursor };
    },

    countUnread: async (humanId) => {
      return p.notification.count({
        where: { humanId, readAt: null },
      });
    },

    markRead: async (ids, humanId) => {
      const result = await p.notification.updateMany({
        where: { id: { in: ids }, humanId, readAt: null },
        data: { readAt: new Date() },
      });
      return { count: result.count };
    },

    markAllRead: async (humanId) => {
      const result = await p.notification.updateMany({
        where: { humanId, readAt: null },
        data: { readAt: new Date() },
      });
      return { count: result.count };
    },

    findNotifiedHumanIdsForEvent: async ({ eventId, variant, humanIds }) => {
      if (humanIds.length === 0) return [];
      // Durable "already notified" ledger: sendInApp persists every in-app
      // notification with the variant in `tags` (buildTags) and the
      // renderer's `eventId` in `metadata` (sanitizeMetadata), so
      // (variant, eventId, humanId) is queryable without a ledger table.
      const rows = await p.notification.findMany({
        where: {
          humanId: { in: humanIds },
          tags: { has: variant },
          metadata: { path: ["eventId"], equals: eventId },
        },
        select: { humanId: true },
        distinct: ["humanId"],
      });
      return rows.map((row) => row.humanId);
    },
  };
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    humanId: row.humanId,
    title: row.title ?? null,
    body: row.body,
    kind: row.kind,
    metadata: normalizeMetadata(row.metadata),
    tags: row.tags ?? [],
    expiresAt: row.expiresAt ?? null,
    readAt: row.readAt ?? null,
    action: normalizeAction(row),
    templateKey: row.templateKey ?? null,
    templateVersion: row.templateVersion ?? null,
    templateVariables: normalizeTemplateVariables(row.templateVariables),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeMetadata(
  value: Prisma.JsonValue | null,
): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value).reduce<Record<string, string>>(
    (acc, [key, candidate]) => {
      if (typeof candidate === "string") {
        acc[key] = candidate;
      }
      return acc;
    },
    {},
  );

  return Object.keys(entries).length > 0 ? entries : null;
}

function normalizeTemplateVariables(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeAction(row: NotificationRow): NotificationRecord["action"] {
  if (!row.actionLabel) {
    return null;
  }

  return {
    label: row.actionLabel,
    href: row.actionHref ?? null,
    route: row.actionRoute ?? null,
  };
}
