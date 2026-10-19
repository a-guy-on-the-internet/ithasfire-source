import { describe, expect, it, vi } from "vitest";

import { makeEventWaitlistsRepo } from "../event-waitlists";
import type { PrismaClientOrTx } from "../types";

describe("makeEventWaitlistsRepo", () => {
  const createPrisma = () => {
    const waitlist = {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    };

    const prisma = {
      eventWaitlistEntry: waitlist,
    } as unknown as PrismaClientOrTx;

    return { prisma, waitlist };
  };

  it("creates waitlist entries", async () => {
    const { prisma, waitlist } = createPrisma();
    const repo = makeEventWaitlistsRepo(prisma);

    const createdAt = new Date();
    waitlist.create.mockResolvedValueOnce({
      id: "entry-1",
      eventId: "event-1",
      humanId: "human-1",
      contactEmail: "fan@example.com",
      contactPhone: null,
      source: "PUBLIC",
      status: "PENDING",
      metadata: { origin: "landing" },
      notifiedAt: null,
      convertedOrderId: null,
      createdAt,
      updatedAt: createdAt,
    });

    const entry = await repo.createEntry({
      eventId: "event-1",
      humanId: "human-1",
      contactEmail: "fan@example.com",
      source: "PUBLIC",
      metadata: { origin: "landing" },
    });

    expect(waitlist.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "event-1",
        metadata: { origin: "landing" },
      }),
    });

    expect(entry.metadata.origin).toBe("landing");
  });

  it("updates entry status", async () => {
    const { prisma, waitlist } = createPrisma();
    const repo = makeEventWaitlistsRepo(prisma);

    waitlist.update.mockResolvedValueOnce({
      id: "entry-1",
      eventId: "event-1",
      humanId: null,
      contactEmail: null,
      contactPhone: null,
      source: "PUBLIC",
      status: "NOTIFIED",
      metadata: {},
      notifiedAt: new Date("2025-01-05T00:00:00.000Z"),
      convertedOrderId: null,
      createdAt: new Date(),
      updatedAt: new Date("2025-01-05T00:00:00.000Z"),
    });

    const updated = await repo.updateEntry({
      entryId: "entry-1",
      status: "NOTIFIED",
      notifiedAt: new Date("2025-01-05T00:00:00.000Z"),
      updatedAt: new Date("2025-01-05T00:00:00.000Z"),
    });

    expect(waitlist.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: expect.objectContaining({ status: "NOTIFIED" }),
    });

    expect(updated.status).toBe("NOTIFIED");
  });

  it("replaces metadata only when the property is present", async () => {
    const { prisma, waitlist } = createPrisma();
    const repo = makeEventWaitlistsRepo(prisma);

    const row = {
      id: "entry-1",
      eventId: "event-1",
      humanId: null,
      contactEmail: null,
      contactPhone: null,
      source: "APPLICATION",
      status: "PENDING",
      metadata: { submissionId: "sub-1" },
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    waitlist.update.mockResolvedValue(row);

    // With metadata: replace semantics (caller pre-merges).
    await repo.updateEntry({
      entryId: "entry-1",
      status: "PENDING",
      metadata: { submissionId: "sub-1" },
      updatedAt: new Date("2025-01-05T00:00:00.000Z"),
    });
    expect(waitlist.update).toHaveBeenLastCalledWith({
      where: { id: "entry-1" },
      data: expect.objectContaining({ metadata: { submissionId: "sub-1" } }),
    });

    // Without metadata: the stored metadata is untouched.
    await repo.updateEntry({
      entryId: "entry-1",
      status: "DROPPED",
      updatedAt: new Date("2025-01-06T00:00:00.000Z"),
    });
    const lastData = waitlist.update.mock.calls.at(-1)![0].data;
    expect(Object.prototype.hasOwnProperty.call(lastData, "metadata")).toBe(
      false,
    );
  });

  it("lists entries with pagination", async () => {
    const { prisma, waitlist } = createPrisma();
    const repo = makeEventWaitlistsRepo(prisma);

    waitlist.findMany.mockResolvedValueOnce([
      {
        id: "entry-1",
        eventId: "event-1",
        humanId: null,
        contactEmail: "fan@example.com",
        contactPhone: null,
        source: "PUBLIC",
        status: "PENDING",
        metadata: {},
        notifiedAt: null,
        convertedOrderId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const entries = await repo.listEntries({
      eventId: "event-1",
      statuses: ["PENDING"],
      limit: 10,
    });

    expect(waitlist.findMany).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        status: { in: ["PENDING"] },
      },
      orderBy: { createdAt: "asc" },
      skip: 0,
      take: 10,
    });

    expect(entries).toHaveLength(1);
  });

  it("finds entry by contact details", async () => {
    const { prisma, waitlist } = createPrisma();
    const repo = makeEventWaitlistsRepo(prisma);

    waitlist.findFirst.mockResolvedValueOnce({
      id: "entry-2",
      eventId: "event-1",
      humanId: null,
      contactEmail: "fan@example.com",
      contactPhone: null,
      source: "PUBLIC",
      status: "PENDING",
      metadata: {},
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const entry = await repo.findEntry({
      eventId: "event-1",
      contactEmail: "fan@example.com",
    });

    expect(waitlist.findFirst).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        contactEmail: "fan@example.com",
      },
    });

    expect(entry?.contactEmail).toBe("fan@example.com");
  });
});
