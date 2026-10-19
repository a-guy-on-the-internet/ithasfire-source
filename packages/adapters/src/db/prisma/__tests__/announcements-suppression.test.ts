import { describe, expect, it, vi } from "vitest";

import { makeAnnouncementsRepo } from "../announcements";
import type { PrismaClientOrTx } from "../types";

describe("makeAnnouncementsRepo — anonymous suppression", () => {
  const createPrisma = () => {
    const anonymousEmailSuppression = {
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [] as Array<{ email: string }>),
    };
    const prisma = {
      anonymousEmailSuppression,
    } as unknown as PrismaClientOrTx;
    return { prisma, anonymousEmailSuppression };
  };

  it("insertAnonymousSuppression lowercases the email and upserts idempotently", async () => {
    const { prisma, anonymousEmailSuppression } = createPrisma();
    const repo = makeAnnouncementsRepo(prisma);

    await repo.insertAnonymousSuppression({
      email: "Jane@Example.COM",
      orgId: "org-1",
    });

    expect(anonymousEmailSuppression.upsert).toHaveBeenCalledWith({
      where: { email_orgId: { email: "jane@example.com", orgId: "org-1" } },
      create: {
        email: "jane@example.com",
        orgId: "org-1",
        reason: "unsubscribe",
      },
      update: {},
    });
  });

  it("getAnonymousSuppressedEmails returns a lowercased set of matches", async () => {
    const { prisma, anonymousEmailSuppression } = createPrisma();
    anonymousEmailSuppression.findMany.mockResolvedValueOnce([
      { email: "blocked@example.com" },
    ]);
    const repo = makeAnnouncementsRepo(prisma);

    const result = await repo.getAnonymousSuppressedEmails({
      orgId: "org-1",
      emails: ["Blocked@Example.com", "ok@example.com"],
    });

    expect(anonymousEmailSuppression.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        email: { in: ["blocked@example.com", "ok@example.com"] },
      },
      select: { email: true },
    });
    expect(result.has("blocked@example.com")).toBe(true);
    expect(result.has("ok@example.com")).toBe(false);
  });

  it("getAnonymousSuppressedEmails short-circuits on empty input", async () => {
    const { prisma, anonymousEmailSuppression } = createPrisma();
    const repo = makeAnnouncementsRepo(prisma);

    const result = await repo.getAnonymousSuppressedEmails({
      orgId: "org-1",
      emails: [],
    });

    expect(result.size).toBe(0);
    expect(anonymousEmailSuppression.findMany).not.toHaveBeenCalled();
  });
});
