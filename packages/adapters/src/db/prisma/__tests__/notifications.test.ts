import { describe, expect, it, vi } from "vitest";

import { makeNotificationsRepo } from "../notifications";

describe("makeNotificationsRepo", () => {
  it("creates notifications with optional fields", async () => {
    const createdAt = new Date("2024-01-01T00:00:00Z");
    const notificationClient = {
      create: vi.fn().mockResolvedValue({ id: "notif-1", createdAt }),
    };

    const repo = makeNotificationsRepo({
      notification: notificationClient,
    } as any);

    const result = await repo.create({
      humanId: "human-1",
      title: "Heads up",
      body: "Something happened",
      kind: "INFO",
      metadata: { foo: "bar" },
      tags: ["event"],
      expiresAt: null,
      action: { label: "View", href: "https://example.com" },
      template: {
        key: "notification.generic",
        version: "1",
        variables: { foo: "bar" },
      },
    });

    expect(notificationClient.create).toHaveBeenCalledWith({
      data: {
        humanId: "human-1",
        title: "Heads up",
        body: "Something happened",
        kind: "INFO",
        metadata: { foo: "bar" },
        tags: ["event"],
        expiresAt: null,
        actionLabel: "View",
        actionHref: "https://example.com",
        actionRoute: undefined,
        templateKey: "notification.generic",
        templateVersion: "1",
        templateVariables: { foo: "bar" },
      },
      select: { id: true, createdAt: true },
    });

    expect(result).toEqual({ id: "notif-1", createdAt });
  });

  it("returns mapped records", async () => {
    const now = new Date("2024-02-01T00:00:00Z");
    const row = {
      id: "notif-2",
      humanId: "human-2",
      title: null,
      body: "Approved",
      kind: "SUCCESS",
      metadata: { eventId: "event-1" },
      tags: null,
      expiresAt: now,
      actionLabel: "Open",
      actionHref: null,
      actionRoute: "/events/event-1",
      templateKey: null,
      templateVersion: null,
      templateVariables: { token: "abc" },
      createdAt: now,
      updatedAt: now,
    };

    const notificationClient = {
      findUnique: vi.fn().mockResolvedValue(row),
    };

    const repo = makeNotificationsRepo({
      notification: notificationClient,
    } as any);

    const record = await repo.getById("notif-2");

    expect(notificationClient.findUnique).toHaveBeenCalledWith({
      where: { id: "notif-2" },
      select: expect.any(Object),
    });

    expect(record).toEqual({
      id: "notif-2",
      humanId: "human-2",
      title: null,
      body: "Approved",
      kind: "SUCCESS",
      metadata: { eventId: "event-1" },
      tags: [],
      expiresAt: now,
      readAt: null,
      action: { label: "Open", href: null, route: "/events/event-1" },
      templateKey: null,
      templateVersion: null,
      templateVariables: { token: "abc" },
      createdAt: now,
      updatedAt: now,
    });
  });

  it("returns null when not found", async () => {
    const notificationClient = {
      findUnique: vi.fn().mockResolvedValue(null),
    };

    const repo = makeNotificationsRepo({
      notification: notificationClient,
    } as any);

    expect(await repo.getById("missing")).toBeNull();
  });

  describe("findNotifiedHumanIdsForEvent (durable fan-out ledger)", () => {
    it("queries by candidate humanIds, variant tag, and metadata.eventId, returning distinct humanIds", async () => {
      const notificationClient = {
        findMany: vi
          .fn()
          .mockResolvedValue([{ humanId: "human-1" }, { humanId: "human-3" }]),
      };

      const repo = makeNotificationsRepo({
        notification: notificationClient,
      } as any);

      const result = await repo.findNotifiedHumanIdsForEvent({
        eventId: "event-1",
        variant: "event.location-revealed",
        humanIds: ["human-1", "human-2", "human-3"],
      });

      expect(notificationClient.findMany).toHaveBeenCalledWith({
        where: {
          humanId: { in: ["human-1", "human-2", "human-3"] },
          tags: { has: "event.location-revealed" },
          metadata: { path: ["eventId"], equals: "event-1" },
        },
        select: { humanId: true },
        distinct: ["humanId"],
      });
      expect(result).toEqual(["human-1", "human-3"]);
    });

    it("short-circuits on an empty candidate list without querying", async () => {
      const notificationClient = {
        findMany: vi.fn(),
      };

      const repo = makeNotificationsRepo({
        notification: notificationClient,
      } as any);

      const result = await repo.findNotifiedHumanIdsForEvent({
        eventId: "event-1",
        variant: "event.location-revealed",
        humanIds: [],
      });

      expect(result).toEqual([]);
      expect(notificationClient.findMany).not.toHaveBeenCalled();
    });
  });
});
