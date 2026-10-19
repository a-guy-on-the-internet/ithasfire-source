import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeEventApplicationsRepo } from "../event-applications";
import type { PrismaClientOrTx } from "../types";

describe("makeEventApplicationsRepo", () => {
  const FORM_PURPOSE_INCLUDE = { form: { select: { purpose: true } } };

  const createPrisma = () => {
    const form = {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    };

    const question = {
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    };

    const submission = {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    };

    const prisma = {
      eventApplicationForm: form,
      eventApplicationQuestion: question,
      eventApplicationSubmission: submission,
    } as unknown as PrismaClientOrTx;

    return {
      prisma,
      form,
      question,
      submission,
    };
  };

  it("upserts forms and coerces defaults", async () => {
    const { prisma, form } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const now = new Date("2025-01-01T10:00:00.000Z");
    form.upsert.mockResolvedValueOnce({
      id: "form-1",
      eventId: "event-1",
      introText: "Tell us about you",
      defaults: { includeName: true },
      updatedByHumanId: "human-1",
      createdAt: now,
      updatedAt: now,
    });

    const result = await repo.upsertForm({
      eventId: "event-1",
      purpose: "ATTEND",
      introText: "Tell us about you",
      defaults: {
        includeName: true,
        includeReason: false,
        includeSocialLinks: false,
      },
      updatedByHumanId: "human-1",
    });

    expect(form.upsert).toHaveBeenCalledWith({
      // Keyed by (eventId, purpose): the event may also hold a PERFORM form.
      where: { eventId_purpose: { eventId: "event-1", purpose: "ATTEND" } },
      update: expect.objectContaining({
        introText: "Tell us about you",
        defaults: expect.any(Object),
      }),
      create: expect.objectContaining({
        eventId: "event-1",
        purpose: "ATTEND",
        // Minted at create: 10-char base-36, the Event.shortId shape.
        publicId: expect.stringMatching(/^[0-9a-z]{10}$/),
        defaults: expect.any(Object),
      }),
    });
    // The update branch never re-mints the public id or moves the purpose.
    const update = form.upsert.mock.calls[0]![0].update as object;
    expect("publicId" in update).toBe(false);
    expect("purpose" in update).toBe(false);

    expect(result.defaults.includeName).toBe(true);
  });

  it("creates and updates questions", async () => {
    const { prisma, question } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    question.create.mockResolvedValueOnce({
      id: "question-1",
      formId: "form-1",
      type: "SHORT_TEXT",
      label: "Favorite artist",
      description: null,
      options: null,
      isRequired: true,
      order: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const created = await repo.upsertQuestion({
      formId: "form-1",
      type: "SHORT_TEXT",
      label: "Favorite artist",
      isRequired: true,
      order: 1,
    });

    expect(created.label).toBe("Favorite artist");

    question.update.mockResolvedValueOnce({
      ...created,
      description: "Required for curation",
      options: [{ id: "opt-1", label: "Yes" }],
    });

    const updated = await repo.upsertQuestion({
      questionId: created.id,
      formId: "form-1",
      type: "SINGLE_CHOICE",
      label: "VIP",
      description: "Required for curation",
      options: [{ id: "opt-1", label: "Yes" }],
    });

    expect(question.update).toHaveBeenCalledWith({
      where: { id: created.id },
      data: expect.objectContaining({
        type: "SINGLE_CHOICE",
        label: "VIP",
      }),
    });

    expect(updated.options?.[0]?.label).toBe("Yes");
  });

  it("creates submissions and maps answers", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const submittedAt = new Date("2025-01-02T00:00:00.000Z");
    submission.create.mockResolvedValueOnce({
      id: "submission-1",
      eventId: "event-1",
      formId: "form-1",
      form: { purpose: "ATTEND" },
      humanId: "human-5",
      contactEmail: "fan@example.com",
      contactPhone: null,
      status: "PENDING",
      answers: { reason: "vip" },
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      metadata: {},
      createdAt: submittedAt,
      updatedAt: submittedAt,
    });

    const record = await repo.createSubmission({
      formId: "form-1",
      eventId: "event-1",
      humanId: "human-5",
      contactEmail: "fan@example.com",
      answers: { reason: "vip" },
      submittedAt,
    });

    expect(submission.create).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      data: expect.objectContaining({
        formId: "form-1",
        eventId: "event-1",
        answers: { reason: "vip" },
        // No snapshot provided → defaults to {}, never null/undefined.
        questionsSnapshot: {},
      }),
    });

    expect(record.answers.reason).toBe("vip");
    // Legacy row (no questionsSnapshot / decisionReason columns in the mock
    // payload) coerces to safe defaults instead of leaking undefined.
    expect(record.questionsSnapshot).toEqual({});
    expect(record.decisionReason).toBeNull();
  });

  it("persists the questions snapshot and maps it back", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const submittedAt = new Date("2025-01-02T00:00:00.000Z");
    const questionsSnapshot = {
      "q-1": {
        label: "Set length",
        type: "SINGLE_CHOICE" as const,
        options: [{ id: "opt-1", label: "15 min" }],
      },
    };
    submission.create.mockResolvedValueOnce({
      id: "submission-1",
      eventId: "event-1",
      formId: "form-1",
      form: { purpose: "ATTEND" },
      humanId: "human-5",
      contactEmail: "fan@example.com",
      contactPhone: null,
      status: "PENDING",
      answers: {},
      decisionReason: null,
      questionsSnapshot,
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      metadata: {},
      createdAt: submittedAt,
      updatedAt: submittedAt,
    });

    const record = await repo.createSubmission({
      formId: "form-1",
      eventId: "event-1",
      humanId: "human-5",
      contactEmail: "fan@example.com",
      answers: {},
      questionsSnapshot,
      submittedAt,
    });

    expect(submission.create).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      data: expect.objectContaining({ questionsSnapshot }),
    });
    expect(record.questionsSnapshot).toEqual(questionsSnapshot);
  });

  it("updates submission status and tokens", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const updatedAt = new Date("2025-01-03T00:00:00.000Z");
    submission.update.mockResolvedValueOnce({
      id: "submission-1",
      eventId: "event-1",
      formId: "form-1",
      form: { purpose: "ATTEND" },
      humanId: "human-5",
      contactEmail: "fan@example.com",
      contactPhone: null,
      status: "APPROVED",
      answers: { reason: "vip" },
      reviewerHumanId: "reviewer-1",
      reviewedAt: updatedAt,
      approvalToken: "token-abc",
      tokenExpiresAt: new Date("2025-01-05T00:00:00.000Z"),
      metadata: {},
      createdAt: new Date("2025-01-02T00:00:00.000Z"),
      updatedAt,
    });

    const record = await repo.updateSubmissionStatus({
      submissionId: "submission-1",
      status: "APPROVED",
      reviewerHumanId: "reviewer-1",
      reviewedAt: updatedAt,
      approvalToken: "token-abc",
      tokenExpiresAt: new Date("2025-01-05T00:00:00.000Z"),
    });

    expect(submission.update).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      where: { id: "submission-1" },
      data: expect.objectContaining({
        status: "APPROVED",
        approvalToken: "token-abc",
      }),
    });
    // decisionReason omitted from the input → hasOwnProperty gate keeps it
    // out of the update payload entirely (no accidental null-clobber).
    expect(
      "decisionReason" in
        (submission.update.mock.calls[0]![0] as { data: object }).data,
    ).toBe(false);

    expect(record.status).toBe("APPROVED");
  });

  it("writes decisionReason only when the property is present", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const updatedAt = new Date("2025-01-03T00:00:00.000Z");
    submission.update.mockResolvedValueOnce({
      id: "submission-1",
      eventId: "event-1",
      formId: "form-1",
      form: { purpose: "ATTEND" },
      humanId: "human-5",
      contactEmail: "fan@example.com",
      contactPhone: null,
      status: "REJECTED",
      answers: {},
      decisionReason: "Full lineup already",
      questionsSnapshot: {},
      reviewerHumanId: "reviewer-1",
      reviewedAt: updatedAt,
      approvalToken: null,
      tokenExpiresAt: null,
      metadata: {},
      createdAt: new Date("2025-01-02T00:00:00.000Z"),
      updatedAt,
    });

    const record = await repo.updateSubmissionStatus({
      submissionId: "submission-1",
      status: "REJECTED",
      reviewerHumanId: "reviewer-1",
      reviewedAt: updatedAt,
      approvalToken: null,
      tokenExpiresAt: null,
      decisionReason: "Full lineup already",
    });

    expect(submission.update).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      where: { id: "submission-1" },
      data: expect.objectContaining({
        status: "REJECTED",
        decisionReason: "Full lineup already",
      }),
    });
    expect(record.decisionReason).toBe("Full lineup already");
  });

  it("lists submissions with filters", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.findMany.mockResolvedValueOnce([
      {
        id: "submission-1",
        eventId: "event-1",
        formId: "form-1",
        form: { purpose: "ATTEND" },
        humanId: null,
        contactEmail: null,
        contactPhone: null,
        status: "PENDING",
        answers: {},
        reviewerHumanId: null,
        reviewedAt: null,
        approvalToken: null,
        tokenExpiresAt: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const results = await repo.listSubmissions({
      eventId: "event-1",
      purpose: "ATTEND",
      statuses: ["PENDING"],
    });

    expect(submission.findMany).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      where: {
        eventId: "event-1",
        form: { purpose: "ATTEND" },
        status: { in: ["PENDING"] },
      },
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 50,
    });

    // repo now returns a paginated result
    expect(results.items).toHaveLength(1);
  });

  it("guards updateSubmissionStatus with expectedFromStatuses (CAS via updateMany + re-read)", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.updateMany.mockResolvedValueOnce({ count: 1 });
    submission.findUniqueOrThrow.mockResolvedValueOnce({
      id: "submission-1",
      eventId: "event-1",
      formId: "form-1",
      form: { purpose: "ATTEND" },
      humanId: "human-1",
      contactEmail: null,
      contactPhone: null,
      status: "WITHDRAWN",
      answers: {},
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const record = await repo.updateSubmissionStatus({
      submissionId: "submission-1",
      status: "WITHDRAWN",
      approvalToken: null,
      tokenExpiresAt: null,
      expectedFromStatuses: ["PENDING"],
    });

    // The WHERE re-checks the current status inside the write.
    expect(submission.updateMany).toHaveBeenCalledWith({
      where: { id: "submission-1", status: { in: ["PENDING"] } },
      data: expect.objectContaining({
        status: "WITHDRAWN",
        approvalToken: null,
        tokenExpiresAt: null,
      }),
    });
    expect(submission.update).not.toHaveBeenCalled();
    expect(record.status).toBe("WITHDRAWN");
  });

  it("throws a conflict use-case error when the status guard misses", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      repo.updateSubmissionStatus({
        submissionId: "submission-1",
        status: "WITHDRAWN",
        expectedFromStatuses: ["PENDING"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "application_submission_status_changed",
    });
    expect(submission.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("counts submissions with a status filter (dedicated COUNT, no list)", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.count.mockResolvedValueOnce(4);

    const count = await repo.countSubmissions({
      eventId: "event-1",
      purpose: "ATTEND",
      statuses: ["PENDING", "APPROVED", "REJECTED", "WAITLISTED"],
    });

    expect(submission.count).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        form: { purpose: "ATTEND" },
        status: { in: ["PENDING", "APPROVED", "REJECTED", "WAITLISTED"] },
      },
    });
    expect(count).toBe(4);
  });

  it("counts all submissions when no status filter is given", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.count.mockResolvedValueOnce(7);

    const count = await repo.countSubmissions({
      eventId: "event-1",
      purpose: "ATTEND",
    });

    expect(submission.count).toHaveBeenCalledWith({
      where: { eventId: "event-1", form: { purpose: "ATTEND" } },
    });
    expect(count).toBe(7);
  });

  it("expires PENDING submissions of closed forms with a strict-lt cutoff and a guarded write", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const cutoff = new Date("2026-08-04T03:00:00Z");
    submission.findMany.mockResolvedValueOnce([
      { id: "sub-1" },
      { id: "sub-2" },
    ]);
    submission.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await repo.expireSubmissionsForClosedForms({
      cutoff,
      purpose: "ATTEND",
    });

    // Strict `lt`: a form whose closesAt equals the cutoff is not yet past
    // the grace window. Through the submission's OWN form, ATTEND only: an
    // open call (PERFORM) never auto-closes (open calls Q12 / FR-004).
    expect(submission.findMany).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        form: { purpose: "ATTEND", closesAt: { lt: cutoff } },
      },
      select: { id: true },
    });
    // Guarded write: status re-checked so a concurrent review/withdraw
    // between read and write is never clobbered — hence count may be less
    // than the candidate ids.
    expect(submission.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-1", "sub-2"] }, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    expect(result).toEqual({ count: 1, ids: ["sub-1", "sub-2"] });
  });

  it("short-circuits the expiry write when nothing is due", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.findMany.mockResolvedValueOnce([]);

    const result = await repo.expireSubmissionsForClosedForms({
      cutoff: new Date(),
      purpose: "ATTEND",
    });

    expect(submission.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0, ids: [] });
  });

  it("maps the Phase-2 window/cap/autoApprove form columns", async () => {
    const { prisma, form } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    const opensAt = new Date("2026-08-01T00:00:00Z");
    const closesAt = new Date("2026-08-20T00:00:00Z");
    form.findUnique.mockResolvedValueOnce({
      id: "form-1",
      eventId: "event-1",
      introText: null,
      defaults: {},
      opensAt,
      closesAt,
      maxSubmissions: 25,
      autoApprove: true,
      updatedByHumanId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const record = await repo.getForm("event-1", "ATTEND");

    expect(form.findUnique).toHaveBeenCalledWith({
      where: { eventId_purpose: { eventId: "event-1", purpose: "ATTEND" } },
    });
    expect(record).toMatchObject({
      opensAt,
      closesAt,
      maxSubmissions: 25,
      autoApprove: true,
    });
  });

  it("resolves submissions by token", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);

    submission.findUnique.mockResolvedValueOnce({
      id: "submission-1",
      eventId: "event-1",
      formId: "form-1",
      form: { purpose: "ATTEND" },
      humanId: null,
      contactEmail: null,
      contactPhone: null,
      status: "PENDING",
      answers: {},
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: "token-abc",
      tokenExpiresAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const record = await repo.getSubmissionByToken("token-abc");

    expect(submission.findUnique).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      // Event-owned rows only: a series-call submission reads as missing.
      where: { approvalToken: "token-abc", eventId: { not: null } },
    });

    expect(record?.approvalToken).toBe("token-abc");
  });

  // ── One-open-application dedupe (spec Phase 3 item 2 / D5) ──────────────
  /**
   * A P2002 naming `index`, in the driver-adapter shape Prisma 7 raises
   * (the only mode this repo runs): the index name sits under
   * `meta.driverAdapterError.cause.constraint.index`.
   */
  const uniqueViolationOn = (index: string) =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: {
        modelName: "EventApplicationSubmission",
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            kind: "UniqueConstraintViolation",
            constraint: { index },
          },
        },
      },
    });
  /** A P2002 from one of the per-form open-dedupe partial indexes. */
  const uniqueViolation = () =>
    uniqueViolationOn("EventApplicationSubmission_open_guest_key");

  const submissionRow = (overrides: Record<string, unknown> = {}) => ({
    id: "sub-1",
    eventId: "event-1",
    formId: "form-1",
    form: { purpose: "ATTEND" },
    humanId: null,
    contactEmail: "guest@example.com",
    contactPhone: null,
    status: "PENDING",
    answers: {},
    decisionReason: null,
    questionsSnapshot: {},
    reviewerHumanId: null,
    reviewedAt: null,
    approvalToken: null,
    tokenExpiresAt: null,
    metadata: {},
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    ...overrides,
  });

  it("maps a create P2002 to duplicate_open_application", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.create.mockRejectedValueOnce(uniqueViolation());

    await expect(
      repo.createSubmission({
        formId: "form-1",
        eventId: "event-1",
        contactEmail: "guest@example.com",
        answers: {},
        submittedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
  });

  it("maps the open-HUMAN dedupe index too", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.create.mockRejectedValueOnce(
      uniqueViolationOn("EventApplicationSubmission_open_human_key"),
    );

    await expect(
      repo.createSubmission({
        formId: "form-1",
        eventId: "event-1",
        humanId: "human-1",
        answers: {},
        submittedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
  });

  it("does NOT report a statusTokenHash collision as a duplicate application", async () => {
    // Narrowed by index name: any other unique on the table is a bug and
    // must surface as itself, not as "you already applied".
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    const collision = uniqueViolationOn(
      "EventApplicationSubmission_statusTokenHash_key",
    );
    submission.create.mockRejectedValueOnce(collision);

    await expect(
      repo.createSubmission({
        formId: "form-1",
        eventId: "event-1",
        answers: {},
        submittedAt: new Date(),
      }),
    ).rejects.toBe(collision);
  });

  it("does NOT report an unnamed P2002 as a duplicate application", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    const bare = new Prisma.PrismaClientKnownRequestError("Unique", {
      code: "P2002",
      clientVersion: "test",
    });
    submission.update.mockRejectedValueOnce(bare);

    await expect(
      repo.updateSubmissionStatus({ submissionId: "sub-1", status: "PENDING" }),
    ).rejects.toBe(bare);
  });

  it("rethrows a non-P2002 create failure untouched", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    const boom = new Error("connection reset");
    submission.create.mockRejectedValueOnce(boom);

    await expect(
      repo.createSubmission({
        formId: "form-1",
        eventId: "event-1",
        answers: {},
        submittedAt: new Date(),
      }),
    ).rejects.toBe(boom);
  });

  it("findOpenSubmission scopes a GUEST lookup to ownerless rows and lowercases the email", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.findFirst.mockResolvedValueOnce(submissionRow());

    const result = await repo.findOpenSubmission({
      formId: "form-1",
      contactEmail: "Guest@Example.COM",
    });

    expect(submission.findFirst).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      where: {
        // Per FORM, like the partial unique indexes.
        formId: "form-1",
        humanId: null,
        contactEmail: "guest@example.com",
        // MUST match the partial unique indexes' predicate exactly.
        status: { in: ["PENDING", "APPROVED", "WAITLISTED"] },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(result?.id).toBe("sub-1");
  });

  it("findOpenSubmission scopes an AUTHED lookup to the humanId (never the email)", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.findFirst.mockResolvedValueOnce(null);

    const result = await repo.findOpenSubmission({
      formId: "form-1",
      humanId: "human-1",
    });

    expect(submission.findFirst).toHaveBeenCalledWith({
      // Every submission read carries its form purpose (open calls v1).
      include: FORM_PURPOSE_INCLUDE,
      where: {
        formId: "form-1",
        humanId: "human-1",
        applyingAsOrgId: null,
        status: { in: ["PENDING", "APPROVED", "WAITLISTED"] },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(result).toBeNull();
  });

  it("attachSubmissionToHuman CASes on humanId IS NULL and re-reads the row", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.updateMany.mockResolvedValueOnce({ count: 1 });
    submission.findUnique.mockResolvedValueOnce(
      submissionRow({ humanId: "human-1" }),
    );

    const result = await repo.attachSubmissionToHuman({
      submissionId: "sub-1",
      humanId: "human-1",
    });

    expect(submission.updateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", humanId: null },
      data: { humanId: "human-1" },
    });
    expect(result?.humanId).toBe("human-1");
  });

  it("attachSubmissionToHuman returns null when the CAS loses (already claimed)", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      repo.attachSubmissionToHuman({
        submissionId: "sub-1",
        humanId: "human-1",
      }),
    ).resolves.toBeNull();
    expect(submission.findUnique).not.toHaveBeenCalled();
  });

  it("attachSubmissionToHuman swallows a P2002 (redeemer already has an open application) to null", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.updateMany.mockRejectedValueOnce(uniqueViolation());

    await expect(
      repo.attachSubmissionToHuman({
        submissionId: "sub-1",
        humanId: "human-1",
      }),
    ).resolves.toBeNull();
  });

  it("attachSubmissionToHuman rethrows a non-P2002 failure", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    const boom = new Error("connection reset");
    submission.updateMany.mockRejectedValueOnce(boom);

    await expect(
      repo.attachSubmissionToHuman({
        submissionId: "sub-1",
        humanId: "human-1",
      }),
    ).rejects.toBe(boom);
  });

  // ── updateSubmissionStatus P2002 (writes INTO the open set) ─────────────
  it("maps a CAS-branch (updateMany) P2002 to duplicate_open_application", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.updateMany.mockRejectedValueOnce(uniqueViolation());

    await expect(
      repo.updateSubmissionStatus({
        submissionId: "sub-1",
        status: "APPROVED",
        expectedFromStatuses: ["PENDING", "EXPIRED"],
      }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
  });

  it("maps a plain-update P2002 to duplicate_open_application (rescind path)", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.update.mockRejectedValueOnce(uniqueViolation());

    await expect(
      repo.updateSubmissionStatus({
        submissionId: "sub-1",
        status: "PENDING",
      }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
  });

  it("still surfaces the CAS `conflict` sentinel untouched (not swallowed by the P2002 catch)", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      repo.updateSubmissionStatus({
        submissionId: "sub-1",
        status: "APPROVED",
        expectedFromStatuses: ["PENDING"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rethrows a non-P2002 update failure", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    const boom = new Error("connection reset");
    submission.update.mockRejectedValueOnce(boom);

    await expect(
      repo.updateSubmissionStatus({ submissionId: "sub-1", status: "PENDING" }),
    ).rejects.toBe(boom);
  });

  it("lockApprovedSubmission guards on event + form + APPROVED + the SAME reviewedAt, and reports a match", async () => {
    const { prisma, form, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    const reviewedAt = new Date("2025-12-05T12:00:00.123Z");
    form.findUnique.mockResolvedValueOnce({ id: "form-1" });
    submission.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      repo.lockApprovedSubmission({
        submissionId: "sub-1",
        eventId: "event-1",
        purpose: "ATTEND",
        reviewedAt,
      }),
    ).resolves.toBe(true);
    expect(form.findUnique).toHaveBeenCalledWith({
      where: { eventId_purpose: { eventId: "event-1", purpose: "ATTEND" } },
      select: { id: true },
    });
    // A no-op write (same reviewedAt) so the row lock is taken inside the
    // caller's transaction; the WHERE carries the whole approval check.
    expect(submission.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sub-1",
        eventId: "event-1",
        formId: "form-1",
        status: "APPROVED",
        reviewedAt,
      },
      data: { reviewedAt },
    });
  });

  it("lockApprovedSubmission returns false (never throws) when the approval no longer matches", async () => {
    const { prisma, form, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    form.findUnique.mockResolvedValueOnce({ id: "form-1" });
    submission.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      repo.lockApprovedSubmission({
        submissionId: "sub-1",
        eventId: "event-1",
        purpose: "ATTEND",
        reviewedAt: new Date("2025-12-05T12:00:00.123Z"),
      }),
    ).resolves.toBe(false);
  });

  it("lockApprovedSubmission misses (no write) when the event has no form of that purpose", async () => {
    const { prisma, form, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    form.findUnique.mockResolvedValueOnce(null);

    await expect(
      repo.lockApprovedSubmission({
        submissionId: "sub-1",
        eventId: "event-1",
        purpose: "ATTEND",
        reviewedAt: new Date("2025-12-05T12:00:00.123Z"),
      }),
    ).resolves.toBe(false);
    expect(submission.updateMany).not.toHaveBeenCalled();
  });

  it("ensureForm returns the existing form without writing", async () => {
    const { prisma, form } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    form.findUnique.mockResolvedValueOnce({
      id: "form-1",
      eventId: "event-1",
      purpose: "ATTEND",
      publicId: "abcdefghij",
      introText: null,
      defaults: {},
      opensAt: null,
      closesAt: null,
      maxSubmissions: null,
      autoApprove: false,
      updatedByHumanId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const record = await repo.ensureForm({
      eventId: "event-1",
      purpose: "ATTEND",
    });

    expect(record.id).toBe("form-1");
    expect(form.createMany).not.toHaveBeenCalled();
  });

  it("ensureForm inserts ON CONFLICT DO NOTHING, then re-reads", async () => {
    const { prisma, form } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    form.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "form-2",
      eventId: "event-1",
      purpose: "ATTEND",
      publicId: "abcdefghij",
      introText: null,
      defaults: {},
      opensAt: null,
      closesAt: null,
      maxSubmissions: null,
      autoApprove: false,
      updatedByHumanId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const record = await repo.ensureForm({
      eventId: "event-1",
      purpose: "ATTEND",
    });

    expect(form.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          eventId: "event-1",
          purpose: "ATTEND",
          publicId: expect.stringMatching(/^[0-9a-z]{10}$/),
        }),
      ],
      skipDuplicates: true,
    });
    expect(record.id).toBe("form-2");
  });

  // ── A missing purpose / formId must throw, never read "any form" ─────────
  // Prisma drops an `undefined` filter, so `form: { purpose: undefined }`
  // would match EVERY form. The compiler demands the argument; these pin the
  // runtime guard for callers that slip past it (a cast, an untyped test).
  describe("missing purpose / formId throws before any query", () => {
    const missing = undefined as unknown as "ATTEND";

    it("listSubmissions", async () => {
      const { prisma, submission } = createPrisma();
      const repo = makeEventApplicationsRepo(prisma);
      await expect(
        repo.listSubmissions({ eventId: "event-1", purpose: missing }),
      ).rejects.toThrow(/listSubmissions: purpose is required/);
      expect(submission.findMany).not.toHaveBeenCalled();
      expect(submission.count).not.toHaveBeenCalled();
    });

    it("countSubmissions", async () => {
      const { prisma, submission } = createPrisma();
      const repo = makeEventApplicationsRepo(prisma);
      await expect(
        repo.countSubmissions({ eventId: "event-1", purpose: missing }),
      ).rejects.toThrow(/countSubmissions: purpose is required/);
      expect(submission.count).not.toHaveBeenCalled();
    });

    it("getSubmissionByEventAndHuman", async () => {
      const { prisma, submission } = createPrisma();
      const repo = makeEventApplicationsRepo(prisma);
      await expect(
        repo.getSubmissionByEventAndHuman("event-1", missing, "human-1"),
      ).rejects.toThrow(/getSubmissionByEventAndHuman: purpose is required/);
      expect(submission.findFirst).not.toHaveBeenCalled();
    });

    it("getForm, ensureForm, upsertForm and lockApprovedSubmission", async () => {
      const { prisma, form, submission } = createPrisma();
      const repo = makeEventApplicationsRepo(prisma);
      await expect(repo.getForm("event-1", missing)).rejects.toThrow(
        /getForm: purpose is required/,
      );
      await expect(
        repo.ensureForm({ eventId: "event-1", purpose: missing }),
      ).rejects.toThrow(/ensureForm: purpose is required/);
      await expect(
        repo.upsertForm({
          eventId: "event-1",
          purpose: missing,
          updatedByHumanId: "human-1",
        }),
      ).rejects.toThrow(/upsertForm: purpose is required/);
      await expect(
        repo.lockApprovedSubmission({
          submissionId: "sub-1",
          eventId: "event-1",
          purpose: missing,
          reviewedAt: new Date(),
        }),
      ).rejects.toThrow(/lockApprovedSubmission: purpose is required/);
      expect(form.findUnique).not.toHaveBeenCalled();
      expect(form.upsert).not.toHaveBeenCalled();
      expect(submission.updateMany).not.toHaveBeenCalled();
    });

    it("expireSubmissionsForClosedForms (a cast cannot widen the sweep)", async () => {
      const { prisma, submission } = createPrisma();
      const repo = makeEventApplicationsRepo(prisma);
      await expect(
        repo.expireSubmissionsForClosedForms({
          cutoff: new Date(),
          purpose: missing,
        }),
      ).rejects.toThrow(/expireSubmissionsForClosedForms: purpose is required/);
      expect(submission.findMany).not.toHaveBeenCalled();
    });

    it("findOpenSubmission and createSubmission without a formId", async () => {
      const { prisma, submission } = createPrisma();
      const repo = makeEventApplicationsRepo(prisma);
      const noForm = undefined as unknown as string;
      await expect(
        repo.findOpenSubmission({ formId: noForm, humanId: "human-1" }),
      ).rejects.toThrow(/findOpenSubmission: formId is required/);
      await expect(
        repo.createSubmission({
          formId: noForm,
          eventId: "event-1",
          answers: {},
          submittedAt: new Date(),
        }),
      ).rejects.toThrow(/createSubmission: formId is required/);
      expect(submission.findFirst).not.toHaveBeenCalled();
      expect(submission.create).not.toHaveBeenCalled();
    });
  });

  it("maps the form's purpose and formId onto every submission record", async () => {
    const { prisma, submission } = createPrisma();
    const repo = makeEventApplicationsRepo(prisma);
    submission.findUnique.mockResolvedValueOnce(
      submissionRow({ formId: "form-p", form: { purpose: "PERFORM" } }),
    );

    const record = await repo.getSubmissionById("sub-1");

    expect(record).toMatchObject({ formId: "form-p", purpose: "PERFORM" });
  });
});
