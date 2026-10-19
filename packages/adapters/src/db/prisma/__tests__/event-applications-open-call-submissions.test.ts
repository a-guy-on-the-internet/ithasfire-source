/**
 * Open calls v1 step 4 — unit guards of the open-call application methods
 * (the SQL behaviour is in test/integration/event-applications-open-call-submissions.test.ts).
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeEventApplicationsRepo } from "../event-applications";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-10-05T12:00:00.000Z");

const uniqueViolationOn = (index: string) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: {
      modelName: "EventApplicationSubmission",
      driverAdapterError: {
        cause: { originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { index } },
      },
    },
  });

const submissionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "sub-1",
  formId: "form-1",
  eventId: null,
  humanId: null,
  applyingAsOrgId: null,
  guestName: "Guest",
  guestUrl: null,
  contactEmail: "g@example.com",
  contactLocale: null,
  status: "PENDING",
  answers: {},
  questionsSnapshot: {},
  isPrivate: false,
  openedAt: null,
  statusTokenHash: "h".repeat(64),
  droppedOutAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  dateChoices: [],
  ...overrides,
});

function createPrisma() {
  const submission = {
    create: vi.fn().mockResolvedValue(submissionRow()),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const choice = { deleteMany: vi.fn(), createMany: vi.fn() };
  const prisma = {
    eventApplicationSubmission: submission,
    openCallDateChoice: choice,
    entityPage: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaClientOrTx;
  return { prisma, submission, choice };
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  id: "sub-1",
  formId: "form-1",
  eventId: null,
  humanId: null,
  applyingAsOrgId: null,
  guestName: "Guest",
  guestUrl: null,
  contactEmail: "g@example.com",
  contactLocale: "es",
  answers: {},
  questionsSnapshot: {},
  isPrivate: false,
  statusTokenHash: "h".repeat(64),
  dateChoices: [{ occurrenceId: "occ-1" }],
  submittedAt: NOW,
  ...overrides,
});

describe("open-call application methods (unit guards)", () => {
  it("createOpenCallSubmission writes the choices nested, in one create", async () => {
    const { prisma, submission } = createPrisma();
    await makeEventApplicationsRepo(prisma).createOpenCallSubmission(createInput());
    const data = submission.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      id: "sub-1",
      formId: "form-1",
      eventId: null,
      contactLocale: "es",
      statusTokenHash: "h".repeat(64),
      dateChoices: { create: [{ occurrenceId: "occ-1", createdAt: NOW }] },
    });
  });

  it("refuses a missing formId / token hash and a choice with zero or two targets", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    await expect(repo.createOpenCallSubmission(createInput({ formId: "" }))).rejects.toThrow(/formId/);
    await expect(repo.createOpenCallSubmission(createInput({ id: "" }))).rejects.toThrow(/\bid is required/);
    await expect(
      repo.createOpenCallSubmission(createInput({ statusTokenHash: undefined })),
    ).rejects.toThrow(/statusTokenHash/);
    for (const bad of [{}, { occurrenceId: "o", eventDateId: "d" }, { eventId: "e" }]) {
      await expect(
        repo.createOpenCallSubmission(createInput({ dateChoices: [bad] })),
      ).rejects.toThrow(/exactly one/);
    }
    expect(submission.create).not.toHaveBeenCalled();
  });

  it("maps only the dedupe indexes' P2002 to duplicate_open_application", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.create.mockRejectedValueOnce(
      uniqueViolationOn("EventApplicationSubmission_open_human_key"),
    );
    await expect(repo.createOpenCallSubmission(createInput())).rejects.toMatchObject({
      code: "duplicate_open_application",
    });
    submission.create.mockRejectedValueOnce(
      uniqueViolationOn("EventApplicationSubmission_statusTokenHash_key"),
    );
    await expect(repo.createOpenCallSubmission(createInput())).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("every read and write is PERFORM-scoped", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    await repo.getOpenCallSubmissionById("sub-1");
    expect(submission.findFirst.mock.calls[0]![0].where).toMatchObject({
      id: "sub-1",
      form: { purpose: "PERFORM" },
    });
    await repo.withdrawPendingOpenCallSubmission({ submissionId: "sub-1", formId: "form-1" });
    // Same-table guard only (no relation filter): one UPDATE, re-checked
    // under the row lock.
    expect(submission.updateMany.mock.calls[0]![0].where).toEqual({
      id: "sub-1",
      formId: "form-1",
      status: "PENDING",
    });
    const queryRaw = (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw;
    const rawCalls = queryRaw.mock.calls;
    // Privacy: ONE statement — lock + pre-image, then the guard (not
    // WITHDRAWN, no later same-identity row); a miss answers null.
    expect(
      await repo.setOpenCallSubmissionPrivacy({
        submissionId: "sub-1",
        formId: "form-1",
        isPrivate: true,
      }),
    ).toBeNull();
    const privacy = rawCalls[0]![0] as Prisma.Sql;
    expect(privacy.sql).toMatch(/FOR UPDATE/);
    expect(privacy.sql).toMatch(/RETURNING pre\."isPrivate" AS "wasPrivate"/);
    expect(privacy.sql).toMatch(/<> 'WITHDRAWN'/);
    expect(privacy.sql).toMatch(/NOT EXISTS/);
    expect(privacy.sql).toMatch(/n\."id" COLLATE "C" > t\."id" COLLATE "C"/);
    expect(privacy.values).toEqual(["sub-1", "form-1", true]);
    expect(submission.updateMany).toHaveBeenCalledTimes(1);
    expect(await repo.isLatestOpenCallSubmission({ submissionId: "sub-1", formId: "form-1" })).toBe(
      false,
    );
    const latest = rawCalls[1]![0] as Prisma.Sql;
    expect(latest.sql).toMatch(/'PERFORM'::"ApplicationFormPurpose"/);
    expect(latest.values).toEqual(["sub-1", "form-1"]);
    queryRaw.mockClear();
    await repo.listOpenCallPeers({
      formId: "form-1",
      viewer: { humanId: "h-1", applyingAsOrgId: null, contactEmail: null },
      limit: 10,
    });
    // The peer query is raw SQL (one row per identity: its LATEST row, with
    // privacy / withdrawn judged on that row, ordered by its first): every
    // filter and the viewer key are bind values, the PERFORM join and
    // filters are in it.
    const sql = (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw.mock
      .calls[0]![0] as Prisma.Sql;
    expect(sql.sql).toMatch(
      /PARTITION BY k\.key ORDER BY s\."createdAt" DESC, s\."id" COLLATE "C" DESC/,
    );
    expect(sql.sql).toMatch(/x\.key COLLATE "C" ASC/);
    expect(sql.sql).toMatch(/MIN\(s\."createdAt"\) OVER \(PARTITION BY k\.key\)/);
    expect(sql.sql).toMatch(/x\.rn = 1/);
    expect(sql.sql).toMatch(/'PERFORM'::"ApplicationFormPurpose"/);
    expect(sql.sql).toMatch(/"isPrivate" = false/);
    expect(sql.sql).toMatch(/<> 'WITHDRAWN'/);
    expect(sql.values).toEqual(expect.arrayContaining(["form-1", "human:h-1", 10]));
    await expect(repo.getOpenCallSubmissionById("")).rejects.toThrow(/submissionId/);
  });

  it("the token lookup answers null for an ATTEND row", async () => {
    const { prisma, submission } = createPrisma();
    submission.findUnique.mockResolvedValueOnce({ ...submissionRow(), form: { purpose: "ATTEND" } });
    expect(
      await makeEventApplicationsRepo(prisma).getOpenCallSubmissionByTokenHash("h".repeat(64)),
    ).toBeNull();
  });

  it("an edit whose guard misses touches no date choices", async () => {
    const { prisma, submission, choice } = createPrisma();
    const out = await makeEventApplicationsRepo(prisma).updateOpenCallSubmission({
      submissionId: "sub-1",
      formId: "form-1",
      answers: {},
      questionsSnapshot: {},
      isPrivate: true,
      dateChoices: [{ eventDateId: "d-1" }],
    });
    expect(out).toBeNull();
    expect(submission.updateMany.mock.calls[0]![0].where).toEqual({
      id: "sub-1",
      formId: "form-1",
      status: "PENDING",
      openedAt: null,
    });
    expect(choice.deleteMany).not.toHaveBeenCalled();
    expect(choice.createMany).not.toHaveBeenCalled();
  });
});
