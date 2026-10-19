import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type {
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
  TxRepos,
} from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { rescindEventApplicationDecision } from "../rescind-event-application-decision";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ORG_ID = "50000000-0000-4000-8000-000000000005";
const ACTOR_ID = "60000000-0000-4000-8000-000000000006";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const HUMAN_ID = "80000000-0000-4000-8000-000000000008";
const NOW = new Date("2025-12-05T12:00:00Z");

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Secret show",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-12-10T20:00:00Z"),
  endsAt: new Date("2025-12-11T01:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "secret",
  shortId: "SECRET",
  regionCode: "US-CA",
  publishedAt: new Date("2025-11-01T00:00:00Z"),
  agreementPrimaryId: "agreement-primary",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

const baseSubmission: EventApplicationSubmissionRecord = {
  id: SUBMISSION_ID,
  // Open calls v1: the submission's form. ATTEND = the attendee gate.
  formId: "a0000000-0000-4000-8000-0000000000f0",
  purpose: "ATTEND",
  eventId: EVENT_ID,
  humanId: HUMAN_ID,
  contactEmail: "guest@example.com",
  contactPhone: "+15555550123",
  status: "APPROVED",
  answers: { q1: "hi" },
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: ACTOR_ID,
  reviewedAt: new Date("2025-12-02T00:00:00Z"),
  approvalToken: "token-123",
  tokenExpiresAt: new Date("2025-12-03T00:00:00Z"),
  inviteId: null,
  metadata: {},
  createdAt: new Date("2025-12-01T00:00:00Z"),
  updatedAt: new Date("2025-12-01T00:00:00Z"),
};

const membership: OrgMembership = {
  orgId: ORG_ID,
  humanId: ACTOR_ID,
  role: "ADMIN",
};

type Deps = ReturnType<typeof createDeps>;

function createDeps(
  overrides: {
    event?: Partial<EventRecord | null>;
    membership?: OrgMembership | null;
    submission?: Partial<EventApplicationSubmissionRecord | null>;
  } = {},
) {
  const eventValue =
    overrides.event === null
      ? null
      : { ...baseEvent, ...(overrides.event ?? {}) };
  const submissionValue =
    overrides.submission === null
      ? null
      : {
          ...baseSubmission,
          ...(overrides.submission ?? {}),
        };
  const membershipValue =
    overrides.membership !== undefined ? overrides.membership : membership;

  const eventsRepo = {
    getById: vi.fn().mockResolvedValue(eventValue),
  };
  const authzRepo = {
    getOrgMembership: vi
      .fn()
      .mockResolvedValue(eventValue ? membershipValue : null),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };
  const eventApplicationsRepo = {
    getSubmissionById: vi.fn().mockResolvedValue(submissionValue),
    updateSubmissionStatus: vi.fn().mockImplementation(
      async () =>
        ({
          ...baseSubmission,
          status: "PENDING",
          reviewerHumanId: null,
          reviewedAt: null,
          approvalToken: null,
          tokenExpiresAt: null,
        }) satisfies EventApplicationSubmissionRecord,
    ),
  };
  const auditRepo = {
    log: vi.fn(),
  };

  const eventUnlocksRepo = {
    revoke: vi.fn(async () => null),
    // Default: one durable unlock existed and was revoked. Tests override the
    // count to model the "no persisted unlock" case.
    revokeBySubmission: vi.fn(async () => 1),
  };

  const eventWaitlistsRepo = {
    // Default: no waitlist entry for the submission's identity.
    findEntry: vi.fn(async () => null as unknown),
    createEntry: vi.fn(),
    updateEntry: vi.fn(async (input: { entryId: string; status: string }) => ({
      id: input.entryId,
      status: input.status,
    })),
  };

  const tx = {
    events: eventsRepo,
    authz: authzRepo,
    eventApplications: eventApplicationsRepo,
    eventUnlocks: eventUnlocksRepo,
    eventWaitlists: eventWaitlistsRepo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const repos = {
    tx: vi.fn(async (fn: (txRepos: TxRepos) => Promise<unknown>) => fn(tx)),
  } as unknown as Repos;

  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  };

  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return {
    repos,
    clock,
    logger,
    info,
    eventsRepo,
    authzRepo,
    eventApplicationsRepo,
    eventUnlocksRepo,
    eventWaitlistsRepo,
    auditRepo,
  };
}

const buildWaitlistEntry = (
  overrides: Record<string, unknown> = {},
) => ({
  id: "e0000000-0000-4000-8000-00000000000e",
  eventId: EVENT_ID,
  humanId: HUMAN_ID,
  contactEmail: "guest@example.com",
  contactPhone: null,
  source: "APPLICATION",
  status: "PENDING",
  metadata: { submissionId: SUBMISSION_ID },
  notifiedAt: null,
  convertedOrderId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("rescindEventApplicationDecision", () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createDeps();
  });

  it("resets the submission to pending and clears reviewer metadata", async () => {
    const result = await rescindEventApplicationDecision(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
      },
    );

    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).toHaveBeenCalledWith({
      submissionId: SUBMISSION_ID,
      status: "PENDING",
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      decisionReason: null,
      // Back in review, it is no longer invite-approved: a later hand
      // approval must not read "Via invite", stay cap-exempt, or be
      // rescinded by a second revoke of the same invite.
      inviteId: null,
    });
    // Security fix: revoke EVERY grant minted from the submission (by
    // submission id, not humanId — the redeemer may differ from the applicant).
    expect(deps.eventUnlocksRepo.revokeBySubmission).toHaveBeenCalledWith(
      SUBMISSION_ID,
    );
    expect(deps.eventUnlocksRepo.revoke).not.toHaveBeenCalled();
    expect(deps.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_application_decision_rescinded",
        data: expect.objectContaining({
          fromStatus: "APPROVED",
          unlockRevoked: true,
        }),
      }),
    );
    expect(deps.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({ action: "application_decision_rescinded" }),
    );
    expect(result.submission.status).toBe("PENDING");
    expect(result.submission.reviewerHumanId).toBeNull();
    expect(result.submission.approvalToken).toBeNull();
  });

  it("clears a stale decision reason when rescinding a rejection", async () => {
    deps = createDeps({
      submission: {
        status: "REJECTED",
        approvalToken: null,
        tokenExpiresAt: null,
        decisionReason: "Full lineup already",
      },
    });

    await rescindEventApplicationDecision(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
      },
    );

    // The rescinded rejection must not carry its reason back into PENDING —
    // it would surface in list payloads.
    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING", decisionReason: null }),
    );
  });

  it("records unlockRevoked=false when the submission minted no durable unlock", async () => {
    // Anonymous applicant who never redeemed via a signed-in account: the
    // revoke-by-submission still runs but matches zero rows.
    deps = createDeps({ submission: { humanId: null } });
    deps.eventUnlocksRepo.revokeBySubmission.mockResolvedValueOnce(0);

    await rescindEventApplicationDecision(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
      },
    );

    expect(deps.eventUnlocksRepo.revokeBySubmission).toHaveBeenCalledWith(
      SUBMISSION_ID,
    );
    expect(deps.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unlockRevoked: false }),
      }),
    );
  });

  describe("rescinding a WAITLISTED decision", () => {
    it("DROPs the linked waitlist entry (never deletes)", async () => {
      deps = createDeps({
        submission: {
          status: "WAITLISTED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce(
        buildWaitlistEntry(),
      );

      const result = await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      expect(deps.eventWaitlistsRepo.updateEntry).toHaveBeenCalledWith({
        entryId: "e0000000-0000-4000-8000-00000000000e",
        status: "DROPPED",
        updatedAt: NOW,
      });
      expect(deps.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fromStatus: "WAITLISTED",
            waitlistEntryDropped: true,
            waitlistLinkRemoved: false,
          }),
        }),
      );
      expect(result.submission.status).toBe("PENDING");
    });

    it("only UNLINKS a merged independently-joined entry (PUBLIC join annotated by the decision)", async () => {
      deps = createDeps({
        submission: {
          status: "WAITLISTED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });
      // The person joined the public waitlist on their own; the WAITLISTED
      // decision merged the submissionId INTO their entry (source stays
      // PUBLIC). Rescind must strip the linkback but never drop their
      // independent signup.
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce(
        buildWaitlistEntry({
          source: "PUBLIC",
          status: "NOTIFIED",
          metadata: { origin: "landing", submissionId: SUBMISSION_ID },
        }),
      );

      await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      // Linkback stripped, other metadata + status preserved, NOT dropped.
      expect(deps.eventWaitlistsRepo.updateEntry).toHaveBeenCalledWith({
        entryId: "e0000000-0000-4000-8000-00000000000e",
        status: "NOTIFIED",
        metadata: { origin: "landing" },
        updatedAt: NOW,
      });
      expect(deps.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            waitlistEntryDropped: false,
            waitlistLinkRemoved: true,
          }),
        }),
      );
    });

    it("does NOT drop an entry the person created independently (no submissionId linkback)", async () => {
      deps = createDeps({
        submission: {
          status: "WAITLISTED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });
      // A PUBLIC join predating the application — metadata carries no
      // submissionId linkback, so the rescind must leave it alone.
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce(
        buildWaitlistEntry({ source: "PUBLIC", metadata: {} }),
      );

      await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      expect(deps.eventWaitlistsRepo.updateEntry).not.toHaveBeenCalled();
      expect(deps.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ waitlistEntryDropped: false }),
        }),
      );
    });

    it("only UNLINKS when the applicant self-joined AFTER the decision (publicJoinedAt marker)", async () => {
      deps = createDeps({
        submission: {
          status: "WAITLISTED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });
      // REVERSED ordering vs the merged-PUBLIC case: the decision CREATED
      // this entry (source APPLICATION), then the applicant submitted the
      // gate's WaitlistJoinForm — joinEventWaitlist's dedupe branch stamped
      // publicJoinedAt. Source alone would look drop-safe here; the marker
      // is what proves they asked for the waitlist themselves.
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce(
        buildWaitlistEntry({
          source: "APPLICATION",
          status: "PENDING",
          metadata: {
            submissionId: SUBMISSION_ID,
            publicJoinedAt: "2025-12-04T00:00:00.000Z",
          },
        }),
      );

      await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      // Linkback stripped, marker + status preserved, NOT dropped.
      expect(deps.eventWaitlistsRepo.updateEntry).toHaveBeenCalledWith({
        entryId: "e0000000-0000-4000-8000-00000000000e",
        status: "PENDING",
        metadata: { publicJoinedAt: "2025-12-04T00:00:00.000Z" },
        updatedAt: NOW,
      });
      expect(deps.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            waitlistEntryDropped: false,
            waitlistLinkRemoved: true,
          }),
        }),
      );
    });

    it("only UNLINKS a NOTIFIED entry — a live 'a spot opened' offer is never revoked", async () => {
      deps = createDeps({
        submission: {
          status: "WAITLISTED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce(
        buildWaitlistEntry({ source: "APPLICATION", status: "NOTIFIED" }),
      );

      await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      expect(deps.eventWaitlistsRepo.updateEntry).toHaveBeenCalledWith({
        entryId: "e0000000-0000-4000-8000-00000000000e",
        status: "NOTIFIED",
        metadata: {},
        updatedAt: NOW,
      });
      expect(deps.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            waitlistEntryDropped: false,
            waitlistLinkRemoved: true,
          }),
        }),
      );
    });

    it("never touches a PURCHASED entry", async () => {
      deps = createDeps({
        submission: {
          status: "WAITLISTED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce(
        buildWaitlistEntry({ status: "PURCHASED" }),
      );

      await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      expect(deps.eventWaitlistsRepo.updateEntry).not.toHaveBeenCalled();
    });

    it("does not consult the waitlist for non-WAITLISTED rescinds", async () => {
      await rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      );

      expect(deps.eventWaitlistsRepo.findEntry).not.toHaveBeenCalled();
      expect(deps.eventWaitlistsRepo.updateEntry).not.toHaveBeenCalled();
    });
  });

  it.each(["WITHDRAWN", "EXPIRED"] as const)(
    "throws INVALID_STATUS for a %s submission (rescind unwinds organizer decisions only)",
    async (status) => {
      deps = createDeps({
        submission: { status, approvalToken: null, tokenExpiresAt: null },
      });

      await expect(
        rescindEventApplicationDecision(
          { repos: deps.repos, clock: deps.clock, logger: deps.logger },
          {
            actorHumanId: ACTOR_ID,
            eventId: EVENT_ID,
            submissionId: SUBMISSION_ID,
          },
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });
      expect(
        deps.eventApplicationsRepo.updateSubmissionStatus,
      ).not.toHaveBeenCalled();
      expect(deps.eventUnlocksRepo.revokeBySubmission).not.toHaveBeenCalled();
    },
  );

  describe("internal guard (invite revoke)", () => {
    const INVITE_ID = "90000000-0000-4000-8000-000000000009";
    const run = (guard: Parameters<typeof rescindEventApplicationDecision>[2]) =>
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID, submissionId: SUBMISSION_ID },
        guard,
      );

    it("rescinds when the stamp and status still match, forwarding the status CAS", async () => {
      deps = createDeps({ submission: { status: "APPROVED", inviteId: INVITE_ID } });
      await run({ expectedInviteId: INVITE_ID, expectedFromStatuses: ["APPROVED"] });
      expect(deps.eventApplicationsRepo.updateSubmissionStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "PENDING",
          inviteId: null,
          expectedFromStatuses: ["APPROVED"],
          // The stamp is re-checked IN the write, not only on the read.
          expectedInviteId: INVITE_ID,
        }),
      );
    });

    it("INVALID_STATUS, nothing written, when the row no longer carries the invite (organizer approved it by hand)", async () => {
      deps = createDeps({ submission: { status: "APPROVED", inviteId: null } });
      await expect(run({ expectedInviteId: INVITE_ID })).rejects.toMatchObject({
        code: "INVALID_STATUS",
      });
      expect(deps.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
      expect(deps.eventUnlocksRepo.revokeBySubmission).not.toHaveBeenCalled();
    });

    it("INVALID_STATUS, nothing written, when the status left the expected set (organizer REJECTED it)", async () => {
      deps = createDeps({ submission: { status: "REJECTED", inviteId: INVITE_ID } });
      await expect(
        run({ expectedInviteId: INVITE_ID, expectedFromStatuses: ["APPROVED"] }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });
      expect(deps.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
    });

    it("a lost status CAS (a decision committed after the read) maps to INVALID_STATUS", async () => {
      deps = createDeps({ submission: { status: "APPROVED", inviteId: INVITE_ID } });
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValueOnce({
        code: "conflict",
        message: "status changed",
      });
      await expect(
        run({ expectedInviteId: INVITE_ID, expectedFromStatuses: ["APPROVED"] }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });
      expect(deps.eventUnlocksRepo.revokeBySubmission).not.toHaveBeenCalled();
    });
  });

  it("throws when the submission is already pending", async () => {
    deps = createDeps({ submission: { status: "PENDING" } });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_REVIEWED" });
  });

  it("throws when the submission belongs to another event", async () => {
    deps = createDeps({ submission: { eventId: "other-event" } });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_EVENT_MISMATCH" });
  });

  it("throws when the submission cannot be found", async () => {
    deps = createDeps({ submission: null });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  });

  it("treats a PERFORM (open-call) submission as not found", async () => {
    deps = createDeps({ submission: { purpose: "PERFORM" } });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  });

  it("throws when the event is not application gated", async () => {
    deps = createDeps({ event: { gateType: "PASSWORD" } });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });

  it("throws when the actor lacks permission", async () => {
    deps = createDeps({ membership: null });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });


  // Rescinding moves the row back to PENDING — i.e. back INTO the open set —
  // so it collides when the applicant already re-applied after the rejection.
  it("surfaces APPLICATION_ALREADY_SUBMITTED when the applicant already re-applied", async () => {
    const deps = createDeps({ submission: { status: "REJECTED" } });
    deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValue({
      code: "duplicate_open_application",
      message: "duplicate_open_application",
    });

    await expect(
      rescindEventApplicationDecision(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
  });
});

