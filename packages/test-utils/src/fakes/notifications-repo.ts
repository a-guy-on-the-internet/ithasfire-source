import { randomUUID } from "node:crypto";
import { vi } from "vitest";

import type {
  NotificationsRepo,
  CreateNotificationInput,
  CreateNotificationResult,
  FindNotifiedHumanIdsForEventInput,
  ListNotificationsInput,
  ListNotificationsResult,
  MarkReadResult,
  NotificationRecord,
} from "@th/ports/repos/notifications";

export type FakeNotificationsRepo = NotificationsRepo & {
  __records: Map<string, NotificationRecord>;
  __mocks: {
    create: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    listByHuman: ReturnType<typeof vi.fn>;
    countUnread: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
    markAllRead: ReturnType<typeof vi.fn>;
    findNotifiedHumanIdsForEvent: ReturnType<typeof vi.fn>;
  };
};

const normalizeExpiresAt = (
  expiresAt: CreateNotificationInput["expiresAt"],
): Date | null => {
  if (!expiresAt) return null;
  if (expiresAt instanceof Date) return expiresAt;
  const parsed = new Date(expiresAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export function createFakeNotificationsRepo(): FakeNotificationsRepo {
  const records = new Map<string, NotificationRecord>();

  const createMock = vi.fn(
    async (
      input: CreateNotificationInput,
    ): Promise<CreateNotificationResult> => {
      const id = randomUUID();
      const now = new Date();
      const record: NotificationRecord = {
        id,
        humanId: input.humanId,
        title: input.title ?? null,
        body: input.body,
        kind: input.kind,
        metadata: input.metadata ?? null,
        tags: input.tags ?? [],
        expiresAt: normalizeExpiresAt(input.expiresAt) ?? null,
        readAt: null,
        action: input.action ?? null,
        templateKey: input.template?.key ?? null,
        templateVersion: input.template?.version ?? null,
        templateVariables: input.template?.variables ?? null,
        createdAt: now,
        updatedAt: now,
      };

      records.set(id, record);

      return {
        id,
        createdAt: now,
      };
    },
  );

  const getByIdMock = vi.fn(
    async (id: string): Promise<NotificationRecord | null> => {
      return records.get(id) ?? null;
    },
  );

  const listByHumanMock = vi.fn(
    async (input: ListNotificationsInput): Promise<ListNotificationsResult> => {
      const all = [...records.values()]
        .filter((r) => r.humanId === input.humanId)
        .filter((r) => {
          if (input.read === true) return r.readAt !== null;
          if (input.read === false) return r.readAt === null;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const afterCursor = input.cursor
        ? all.filter((r) => r.createdAt < input.cursor!)
        : all;

      const limit = input.limit ?? 50;
      const items = afterCursor.slice(0, limit + 1);
      const hasMore = items.length > limit;
      const page = hasMore ? items.slice(0, limit) : items;

      return {
        items: page,
        nextCursor:
          hasMore && page.length > 0 ? page[page.length - 1]!.createdAt : null,
      };
    },
  );

  const countUnreadMock = vi.fn(async (humanId: string): Promise<number> => {
    return [...records.values()].filter(
      (r) => r.humanId === humanId && r.readAt === null,
    ).length;
  });

  const markReadMock = vi.fn(
    async (ids: string[], humanId: string): Promise<MarkReadResult> => {
      let count = 0;
      for (const id of ids) {
        const r = records.get(id);
        if (r && r.humanId === humanId && r.readAt === null) {
          r.readAt = new Date();
          count++;
        }
      }
      return { count };
    },
  );

  const markAllReadMock = vi.fn(
    async (humanId: string): Promise<MarkReadResult> => {
      let count = 0;
      for (const r of records.values()) {
        if (r.humanId === humanId && r.readAt === null) {
          r.readAt = new Date();
          count++;
        }
      }
      return { count };
    },
  );

  // Mirrors the Prisma adapter: a persisted notification counts as "already
  // notified" for (variant, eventId) when the variant is in `tags` and the
  // renderer's eventId landed in `metadata` (buildTags/sanitizeMetadata).
  const findNotifiedHumanIdsForEventMock = vi.fn(
    async (input: FindNotifiedHumanIdsForEventInput): Promise<string[]> => {
      const candidates = new Set(input.humanIds);
      const notified = new Set<string>();
      for (const r of records.values()) {
        if (!candidates.has(r.humanId)) continue;
        if (!r.tags.includes(input.variant)) continue;
        if (r.metadata?.eventId !== input.eventId) continue;
        notified.add(r.humanId);
      }
      return [...notified];
    },
  );

  const repo: NotificationsRepo = {
    create: createMock,
    getById: getByIdMock,
    listByHuman: listByHumanMock,
    countUnread: countUnreadMock,
    markRead: markReadMock,
    markAllRead: markAllReadMock,
    findNotifiedHumanIdsForEvent: findNotifiedHumanIdsForEventMock,
  };

  return Object.assign(repo, {
    __records: records,
    __mocks: {
      create: createMock,
      getById: getByIdMock,
      listByHuman: listByHumanMock,
      countUnread: countUnreadMock,
      markRead: markReadMock,
      markAllRead: markAllReadMock,
      findNotifiedHumanIdsForEvent: findNotifiedHumanIdsForEventMock,
    },
  }) as FakeNotificationsRepo;
}
