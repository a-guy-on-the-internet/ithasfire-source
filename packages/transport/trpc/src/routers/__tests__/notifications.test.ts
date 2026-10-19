import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationsRouter } from "../notifications";
import { createCaller } from "./test-helpers";
import {
  createFakeNotificationsRepo,
  type FakeNotificationsRepo,
} from "@th/test-utils";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

describe("notificationsRouter", () => {
  let fakeRepo: FakeNotificationsRepo;

  beforeEach(() => {
    fakeRepo = createFakeNotificationsRepo();
  });

  const makeCaller = () =>
    createCaller({ notifications: notificationsRouter } as any, {
      actorHumanId: HUMAN_ID,
      repos: { notifications: fakeRepo } as any,
    });

  describe("list", () => {
    it("returns empty list when no notifications exist", async () => {
      const { caller } = makeCaller();
      const result = await caller.notifications.list({});
      expect(result).toEqual({ items: [], nextCursor: null });
    });

    it("returns notifications for the authed human", async () => {
      // Seed some notifications
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "Hello",
        body: "World",
        kind: "INFO",
      });
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "Sale complete",
        body: "Your ticket sold",
        kind: "SUCCESS",
      });

      const { caller } = makeCaller();
      const result = await caller.notifications.list({});
      expect(result.items).toHaveLength(2);
      const kinds = result.items.map((i: any) => i.kind).sort();
      expect(kinds).toEqual(["INFO", "SUCCESS"]);
    });

    it("filters by read state", async () => {
      const n = await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "Read me",
        body: "Already read",
        kind: "INFO",
      });
      await fakeRepo.markRead([n.id], HUMAN_ID);

      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "New",
        body: "Unread",
        kind: "WARNING",
      });

      const { caller } = makeCaller();

      const unread = await caller.notifications.list({ read: false });
      expect(unread.items).toHaveLength(1);
      expect(unread.items[0]!.title).toBe("New");

      const read = await caller.notifications.list({ read: true });
      expect(read.items).toHaveLength(1);
      expect(read.items[0]!.title).toBe("Read me");
    });
  });

  describe("list — reader's language and template privacy", () => {
    const RSVP_PAYLOAD = {
      eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      eventTitle: "Open Mic Night",
      startsAtIso: "2026-11-14T01:30:00.000Z",
      timezone: "America/Chicago",
      // Not in the in-app text: must never reach the client.
      addressText: "123 Secret Lane",
      eventUrl: "https://ithas.fire/e/open-mic-night",
    };

    /** A row the way `notify` stores an rsvp.confirmed (English text). */
    const seedRsvpRow = (variables: Record<string, unknown> = RSVP_PAYLOAD) =>
      fakeRepo.create({
        humanId: HUMAN_ID,
        title: "You're going to Open Mic Night",
        body: "Your RSVP for Open Mic Night is confirmed.",
        kind: "SUCCESS",
        metadata: { variant: "rsvp.confirmed" },
        action: { label: "View event", route: "/e/open-mic-night" },
        template: { key: "rsvp.confirmed", version: "1", variables },
      });

    it("re-renders the row in the requested locale and keeps the stored route", async () => {
      await seedRsvpRow();
      const { caller } = makeCaller();

      const result = await caller.notifications.list({ locale: "es-MX" });

      expect(result.items).toHaveLength(1);
      const item = result.items[0]!;
      expect(item.title).toBe("Vas a ir a Open Mic Night");
      expect(item.body).toMatch(/^Tu asistencia a Open Mic Night está confirmada\./u);
      expect(item.action).toMatchObject({
        label: "Ver evento",
        route: "/e/open-mic-night",
      });
    });

    it("returns the stored English text with no locale, or an unknown one", async () => {
      await seedRsvpRow();
      const { caller } = makeCaller();

      for (const input of [{}, { locale: "fr" }, { locale: "en" }]) {
        const result = await caller.notifications.list(input);
        expect(result.items[0]!.title).toBe("You're going to Open Mic Night");
        expect(result.items[0]!.action).toMatchObject({ label: "View event" });
      }
    });

    it("never returns the stored template (its variables can hold more than the text)", async () => {
      await seedRsvpRow();
      const { caller } = makeCaller();

      for (const input of [{}, { locale: "es" }]) {
        const result = await caller.notifications.list(input);
        const item = result.items[0]! as Record<string, unknown>;
        expect(item).not.toHaveProperty("templateKey");
        expect(item).not.toHaveProperty("templateVersion");
        expect(item).not.toHaveProperty("templateVariables");
        expect(JSON.stringify(result)).not.toContain("123 Secret Lane");
      }
    });

    it("falls back to the stored text and reports when the payload no longer renders", async () => {
      await seedRsvpRow({ eventTitle: "Open Mic Night" });
      const reportError = vi.fn();
      const { caller } = createCaller(
        { notifications: notificationsRouter } as any,
        {
          actorHumanId: HUMAN_ID,
          repos: { notifications: fakeRepo } as any,
          reportError,
        },
      );

      const result = await caller.notifications.list({ locale: "es" });

      expect(result.items[0]!.title).toBe("You're going to Open Mic Night");
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("reports a broken variant once across repeated polls, not once per poll", async () => {
      await seedRsvpRow({ eventTitle: "Open Mic Night" });
      const reportError = vi.fn();
      const { caller } = createCaller(
        { notifications: notificationsRouter } as any,
        {
          actorHumanId: HUMAN_ID,
          repos: { notifications: fakeRepo } as any,
          reportError,
        },
      );

      await caller.notifications.list({ locale: "es" });
      await caller.notifications.list({ locale: "es" });
      const third = await caller.notifications.list({ locale: "es" });

      expect(third.items[0]!.title).toBe("You're going to Open Mic Night");
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("accepts the `direction` key tRPC's useInfiniteQuery injects", async () => {
      await seedRsvpRow();
      const { caller } = makeCaller();
      const result = await caller.notifications.list({
        locale: "es",
        direction: "forward",
      });
      expect(result.items[0]!.title).toBe("Vas a ir a Open Mic Night");
    });

    it("rejects an oversized locale string", async () => {
      const { caller } = makeCaller();
      await expect(
        caller.notifications.list({ locale: "x".repeat(36) }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("countUnread", () => {
    it("returns 0 when no notifications", async () => {
      const { caller } = makeCaller();
      const result = await caller.notifications.countUnread();
      expect(result).toEqual({ count: 0 });
    });

    it("counts unread notifications", async () => {
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "A",
        body: "a",
        kind: "INFO",
      });
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "B",
        body: "b",
        kind: "INFO",
      });
      const read = await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "C",
        body: "c",
        kind: "INFO",
      });
      await fakeRepo.markRead([read.id], HUMAN_ID);

      const { caller } = makeCaller();
      const result = await caller.notifications.countUnread();
      expect(result).toEqual({ count: 2 });
    });
  });

  describe("markRead", () => {
    it("marks specific notifications as read", async () => {
      const n1 = await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "A",
        body: "a",
        kind: "INFO",
      });
      const n2 = await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "B",
        body: "b",
        kind: "INFO",
      });

      const { caller } = makeCaller();
      const result = await caller.notifications.markRead({ ids: [n1.id] });
      expect(result.count).toBe(1);

      // n1 is read, n2 is still unread
      const unread = await fakeRepo.countUnread(HUMAN_ID);
      expect(unread).toBe(1);
    });

    it("is idempotent — marking already-read notifications returns 0", async () => {
      const n = await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "A",
        body: "a",
        kind: "INFO",
      });
      await fakeRepo.markRead([n.id], HUMAN_ID);

      const { caller } = makeCaller();
      const result = await caller.notifications.markRead({ ids: [n.id] });
      expect(result.count).toBe(0);
    });
  });

  describe("markAllRead", () => {
    it("marks all notifications as read", async () => {
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "A",
        body: "a",
        kind: "INFO",
      });
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "B",
        body: "b",
        kind: "INFO",
      });
      await fakeRepo.create({
        humanId: HUMAN_ID,
        title: "C",
        body: "c",
        kind: "WARNING",
      });

      const { caller } = makeCaller();
      const result = await caller.notifications.markAllRead();
      expect(result.count).toBe(3);

      const unread = await fakeRepo.countUnread(HUMAN_ID);
      expect(unread).toBe(0);
    });

    it("returns 0 when nothing to mark", async () => {
      const { caller } = makeCaller();
      const result = await caller.notifications.markAllRead();
      expect(result.count).toBe(0);
    });
  });

  describe("graceful fallback (no notifications repo)", () => {
    const makeCallerNoRepo = () =>
      createCaller({ notifications: notificationsRouter } as any, {
        actorHumanId: HUMAN_ID,
        repos: { notifications: undefined } as any,
      });

    it("list returns empty when repo is missing", async () => {
      const { caller } = makeCallerNoRepo();
      const result = await caller.notifications.list({});
      expect(result).toEqual({ items: [], nextCursor: null });
    });

    it("countUnread returns 0 when repo is missing", async () => {
      const { caller } = makeCallerNoRepo();
      const result = await caller.notifications.countUnread();
      expect(result).toEqual({ count: 0 });
    });

    it("markRead returns 0 when repo is missing", async () => {
      const { caller } = makeCallerNoRepo();
      const result = await caller.notifications.markRead({
        ids: ["11111111-1111-4111-8111-000000000001"],
      });
      expect(result).toEqual({ count: 0 });
    });

    it("markAllRead returns 0 when repo is missing", async () => {
      const { caller } = makeCallerNoRepo();
      const result = await caller.notifications.markAllRead();
      expect(result).toEqual({ count: 0 });
    });
  });

  describe("push device registration", () => {
    const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

    const makePushCaller = () => {
      const registerDevice = vi.fn(async () => ({ ok: true as const }));
      const unregisterDevice = vi.fn(async () => ({ ok: true as const }));
      const push = {
        registerDevice,
        unregisterDevice,
        send: vi.fn(),
        health: vi.fn(),
      } as any;
      const { caller } = createCaller(
        { notifications: notificationsRouter } as any,
        {
          actorHumanId: HUMAN_ID,
          repos: { notifications: fakeRepo } as any,
          push,
        },
      );
      return { caller, registerDevice, unregisterDevice };
    };

    it("registerPushDevice registers for the authed human only", async () => {
      const { caller, registerDevice } = makePushCaller();

      const result = await caller.notifications.registerPushDevice({
        provider: "expo",
        token: TOKEN,
        platform: "ios",
      });

      expect(result).toEqual({ ok: true });
      expect(registerDevice).toHaveBeenCalledWith({
        humanId: HUMAN_ID,
        provider: "expo",
        token: TOKEN,
        platform: "ios",
      });
    });

    it("registerPushDevice rejects a client-supplied humanId (strict input)", async () => {
      const { caller, registerDevice } = makePushCaller();

      await expect(
        caller.notifications.registerPushDevice({
          humanId: "22222222-2222-4222-8222-222222222222",
          provider: "expo",
          token: TOKEN,
        } as any),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(registerDevice).not.toHaveBeenCalled();
    });

    it("unregisterPushDevice unregisters the authed human's device", async () => {
      const { caller, unregisterDevice } = makePushCaller();

      const result = await caller.notifications.unregisterPushDevice({
        token: TOKEN,
      });

      expect(result).toEqual({ ok: true });
      expect(unregisterDevice).toHaveBeenCalledWith({
        humanId: HUMAN_ID,
        token: TOKEN,
      });
    });

    it("unregisterPushDevice rejects a client-supplied humanId (strict input)", async () => {
      const { caller, unregisterDevice } = makePushCaller();

      await expect(
        caller.notifications.unregisterPushDevice({
          humanId: "22222222-2222-4222-8222-222222222222",
          token: TOKEN,
        } as any),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(unregisterDevice).not.toHaveBeenCalled();
    });

    it("registerPushDevice fails with PRECONDITION_FAILED when push port is not wired", async () => {
      const { caller } = createCaller(
        { notifications: notificationsRouter } as any,
        {
          actorHumanId: HUMAN_ID,
          repos: { notifications: fakeRepo } as any,
          // no push override → null in the base ctx
        },
      );

      await expect(
        caller.notifications.registerPushDevice({
          provider: "expo",
          token: TOKEN,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });
  });
});
