import { describe, expect, it, vi } from "vitest";

import { makeEventApplicationsRepo } from "../event-applications";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-10-05T12:00:00.000Z");

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "form-1",
  eventId: "event-1",
  seriesId: null,
  purpose: "PERFORM",
  publicId: "abc123defg",
  introText: null,
  defaults: {},
  opensAt: null,
  closesAt: null,
  maxSubmissions: null,
  autoApprove: false,
  payKind: "FIXED",
  payDetails: "$100",
  closedAt: null,
  closedByHumanId: null,
  postedAt: null,
  postedByHumanId: null,
  updatedByHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

function createPrisma() {
  const form = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    update: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const submission = {
    updateManyAndReturn: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  };
  const prisma = {
    eventApplicationForm: form,
    eventApplicationSubmission: submission,
    eventApplicationQuestion: {},
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  return { prisma, form, submission, repo: makeEventApplicationsRepo(prisma as unknown as PrismaClientOrTx) };
}

describe("event-applications open-call methods", () => {
  it("getOpenCall keys by (anchor, PERFORM)", async () => {
    const { form, repo } = createPrisma();
    form.findUnique.mockResolvedValueOnce(row());
    await repo.getOpenCall({ kind: "event", eventId: "event-1" });
    expect(form.findUnique).toHaveBeenLastCalledWith({
      where: { eventId_purpose: { eventId: "event-1", purpose: "PERFORM" } },
    });
    form.findUnique.mockResolvedValueOnce(row({ eventId: null, seriesId: "series-1" }));
    const series = await repo.getOpenCall({ kind: "series", seriesId: "series-1" });
    expect(form.findUnique).toHaveBeenLastCalledWith({
      where: { seriesId_purpose: { seriesId: "series-1", purpose: "PERFORM" } },
    });
    expect(series).toMatchObject({ seriesId: "series-1", eventId: null, purpose: "PERFORM" });
  });

  it("throws on a missing anchor instead of querying 'any form'", async () => {
    const { form, repo } = createPrisma();
    await expect(
      repo.getOpenCall({ kind: "event" } as never),
    ).rejects.toThrow(/anchor is required/);
    await expect(repo.getOpenCallById(undefined as never)).rejects.toThrow(/formId is required/);
    expect(form.findUnique).not.toHaveBeenCalled();
    expect(form.findFirst).not.toHaveBeenCalled();
  });

  it("by id / publicId filters PERFORM, and a stray ATTEND row would throw in the mapper", async () => {
    const { form, repo } = createPrisma();
    form.findFirst.mockResolvedValueOnce(null);
    expect(await repo.getOpenCallById("form-2")).toBeNull();
    expect(form.findFirst).toHaveBeenLastCalledWith({
      where: { id: "form-2", purpose: "PERFORM" },
    });
    form.findFirst.mockResolvedValueOnce(row({ purpose: "ATTEND" }));
    await expect(repo.getOpenCallById("form-2")).rejects.toThrow(/not an open call/);
  });

  it("getOpenCallByPublicId derives ownerBanned from the withheld set", async () => {
    const { prisma, form, repo } = createPrisma();
    form.findFirst.mockResolvedValue({
      ...row(),
      event: { humanId: null, orgId: "org-1" },
      series: null,
    });
    prisma.$queryRaw.mockResolvedValueOnce([{ kind: "ORG", id: "org-1" }]);
    const banned = await repo.getOpenCallByPublicId("abc123defg");
    expect(banned).toMatchObject({ id: "form-1", ownerBanned: true });
    expect(banned).not.toHaveProperty("event");
    expect(form.findFirst.mock.calls[0]![0].where).toEqual({
      publicId: "abc123defg",
      purpose: "PERFORM",
    });

    prisma.$queryRaw.mockResolvedValueOnce([]);
    expect((await repo.getOpenCallByPublicId("abc123defg"))?.ownerBanned).toBe(false);

    form.findFirst.mockResolvedValueOnce({
      ...row({ eventId: null, seriesId: "s-1" }),
      event: null,
      series: { ownerScope: "HUMAN", ownerId: "h-1" },
    });
    prisma.$queryRaw.mockResolvedValueOnce([{ kind: "HUMAN", id: "h-1" }]);
    expect((await repo.getOpenCallByPublicId("abc123defg"))?.ownerBanned).toBe(true);
  });

  it("upsertOpenCall creates a PERFORM row with a fresh publicId and presence-guarded update", async () => {
    const { form, repo } = createPrisma();
    form.upsert.mockResolvedValueOnce(row({ eventId: null, seriesId: "series-1" }));
    await repo.upsertOpenCall({
      anchor: { kind: "series", seriesId: "series-1" },
      payKind: "FIXED",
      payDetails: "$100",
      updatedByHumanId: "h-1",
    });
    const call = form.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({
      seriesId_purpose: { seriesId: "series-1", purpose: "PERFORM" },
    });
    expect(call.create).toMatchObject({
      seriesId: "series-1",
      purpose: "PERFORM",
      payKind: "FIXED",
      payDetails: "$100",
    });
    expect(call.create.publicId).toMatch(/^[a-z0-9]{10}$/);
    expect(call.create).not.toHaveProperty("eventId");
    // Only supplied fields are updated.
    expect(call.update).toEqual({
      updatedByHumanId: "h-1",
      payKind: "FIXED",
      payDetails: "$100",
    });
  });

  it("lockOpenCallForClose / ForSubmit lock the row, then read it", async () => {
    const { prisma, form, repo } = createPrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: "form-1" }]);
    form.findUnique.mockResolvedValueOnce(row());
    expect(await repo.lockOpenCallForClose("form-1")).toMatchObject({ id: "form-1" });
    const sql = (prisma.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/FOR UPDATE/);
    expect(prisma.$queryRaw.mock.calls[0]![1]).toBe("form-1");

    prisma.$queryRaw.mockResolvedValueOnce([{ id: "form-1" }]);
    form.findUnique.mockResolvedValueOnce(row());
    await repo.lockOpenCallForSubmit("form-1");
    const shareSql = (prisma.$queryRaw.mock.calls[1]![0] as TemplateStringsArray).join("?");
    expect(shareSql).toMatch(/FOR KEY SHARE/);

    prisma.$queryRaw.mockResolvedValueOnce([]);
    expect(await repo.lockOpenCallForClose("attend-form")).toBeNull();
  });

  it("rejectPendingOpenCallSubmissions flips PENDING only and returns ids", async () => {
    const { submission, repo } = createPrisma();
    submission.updateManyAndReturn.mockResolvedValueOnce([{ id: "s1" }, { id: "s2" }]);
    const out = await repo.rejectPendingOpenCallSubmissions({ formId: "form-1", reviewedAt: NOW });
    expect(out).toEqual({ ids: ["s1", "s2"] });
    expect(submission.updateManyAndReturn).toHaveBeenCalledWith({
      where: { formId: "form-1", status: "PENDING" },
      data: { status: "REJECTED", reviewedAt: NOW },
      select: { id: true },
    });
  });

  it("setOpenCallClosed writes only the close columns on a PERFORM row", async () => {
    const { form, repo } = createPrisma();
    form.update.mockResolvedValueOnce(row({ closedAt: NOW, closedByHumanId: "h-1" }));
    await repo.setOpenCallClosed({ formId: "form-1", closedAt: NOW, closedByHumanId: "h-1" });
    expect(form.update).toHaveBeenCalledWith({
      where: { id: "form-1", purpose: "PERFORM" },
      data: { closedAt: NOW, closedByHumanId: "h-1" },
    });
  });

  it("setOpenCallPosted stamps postedAt / postedByHumanId on a PERFORM row and maps them", async () => {
    const { form, repo } = createPrisma();
    form.update.mockResolvedValueOnce(row({ postedAt: NOW, postedByHumanId: "h-1" }));
    const out = await repo.setOpenCallPosted({ formId: "form-1", postedAt: NOW, postedByHumanId: "h-1" });
    expect(form.update).toHaveBeenCalledWith({
      where: { id: "form-1", purpose: "PERFORM" },
      data: { postedAt: NOW, postedByHumanId: "h-1" },
    });
    expect(out).toMatchObject({ postedAt: NOW, postedByHumanId: "h-1" });
  });

  it("deleteOpenCallDraft deletes only an unposted PERFORM row with no submissions", async () => {
    const { form, repo } = createPrisma();
    form.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await repo.deleteOpenCallDraft("form-1")).toBe(true);
    expect(form.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "form-1",
        purpose: "PERFORM",
        postedAt: null,
        submissions: { none: {} },
      },
    });
    form.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.deleteOpenCallDraft("form-1")).toBe(false);
  });

  it("listOpenCallsByPoster lists posted calls only", async () => {
    const { prisma, form, repo } = createPrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await repo.listOpenCallsByPoster({ poster: { kind: "org", orgId: "org-1" }, now: NOW, limit: 5 });
    expect(form.findMany.mock.calls[0]![0].where).toMatchObject({
      purpose: "PERFORM",
      postedAt: { not: null },
      closedAt: null,
    });
  });

  it("listOpenCallsByPoster returns nothing for a banned poster without listing", async () => {
    const { prisma, form, repo } = createPrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ kind: "ORG", id: "org-1" }]);
    expect(
      await repo.listOpenCallsByPoster({ poster: { kind: "org", orgId: "org-1" }, now: NOW, limit: 5 }),
    ).toEqual([]);
    expect(form.findMany).not.toHaveBeenCalled();
  });
});
