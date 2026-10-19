import { describe, expect, it, vi } from "vitest";

import { makeNotificationDigestsRepo } from "../../../src/db/prisma/notification-digests";
import type { PrismaClientOrTx } from "../../../src/db/prisma/types";
import type {
  NotificationDigestChannel,
  NotificationDigestType,
} from "@th/ports/repos/notification-digests";

describe("makeNotificationDigestsRepo", () => {
  const windowStart = new Date("2024-01-01T00:00:00Z");
  const windowEnd = new Date("2024-01-08T00:00:00Z");

  const basePrisma = () => ({
    order: {
      findMany: vi.fn(),
    },
    orgMember: {
      findMany: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
    },
    feedbackRequest: {
      upsert: vi.fn(),
    },
    notificationDigestLog: {
      create: vi.fn(),
    },
    notificationDigestSubscription: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  });

  it("aggregates organizer metrics across orders", async () => {
    const prisma = basePrisma();
    const sendStubOrders = [
      {
        id: "order-1",
        eventId: "event-1",
        amountGrossCents: 12500,
        feesPlatformCents: 750,
        occurredAt: new Date("2024-01-04T10:00:00Z"),
        event: {
          id: "event-1",
          title: "Trivia Night",
          startsAt: new Date("2024-01-05T19:00:00Z"),
          endsAt: new Date("2024-01-05T22:00:00Z"),
          orgId: "org-1",
          org: {
            id: "org-1",
            name: "Downtown Events",
          },
        },
        items: [{ qty: 3, amountCents: 12500 }],
      },
    ];

    prisma.order.findMany.mockResolvedValue(sendStubOrders);
    prisma.orgMember.findMany.mockResolvedValue([
      {
        orgId: "org-1",
        human: {
          id: "human-1",
          name: "Owner",
          authUser: { email: "owner@example.com" },
        },
      },
    ]);
    prisma.event.findMany.mockResolvedValue([
      {
        id: "event-2",
        orgId: "org-1",
        title: "Future Meetup",
        startsAt: new Date("2024-01-12T18:00:00Z"),
        endsAt: null,
        ticketTypes: [{ capacity: 120 }],
      },
    ]);

    const repo = makeNotificationDigestsRepo(
      prisma as unknown as PrismaClientOrTx,
    );
    const result = await repo.listOrganizerMetrics({ windowStart, windowEnd });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurredAt: { gte: windowStart, lt: windowEnd },
        }),
      }),
    );

    expect(result).toHaveLength(1);

    const metrics = result[0];
    expect(metrics).toBeDefined();
    if (!metrics) return;
    expect(metrics.orgId).toBe("org-1");
    expect(metrics.totals.ticketsSold).toBe(3);
    expect(metrics.totals.grossRevenueCents).toBe(12500);
    expect(metrics.recipients).toEqual([
      {
        humanId: "human-1",
        email: "owner@example.com",
        name: "Owner",
      },
    ]);
    expect(metrics.recentEvents).toHaveLength(1);
    expect(metrics.upcomingEvents).toEqual([
      expect.objectContaining({
        eventId: "event-2",
        ticketsOnSale: 120,
      }),
    ]);
  });

  it("ensures feedback requests are upserted", async () => {
    const prisma = basePrisma();
    const sendAfter = new Date("2024-01-09T12:00:00Z");

    prisma.feedbackRequest.upsert.mockResolvedValue({
      id: "req-1",
      eventId: "event-1",
      orderId: "order-1",
      humanId: "human-1",
      status: "SCHEDULED",
      channel: "EMAIL" satisfies NotificationDigestChannel,
      sendAfter,
      sentAt: null,
      respondedAt: null,
      payloadHash: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const repo = makeNotificationDigestsRepo(
      prisma as unknown as PrismaClientOrTx,
    );
    const record = await repo.ensureFeedbackRequest({
      eventId: "event-1",
      orderId: "order-1",
      humanId: "human-1",
      channel: "EMAIL",
      sendAfter,
    });

    expect(prisma.feedbackRequest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId_humanId: { orderId: "order-1", humanId: "human-1" } },
      }),
    );

    expect(record).toMatchObject({
      id: "req-1",
      status: "SCHEDULED",
      sendAfter,
    });
  });

  it("records digest logs", async () => {
    const prisma = basePrisma();
    const sentAt = new Date("2024-01-03T15:30:00Z");

    prisma.notificationDigestLog.create.mockResolvedValue({
      id: "log-1",
      humanId: "human-1",
      orgId: "org-1",
      eventId: "event-1",
      digestType: "ORGANIZER_WEEKLY" satisfies NotificationDigestType,
      channel: "EMAIL" satisfies NotificationDigestChannel,
      payloadHash: "hash-1",
      templateKey: "digest.organizer.weekly",
      metadata: { sample: true },
      sentAt,
      createdAt: sentAt,
    });

    const repo = makeNotificationDigestsRepo(
      prisma as unknown as PrismaClientOrTx,
    );
    const log = await repo.recordDigestLog({
      humanId: "human-1",
      orgId: "org-1",
      eventId: "event-1",
      digestType: "ORGANIZER_WEEKLY",
      channel: "EMAIL",
      payloadHash: "hash-1",
      templateKey: "digest.organizer.weekly",
      metadata: { sample: true },
      sentAt,
    });

    expect(prisma.notificationDigestLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payloadHash: "hash-1" }),
      }),
    );

    expect(log).toMatchObject({
      id: "log-1",
      digestType: "ORGANIZER_WEEKLY",
      channel: "EMAIL",
      payloadHash: "hash-1",
    });
    expect(log.metadata).toEqual({ sample: true });
  });
});