// Owner decision 2026-09-30: rescinding an APPROVED decision tells the
// applicant their application is back in review. REJECTED / WAITLISTED
// rescinds send nothing (deferred).
describe("rescindEventApplicationDecision — back-in-review notice", () => {
  const APP_BASE_URL = "https://app.test";
  const input = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    submissionId: SUBMISSION_ID,
  };

  function notifyDeps(deps: Deps) {
    const notify = vi.fn(async () => ({}) as never);
    const mailerSend = vi.fn(async () => ({ result: { id: "mail-id" } }));
    const mailer = {
      send: mailerSend,
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as unknown as import("@th/ports/comms/mailer").MailerPort;
    const reportError = vi.fn();
    return {
      notify,
      mailerSend,
      reportError,
      useCaseDeps: {
        repos: deps.repos,
        clock: deps.clock,
        logger: deps.logger,
        notify,
        mailer,
        appBaseUrl: APP_BASE_URL,
        reportError,
      },
    };
  }

  const guestRow = {
    ...baseSubmission,
    humanId: null,
    status: "PENDING",
    reviewerHumanId: null,
    reviewedAt: null,
    approvalToken: null,
    tokenExpiresAt: null,
  } satisfies EventApplicationSubmissionRecord;

  it("notifies a signed-in applicant with the per-rescind idempotency key", async () => {
    const deps = createDeps();
    const n = notifyDeps(deps);

    await rescindEventApplicationDecision(n.useCaseDeps, input);

    expect(n.notify).toHaveBeenCalledTimes(1);
    expect(n.notify).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      variant: "event.application-back-in-review",
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Secret show",
        submissionId: SUBMISSION_ID,
        eventUrl: `${APP_BASE_URL}/events/secret`,
      },
      scope: { kind: "EVENT", eventId: EVENT_ID },
      idempotencyKey: `application-back-in-review:${SUBMISSION_ID}:${NOW.getTime()}`,
      channels: { sms: { enabled: false } },
    });
    expect(n.mailerSend).not.toHaveBeenCalled();
  });

  it("emails a guest applicant the back-in-review template (never inline HTML)", async () => {
    const deps = createDeps({ submission: { humanId: null } });
    deps.eventApplicationsRepo.updateSubmissionStatus.mockResolvedValueOnce(
      guestRow,
    );
    const n = notifyDeps(deps);

    await rescindEventApplicationDecision(n.useCaseDeps, input);

    expect(n.notify).not.toHaveBeenCalled();
    expect(n.mailerSend).toHaveBeenCalledTimes(1);
    const sent = n.mailerSend.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    > & { text: string };
    expect(sent).toEqual({
      to: { to: "guest@example.com" },
      subject: "Back in review: Secret show",
      text: expect.stringContaining(
        "The organizer withdrew their approval. Your application is back in review.",
      ),
      template: {
        key: "event.application_back_in_review",
        variables: {
          eventTitle: "Secret show",
          eventUrl: `${APP_BASE_URL}/events/secret`,
          // Guest leg: hides the status link anonymous viewers can't use.
          isGuest: true,
        },
      },
      idempotencyKey: `application-back-in-review:${SUBMISSION_ID}:${NOW.getTime()}:email`,
    });
    // Guest unlock cookies can't be revoked server-side: never claim access
    // was taken away.
    expect(sent.text).not.toMatch(/access|locked|revoked/i);
  });

  it.each(["REJECTED", "WAITLISTED"] as const)(
    "sends nothing when rescinding a %s decision",
    async (status) => {
      const deps = createDeps({ submission: { status } });
      const n = notifyDeps(deps);

      await rescindEventApplicationDecision(n.useCaseDeps, input);

      expect(n.notify).not.toHaveBeenCalled();
      expect(n.mailerSend).not.toHaveBeenCalled();
    },
  );

  it("sends nothing for a guest rescind from REJECTED either", async () => {
    const deps = createDeps({
      submission: { status: "REJECTED", humanId: null },
    });
    deps.eventApplicationsRepo.updateSubmissionStatus.mockResolvedValueOnce(
      guestRow,
    );
    const n = notifyDeps(deps);

    await rescindEventApplicationDecision(n.useCaseDeps, input);

    expect(n.mailerSend).not.toHaveBeenCalled();
  });

  it("swallows + reports a failed notify; the rescind still lands", async () => {
    const deps = createDeps();
    const n = notifyDeps(deps);
    const boom = new Error("notify boom");
    n.notify.mockRejectedValueOnce(boom);

    const result = await rescindEventApplicationDecision(n.useCaseDeps, input);

    expect(result.submission.status).toBe("PENDING");
    expect(n.reportError).toHaveBeenCalledWith(boom, {
      tags: {
        useCase: "rescindEventApplicationDecision",
        channel: "backInReviewNotify",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
    expect(deps.logger.error).toHaveBeenCalledWith(
      "events.rescindEventApplicationDecision.backInReviewNotify_failed",
      expect.objectContaining({ err: boom }),
    );
  });

  it("a throwing reporter on a failed guest send changes nothing", async () => {
    const deps = createDeps({ submission: { humanId: null } });
    deps.eventApplicationsRepo.updateSubmissionStatus.mockResolvedValueOnce(
      guestRow,
    );
    const n = notifyDeps(deps);
    const boom = new Error("mailer boom");
    n.mailerSend.mockRejectedValueOnce(boom);
    n.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await rescindEventApplicationDecision(n.useCaseDeps, input);

    expect(result.submission.status).toBe("PENDING");
    expect(n.reportError).toHaveBeenCalledWith(boom, {
      tags: {
        useCase: "rescindEventApplicationDecision",
        channel: "backInReviewAnonEmail",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
  });

  it("without notify/mailer deps (an unwired composition root) the rescind still lands silently", async () => {
    const deps = createDeps();

    const result = await rescindEventApplicationDecision(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      input,
    );

    expect(result.submission.status).toBe("PENDING");
  });
});
