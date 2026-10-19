import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type {
  EventApplicationSubmissionRecord,
  Repos,
  TxRepos,
} from "@th/ports/repos";

import { withdrawEventApplication } from "../withdraw-event-application";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ACTOR_ID = "60000000-0000-4000-8000-000000000006";
const OTHER_HUMAN_ID = "61000000-0000-4000-8000-000000000006";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const NOW = new Date("2025-12-05T12:00:00Z");

const baseEvent = {
  id: EVENT_ID,
  orgId: "50000000-0000-4000-8000-000000000005",
  humanId: null,
  title: "Secret show",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
};

const baseSubmission: EventApplicationSubmissionRecord = {
  id: SUBMISSION_ID,
  // Open calls v1: the submission's form. ATTEND = the attendee gate.
  formId: "a0000000-0000-4000-8000-0000000000f0",
  purpose: "ATTEND",
  eventId: EVENT_ID,
  humanId: ACTOR_ID,
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
  createdAt: new Date("2025-12-01T00:00:00Z"),
  updatedAt: new Date("2025-12-01T00:00:00Z"),
};

function createDeps(
  overrides: {
    submission?: Partial<EventApplicationSubmissionRecord> | null;
  } = {},
) {
  const submissionValue =
    overrides.submission === null
      ? null
      : { ...baseSubmission, ...(overrides.submission ?? {}) };

  const events = {
    getById: vi.fn().mockResolvedValue(baseEvent),
  };

  const eventApplications = {
    getSubmissionById: vi.fn().mockResolvedValue(submissionValue),
    getSubmissionByEventAndHuman: vi.fn().mockResolvedValue(submissionValue),
    updateSubmissionStatus: vi.fn().mockImplementation(
      async (input: { submissionId: string; status: string }) =>
        ({
          ...(submissionValue ?? baseSubmission),
          status: input.status,
        }) as EventApplicationSubmissionRecord,
    ),
  };

  const audit = { log: vi.fn() };

  const txRepos = { eventApplications, audit } as unknown as TxRepos;
  const repos = {
    events,
    eventApplications,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Pick<Repos, "tx" | "events" | "eventApplications">;

  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return { repos, events, eventApplications, audit, clock, logger, info };
}

describe("withdrawEventApplication", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
  });

  it("withdraws the actor's own PENDING submission (resolved by event+human)", async () => {
    const result = await withdrawEventApplication(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
    );

    expect(
      deps.eventApplications.getSubmissionByEventAndHuman,
    ).toHaveBeenCalledWith(EVENT_ID, "ATTEND", ACTOR_ID);
    expect(deps.eventApplications.updateSubmissionStatus).toHaveBeenCalledWith(
      {
        submissionId: SUBMISSION_ID,
        status: "WITHDRAWN",
        // Defensive credential clearing + status-guarded write.
        approvalToken: null,
        tokenExpiresAt: null,
        expectedFromStatuses: ["PENDING"],
      },
    );
    expect(deps.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_application_withdrawn",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          submissionId: SUBMISSION_ID,
          fromStatus: "PENDING",
        }),
      }),
    );
    expect(result).toEqual({
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      status: "WITHDRAWN",
    });
    expect(deps.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({ action: "application_withdrawn" }),
    );
  });

  it("withdraws an explicitly-targeted own submission", async () => {
    const result = await withdrawEventApplication(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
      },
    );

    expect(deps.eventApplications.getSubmissionById).toHaveBeenCalledWith(
      SUBMISSION_ID,
    );
    expect(
      deps.eventApplications.getSubmissionByEventAndHuman,
    ).not.toHaveBeenCalled();
    expect(result.status).toBe("WITHDRAWN");
  });

  it("FORBIDDEN when targeting someone else's submission", async () => {
    deps = createDeps({ submission: { humanId: OTHER_HUMAN_ID } });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      deps.eventApplications.updateSubmissionStatus,
    ).not.toHaveBeenCalled();
  });

  it("FORBIDDEN when targeting an anonymous submission (no on-platform owner)", async () => {
    deps = createDeps({ submission: { humanId: null } });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("SUBMISSION_NOT_FOUND when the explicit target belongs to another event", async () => {
    deps = createDeps({
      submission: { eventId: "41000000-0000-4000-8000-000000000004" },
    });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  });

  it("SUBMISSION_NOT_FOUND when the explicit target is a PERFORM (open-call) submission", async () => {
    deps = createDeps({ submission: { purpose: "PERFORM" } });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  });

  it("SUBMISSION_NOT_FOUND when the actor has no submission for the event", async () => {
    deps = createDeps({ submission: null });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  });

  it.each(["APPROVED", "REJECTED", "WAITLISTED", "EXPIRED"] as const)(
    "INVALID_STATUS for a %s submission (decided applications don't unwind)",
    async (status) => {
      deps = createDeps({ submission: { status } });

      await expect(
        withdrawEventApplication(
          { repos: deps.repos, clock: deps.clock, logger: deps.logger },
          { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });
      expect(
        deps.eventApplications.updateSubmissionStatus,
      ).not.toHaveBeenCalled();
    },
  );

  it("is an idempotent no-op for an already-WITHDRAWN submission", async () => {
    deps = createDeps({ submission: { status: "WITHDRAWN" } });

    const result = await withdrawEventApplication(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("WITHDRAWN");
    expect(
      deps.eventApplications.updateSubmissionStatus,
    ).not.toHaveBeenCalled();
    expect(deps.audit.log).not.toHaveBeenCalled();
  });

  it("INVALID_STATUS when the guarded write loses the race (adapter conflict)", async () => {
    // Both reads saw PENDING, but the adapter's expectedFromStatuses CAS
    // missed — a concurrent approval committed between re-read and write.
    deps.eventApplications.updateSubmissionStatus.mockRejectedValueOnce({
      code: "conflict",
      message: "application_submission_status_changed",
    });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("INVALID_STATUS when a concurrent review lands between pre-read and tx re-read", async () => {
    // Pre-read sees PENDING; the tx re-read sees APPROVED (concurrent
    // reviewer won the race) — the withdraw must not clobber the decision.
    deps.eventApplications.getSubmissionById.mockResolvedValueOnce({
      ...baseSubmission,
      status: "APPROVED",
    });

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(
      deps.eventApplications.updateSubmissionStatus,
    ).not.toHaveBeenCalled();
  });

  it("EVENT_NOT_FOUND when the event does not exist", async () => {
    deps.events.getById.mockResolvedValue(null);

    await expect(
      withdrawEventApplication(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});
