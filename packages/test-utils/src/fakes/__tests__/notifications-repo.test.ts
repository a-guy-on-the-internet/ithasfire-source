import { describe, it, expect, beforeEach } from "vitest";
import {
  createFakeNotificationsRepo,
  type FakeNotificationsRepo,
} from "../notifications-repo";

describe("FakeNotificationsRepo", () => {
  let repo: FakeNotificationsRepo;
  const HUMAN_ID = "human-1";

  beforeEach(() => {
    repo = createFakeNotificationsRepo();
  });

  async function seedNotifications(count: number, humanId = HUMAN_ID) {
    const ids: string[] = [];
    const baseTime = Date.now();
    for (let i = 0; i < count; i++) {
      const result = await repo.create({
        humanId,
        body: `Notification ${i}`,
        kind: "INFO",
      });
      ids.push(result.id);
      // Manually offset createdAt so pagination works in tests
      // (in-memory records created in the same tick share the same Date)
      const record = repo.__records.get(result.id)!;
      record.createdAt = new Date(baseTime + i);
    }
    return ids;
  }

  describe("listByHuman", () => {
    it("returns notifications for a specific human in desc order", async () => {
      await seedNotifications(3, HUMAN_ID);
      await seedNotifications(2, "other-human");

      const { items } = await repo.listByHuman({ humanId: HUMAN_ID });
      expect(items).toHaveLength(3);
      expect(items.every((n) => n.humanId === HUMAN_ID)).toBe(true);
      // Desc order
      expect(items[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        items[1]!.createdAt.getTime(),
      );
    });

    it("filters by read status", async () => {
      const [id1] = await seedNotifications(3);
      await repo.markRead([id1!], HUMAN_ID);

      const unread = await repo.listByHuman({ humanId: HUMAN_ID, read: false });
      expect(unread.items).toHaveLength(2);

      const read = await repo.listByHuman({ humanId: HUMAN_ID, read: true });
      expect(read.items).toHaveLength(1);
      expect(read.items[0]!.id).toBe(id1);
    });

    it("respects limit and returns nextCursor when there are more", async () => {
      await seedNotifications(5);

      const page1 = await repo.listByHuman({ humanId: HUMAN_ID, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await repo.listByHuman({
        humanId: HUMAN_ID,
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await repo.listByHuman({
        humanId: HUMAN_ID,
        limit: 2,
        cursor: page2.nextCursor!,
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
    });
  });

  describe("countUnread", () => {
    it("returns count of unread notifications", async () => {
      const [id1] = await seedNotifications(4);
      await repo.markRead([id1!], HUMAN_ID);

      const count = await repo.countUnread(HUMAN_ID);
      expect(count).toBe(3);
    });

    it("returns 0 when no notifications exist", async () => {
      const count = await repo.countUnread("nonexistent");
      expect(count).toBe(0);
    });
  });

  describe("markRead", () => {
    it("marks specific notifications as read", async () => {
      const [id1, id2, id3] = await seedNotifications(3);

      const result = await repo.markRead([id1!, id2!], HUMAN_ID);
      expect(result.count).toBe(2);

      const n1 = await repo.getById(id1!);
      expect(n1!.readAt).not.toBeNull();

      const n3 = await repo.getById(id3!);
      expect(n3!.readAt).toBeNull();
    });

    it("does not mark notifications belonging to a different human", async () => {
      const [id1] = await seedNotifications(1, HUMAN_ID);

      const result = await repo.markRead([id1!], "different-human");
      expect(result.count).toBe(0);

      const n1 = await repo.getById(id1!);
      expect(n1!.readAt).toBeNull();
    });

    it("does not double-count already-read notifications", async () => {
      const [id1] = await seedNotifications(1);
      await repo.markRead([id1!], HUMAN_ID);

      const result = await repo.markRead([id1!], HUMAN_ID);
      expect(result.count).toBe(0);
    });
  });

  describe("markAllRead", () => {
    it("marks all unread notifications for a human as read", async () => {
      await seedNotifications(5);
      const result = await repo.markAllRead(HUMAN_ID);
      expect(result.count).toBe(5);

      const count = await repo.countUnread(HUMAN_ID);
      expect(count).toBe(0);
    });

    it("does not affect other humans' notifications", async () => {
      await seedNotifications(3, HUMAN_ID);
      await seedNotifications(2, "other-human");

      await repo.markAllRead(HUMAN_ID);

      const countOther = await repo.countUnread("other-human");
      expect(countOther).toBe(2);
    });
  });
});
