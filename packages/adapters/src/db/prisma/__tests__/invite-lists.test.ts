import { describe, expect, it, vi } from "vitest";

import { makeInviteListsRepo } from "../invite-lists";
import type { PrismaClientOrTx } from "../types";

describe("makeInviteListsRepo", () => {
  const createPrisma = () => {
    const inviteList = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    };

    const inviteListEntry = {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
    };

    const eventInviteList = {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    };

    const prisma = {
      inviteList,
      inviteListEntry,
      eventInviteList,
    } as unknown as PrismaClientOrTx;

    return {
      prisma,
      inviteList,
      inviteListEntry,
      eventInviteList,
    };
  };

  it("creates invite lists", async () => {
    const { prisma, inviteList } = createPrisma();
    const repo = makeInviteListsRepo(prisma);

    const now = new Date();
    inviteList.create.mockResolvedValueOnce({
      id: "list-1",
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      name: "VIP",
      description: null,
      passwordHint: null,
      createdAt: now,
      updatedAt: now,
    });

    const record = await repo.createList({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      name: "VIP",
    });

    expect(inviteList.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "VIP" }),
    });

    expect(record.name).toBe("VIP");
  });

  it("updates entries with metadata", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);

    inviteListEntry.updateMany.mockResolvedValueOnce({ count: 1 });
    inviteListEntry.findFirst.mockResolvedValueOnce({
      id: "entry-1",
      inviteListId: "list-1",
      humanId: null,
      contactEmail: "fan@example.com",
      contactPhone: null,
      displayName: "Fan",
      notes: null,
      tags: ["vip"],
      lastInvitedAt: null,
      metadata: { note: "from gsheet" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const entry = await repo.updateEntry({
      entryId: "entry-1",
      inviteListId: "list-1",
      tags: ["vip"],
      metadata: { note: "from gsheet" },
    });

    expect(inviteListEntry.updateMany).toHaveBeenCalledWith({
      where: { id: "entry-1", inviteListId: "list-1" },
      data: expect.objectContaining({ tags: ["vip"] }),
    });

    expect(entry?.tags).toContain("vip");
  });

  // Security review F9 (2026-09-29): entry writes are scoped to the list, so
  // an entry id from another owner's list matches nothing.
  it("updateEntry returns null when the entry is not in the list", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);
    inviteListEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    const entry = await repo.updateEntry({
      entryId: "entry-1",
      inviteListId: "someone-elses-list",
      contactEmail: "attacker@example.com",
    });

    expect(entry).toBeNull();
    expect(inviteListEntry.update).not.toHaveBeenCalled();
    expect(inviteListEntry.findFirst).not.toHaveBeenCalled();
  });

  it("getEntry is scoped to the list", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);
    inviteListEntry.findFirst.mockResolvedValueOnce(null);

    await expect(
      repo.getEntry({ entryId: "entry-1", inviteListId: "other-list" }),
    ).resolves.toBeNull();
    expect(inviteListEntry.findFirst).toHaveBeenCalledWith({
      where: { id: "entry-1", inviteListId: "other-list" },
    });
  });

  it("updateEntry writes consent fields only when given", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);
    const at = new Date("2026-09-29T00:00:00.000Z");
    inviteListEntry.updateMany.mockResolvedValue({ count: 1 });
    inviteListEntry.findFirst.mockResolvedValue(null);

    await repo.updateEntry({
      entryId: "entry-1",
      inviteListId: "list-1",
      contactEmail: "new@example.com",
      consentSource: "manual_entry",
      consentRecordedAt: at,
    });
    await repo.updateEntry({
      entryId: "entry-1",
      inviteListId: "list-1",
      displayName: "Fan",
    });

    expect(inviteListEntry.updateMany.mock.calls[0]![0].data).toMatchObject({
      consentSource: "manual_entry",
      consentRecordedAt: at,
    });
    expect(inviteListEntry.updateMany.mock.calls[1]![0].data).not.toHaveProperty(
      "consentSource",
    );
  });

  it("deleteEntry is scoped to the list and reports whether a row went", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);
    inviteListEntry.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      repo.deleteEntry({ entryId: "entry-1", inviteListId: "list-1" }),
    ).resolves.toEqual({ deleted: true });
    await expect(
      repo.deleteEntry({ entryId: "entry-1", inviteListId: "other-list" }),
    ).resolves.toEqual({ deleted: false });

    expect(inviteListEntry.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { id: "entry-1", inviteListId: "list-1" },
    });
    expect(inviteListEntry.delete).not.toHaveBeenCalled();
  });

  it("lists entries with search", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);

    inviteListEntry.findMany.mockResolvedValueOnce([
      {
        id: "entry-1",
        inviteListId: "list-1",
        humanId: null,
        contactEmail: "fan@example.com",
        contactPhone: null,
        displayName: "Fan",
        notes: null,
        tags: [],
        lastInvitedAt: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const entries = await repo.listEntries({
      inviteListId: "list-1",
      search: "fan",
    });

    expect(inviteListEntry.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            displayName: expect.objectContaining({ contains: "fan" }),
          }),
        ]),
      }),
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 50,
    });

    expect(entries).toHaveLength(1);
  });

  it("copies invite list entries", async () => {
    const { prisma, inviteListEntry } = createPrisma();
    const repo = makeInviteListsRepo(prisma);

    inviteListEntry.findMany.mockResolvedValueOnce([
      {
        id: "entry-1",
        inviteListId: "list-1",
        humanId: null,
        contactEmail: "fan@example.com",
        contactPhone: null,
        displayName: "Fan",
        notes: null,
        tags: ["vip"],
        lastInvitedAt: null,
        metadata: { source: "import" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    inviteListEntry.createMany.mockResolvedValueOnce({ count: 1 });

    const count = await repo.copyEntries({
      sourceInviteListId: "list-1",
      targetInviteListId: "list-2",
      performedByHumanId: "human-1",
    });

    expect(inviteListEntry.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ inviteListId: "list-2", tags: ["vip"] }),
      ]),
      skipDuplicates: true,
    });

    expect(count).toBe(1);
  });

  it("attaches invite lists to events", async () => {
    const { prisma, eventInviteList } = createPrisma();
    const repo = makeInviteListsRepo(prisma);

    const now = new Date();
    eventInviteList.create.mockResolvedValueOnce({
      id: "link-1",
      eventId: "event-1",
      inviteListId: "list-1",
      context: { channel: "sms" },
      createdAt: now,
    });

    const link = await repo.attachToEvent({
      eventId: "event-1",
      inviteListId: "list-1",
      context: { channel: "sms" },
    });

    expect(eventInviteList.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventId: "event-1" }),
    });

    expect(link.context.channel).toBe("sms");
  });
});
