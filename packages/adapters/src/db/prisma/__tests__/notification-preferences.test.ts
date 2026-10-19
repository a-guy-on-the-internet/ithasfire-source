import { describe, expect, it, vi } from "vitest";

import { makeNotificationPreferencesRepo } from "../notification-preferences";
import type { PrismaClientOrTx } from "../types";

describe("makeNotificationPreferencesRepo.batchReadAnnouncementEmailEnabled", () => {
  const ORG_ID = "org-1";

  const createPrisma = (
    rows: Array<{ humanId: string; delta: unknown }>,
  ) => {
    const findMany = vi.fn(async () => rows);
    const notificationPreference = {
      findMany,
      findUnique: vi.fn(),
      upsert: vi.fn(),
    };
    const prisma = {
      notificationPreference,
    } as unknown as PrismaClientOrTx;
    return { prisma, findMany };
  };

  it("returns enabled for humans with no overriding rows", async () => {
    const { prisma } = createPrisma([]);
    const repo = makeNotificationPreferencesRepo(prisma);

    const result = await repo.batchReadAnnouncementEmailEnabled({
      humanIds: ["h1", "h2"],
      orgId: ORG_ID,
    });

    expect(result.get("h1")).toBe(true);
    expect(result.get("h2")).toBe(true);
  });

  it("disables a human whose GLOBAL pref turns off email announcements", async () => {
    const { prisma } = createPrisma([
      {
        humanId: "h1",
        delta: { channels: { email: { announcements: false } } },
      },
    ]);
    const repo = makeNotificationPreferencesRepo(prisma);

    const result = await repo.batchReadAnnouncementEmailEnabled({
      humanIds: ["h1", "h2"],
      orgId: ORG_ID,
    });

    expect(result.get("h1")).toBe(false);
    expect(result.get("h2")).toBe(true);
  });

  it("disables a human whose ORG pref turns off email announcements", async () => {
    const { prisma } = createPrisma([
      {
        humanId: "h3",
        delta: { channels: { email: { announcements: false } } },
      },
    ]);
    const repo = makeNotificationPreferencesRepo(prisma);

    const result = await repo.batchReadAnnouncementEmailEnabled({
      humanIds: ["h3"],
      orgId: ORG_ID,
    });

    expect(result.get("h3")).toBe(false);
  });

  it("keeps a human enabled when only an unrelated category is disabled", async () => {
    const { prisma } = createPrisma([
      {
        humanId: "h1",
        delta: { channels: { email: { marketing: false } } },
      },
    ]);
    const repo = makeNotificationPreferencesRepo(prisma);

    const result = await repo.batchReadAnnouncementEmailEnabled({
      humanIds: ["h1"],
      orgId: ORG_ID,
    });

    expect(result.get("h1")).toBe(true);
  });

  it("returns an empty map for no humanIds without querying", async () => {
    const { prisma, findMany } = createPrisma([]);
    const repo = makeNotificationPreferencesRepo(prisma);

    const result = await repo.batchReadAnnouncementEmailEnabled({
      humanIds: [],
      orgId: ORG_ID,
    });

    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the query to GLOBAL or ORG(orgId) rows for the given humans", async () => {
    const { prisma, findMany } = createPrisma([]);
    const repo = makeNotificationPreferencesRepo(prisma);

    await repo.batchReadAnnouncementEmailEnabled({
      humanIds: ["h1", "h2"],
      orgId: ORG_ID,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          humanId: { in: ["h1", "h2"] },
          OR: [
            { scopeKind: "GLOBAL" },
            { scopeKind: "ORG", orgId: ORG_ID },
          ],
        }),
      }),
    );
  });
});
