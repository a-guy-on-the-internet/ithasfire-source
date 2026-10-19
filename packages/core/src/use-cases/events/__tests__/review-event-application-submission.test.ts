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
import type { NotifyInput, NotifyOutput } from "../../comms/notify";

import { approvalNotifyIdempotencyKey } from "../_shared/approve-submission";
import { rescindEventApplicationDecision } from "../rescind-event-application-decision";
import {
  rejectionNotifyIdempotencyKey,
  reviewEventApplicationSubmission,
  waitlistNotifyIdempotencyKey,
  __test__,
} from "../review-event-application-submission";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ORG_ID = "50000000-0000-4000-8000-000000000005";
const ACTOR_ID = "60000000-0000-4000-8000-000000000006";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const HUMAN_ID = "80000000-0000-4000-8000-000000000008";
const NOW = new Date("2025-12-05T12:00:00Z");
const APP_BASE_URL = "https://app.test";

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
  status: "PENDING",
  answers: { q1: "hi" },
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: null,
  reviewedAt: null,
  approvalToken: null,
  tokenExpiresAt: null,
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

const buildUseCaseDeps = (deps: Deps) => ({
  repos: deps.repos,
  clock: deps.clock,
  notify: deps.notify,
  mailer: deps.mailer,
  appBaseUrl: APP_BASE_URL,
  reportError: deps.reportError,
  logger: deps.logger,
});

function createDeps(
  overrides: {
    event?: Partial<EventRecord | null>;
    membership?: OrgMembership | null;
    submission?: Partial<EventApplicationSubmissionRecord | null>;
    /** Role of ACTOR_ID as a delegate of a human-owned event's owner. */
    delegateRole?: string | null;
    /**
     * Post-commit org reads for the applicant email context. Absent ⇒ the
     * repos mock has no `organizations` / `entityPages` (props omitted).
     */
    org?: {
      contactEmail?: string | null;
      page?: { slug: string; visibility: string } | null;
    };
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
    getHumanDelegation: vi.fn(async () =>
      overrides.delegateRole
        ? { orgId: "principal", humanId: ACTOR_ID, role: overrides.delegateRole }
        : null,
    ),
  };
  // Account identities for the delegate self-benefit check: ACTOR_ID owns
  // `actor@example.com`; nobody else resolves by email.
  const humansRepo = {
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      human: { id },
      identity: { email: id === ACTOR_ID ? "actor@example.com" : `${id}@x.test` },
    })),
    getByEmail: vi.fn(async () => null),
  };
  const eventApplicationsRepo = {
    getSubmissionById: vi.fn().mockResolvedValue(submissionValue),
    updateSubmissionStatus: vi.fn().mockImplementation(
      async (input) =>
        ({
          ...(submissionValue ?? baseSubmission),
          status: input.status,
          reviewerHumanId: input.reviewerHumanId,
          reviewedAt: input.reviewedAt,
          approvalToken: input.approvalToken ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          decisionReason: input.decisionReason ?? null,
        }) satisfies EventApplicationSubmissionRecord,
    ),
  };
  const auditRepo = {
    log: vi.fn(),
  };

  const eventUnlocksRepo = {
    upsert: vi.fn().mockResolvedValue({
      id: "unlock-id",
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
      unlockedAt: NOW,
      expiresAt: null,
      revokedAt: null,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
    }),
  };

  const eventWaitlistsRepo = {
    // Default: no existing waitlist entry for the applicant's identity.
    findEntry: vi.fn(async () => null as unknown),
    createEntry: vi.fn(
      async (input: Record<string, unknown>) => ({
        id: "e0000000-0000-4000-8000-00000000000e",
        eventId: EVENT_ID,
        humanId: (input.humanId as string | null) ?? null,
        contactEmail: (input.contactEmail as string | null) ?? null,
        contactPhone: (input.contactPhone as string | null) ?? null,
        source: input.source,
        status: input.status ?? "PENDING",
        metadata: input.metadata ?? {},
        notifiedAt: null,
        convertedOrderId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
    updateEntry: vi.fn(
      async (input: {
        entryId: string;
        status: string;
        metadata?: Record<string, unknown>;
      }) => ({
        id: input.entryId,
        eventId: EVENT_ID,
        humanId: HUMAN_ID,
        contactEmail: "guest@example.com",
        contactPhone: null,
        source: "APPLICATION",
        status: input.status,
        metadata: input.metadata ?? {},
        notifiedAt: null,
        convertedOrderId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
  };

  const tx = {
    events: eventsRepo,
    authz: authzRepo,
    humans: humansRepo,
    eventApplications: eventApplicationsRepo,
    eventUnlocks: eventUnlocksRepo,
    eventWaitlists: eventWaitlistsRepo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const organizationsRepo = {
    getById: vi.fn(async () => ({
      id: ORG_ID,
      slug: "sunset-collective",
      contactEmail: overrides.org?.contactEmail ?? null,
    })),
  };
  const entityPagesRepo = {
    getByOwner: vi.fn(async () => overrides.org?.page ?? null),
  };

  const repos = {
    tx: vi.fn(async (fn: (txRepos: TxRepos) => Promise<unknown>) => fn(tx)),
    ...(overrides.org
      ? { organizations: organizationsRepo, entityPages: entityPagesRepo }
      : {}),
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

  const notifyResult: NotifyOutput = {
    ok: true,
    variant: "event.application-approved",
    category: "transactional",
    scope: { kind: "GLOBAL" },
    inApp: { status: "skipped", reason: "channel_disabled" },
  } as const;

  const notify = vi.fn(async (_input: NotifyInput) => notifyResult);

  const mailerSend = vi.fn(
    async (_input: import("@th/ports/comms/mailer").MailerSendInput) => ({
      result: { id: "mail-id" },
    }),
  );
  const mailer = {
    send: mailerSend,
    sendBatch: vi.fn(),
    health: vi.fn(),
  } as unknown as import("@th/ports/comms/mailer").MailerPort;

  const reportError = vi.fn();

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
    notify,
    mailer,
    mailerSend,
    reportError,
    organizationsRepo,
    entityPagesRepo,
  };
}

/**
 * Makes the submission row STATEFUL across use-case calls so a real
 * decide → rescind → decide sequence can run against one mock: reads return
 * the latest write, guarded writes honour `expectedFromStatuses` (a second
 * decision without the rescind in between loses the CAS), and the clock
 * advances one second per read so each decision has its own timestamp.
 */
function makeSubmissionStateful(deps: Deps) {
  let row: EventApplicationSubmissionRecord = { ...baseSubmission };
  deps.eventApplicationsRepo.getSubmissionById.mockImplementation(
    async () => ({ ...row }),
  );
  deps.eventApplicationsRepo.updateSubmissionStatus.mockImplementation(
    async (input: {
      status: EventApplicationSubmissionRecord["status"];
      reviewerHumanId: string | null;
      reviewedAt: Date | null;
      approvalToken?: string | null;
      tokenExpiresAt?: Date | null;
      decisionReason?: string | null;
      expectedFromStatuses?: string[];
    }) => {
      if (
        input.expectedFromStatuses &&
        !input.expectedFromStatuses.includes(row.status)
      ) {
        throw { code: "conflict" };
      }
      row = {
        ...row,
        status: input.status,
        reviewerHumanId: input.reviewerHumanId,
        reviewedAt: input.reviewedAt,
        approvalToken: input.approvalToken ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        decisionReason: input.decisionReason ?? null,
      };
      return { ...row };
    },
  );
  Object.assign(deps.eventUnlocksRepo, {
    revokeBySubmission: vi.fn(async () => 1),
  });
  let tick = 0;
  vi.mocked(deps.clock.now).mockImplementation(
    () => new Date(NOW.getTime() + 1000 * tick++),
  );
}

const rescind = (deps: Deps) =>
  rescindEventApplicationDecision(buildUseCaseDeps(deps), {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    submissionId: SUBMISSION_ID,
  });

// Owner ruling 2026-09-28: a DELEGATE may not approve their OWN application
// to the principal's gated event (by humanId, or by a contact email that is
// the delegate's mailbox). Rejecting it, approving someone else's, and the
// owner approving their own are unaffected.
describe("reviewEventApplicationSubmission — a delegate's own application", () => {
  const PRINCIPAL = "90000000-0000-4000-8000-000000000009";
  const personal = { orgId: null, humanId: PRINCIPAL };
  const review = (
    d: ReturnType<typeof createDeps>,
    decision: "APPROVED" | "REJECTED",
  ) =>
    reviewEventApplicationSubmission(buildUseCaseDeps(d), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision,
    });

  it("refuses an EDITOR delegate approving their own submission (humanId)", async () => {
    const d = createDeps({
      event: personal,
      delegateRole: "EDITOR",
      submission: { humanId: ACTOR_ID },
    });
    await expect(review(d, "APPROVED")).rejects.toMatchObject({
      code: "DELEGATE_SELF_BENEFIT_FORBIDDEN",
    });
    expect(d.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
    expect(d.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses approving an anonymous submission whose contact email is the delegate's mailbox", async () => {
    const d = createDeps({
      event: personal,
      delegateRole: "EDITOR",
      submission: { humanId: null, contactEmail: "Actor+apply@Example.com" },
    });
    await expect(review(d, "APPROVED")).rejects.toMatchObject({
      code: "DELEGATE_SELF_BENEFIT_FORBIDDEN",
    });
    expect(d.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it("lets the delegate approve someone else's submission", async () => {
    const d = createDeps({ event: personal, delegateRole: "EDITOR" });
    await review(d, "APPROVED");
    expect(d.eventApplicationsRepo.updateSubmissionStatus).toHaveBeenCalled();
  });

  it("lets the delegate REJECT their own submission (not a benefit)", async () => {
    const d = createDeps({
      event: personal,
      delegateRole: "EDITOR",
      submission: { humanId: ACTOR_ID },
    });
    await review(d, "REJECTED");
    expect(d.eventApplicationsRepo.updateSubmissionStatus).toHaveBeenCalled();
  });

  it("lets the OWNER approve their own submission", async () => {
    const d = createDeps({
      event: { orgId: null, humanId: ACTOR_ID },
      submission: { humanId: ACTOR_ID },
    });
    await review(d, "APPROVED");
    expect(d.eventApplicationsRepo.updateSubmissionStatus).toHaveBeenCalled();
  });
});

describe("reviewEventApplicationSubmission", () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createDeps();
  });

  it("a hand approval CLEARS the invite stamp (not an invite approval: counts against the cap, not 'Via invite')", async () => {
    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "APPROVED",
    });

    const write = deps.eventApplicationsRepo.updateSubmissionStatus.mock
      .calls[0]?.[0] as Record<string, unknown>;
    // An explicit key: the adapter only writes inviteId when the key is
    // present, so `undefined`/absent would leave a stale stamp behind.
    expect(Object.prototype.hasOwnProperty.call(write, "inviteId")).toBe(true);
    expect(write.inviteId).toBeNull();
    // The unlock is not an invite unlock either.
    expect(deps.eventUnlocksRepo.upsert).toHaveBeenCalledWith(
      expect.not.objectContaining({ inviteId: expect.anything() }),
    );
  });

  it("approves a submission and issues a token with default expiration", async () => {
    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      },
    );

    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        status: "APPROVED",
        reviewerHumanId: ACTOR_ID,
        approvalToken: expect.any(String),
        tokenExpiresAt: new Date(
          NOW.getTime() + __test__.DEFAULT_TOKEN_TTL_MINUTES * 60 * 1000,
        ),
      }),
    );
    expect(result.submission.status).toBe("APPROVED");
    expect(result.submission.approvalToken).toEqual(expect.any(String));
    expect(deps.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({ action: "application_submission_reviewed" }),
    );
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      variant: "event.application-approved",
      payload: expect.objectContaining({
        eventId: EVENT_ID,
        eventTitle: baseEvent.title,
        submissionId: SUBMISSION_ID,
        approvalToken: expect.any(String),
        expiresAtIso: result.submission.tokenExpiresAt?.toISOString() ?? null,
        approvalUrl: expect.stringMatching(
          new RegExp(`^${APP_BASE_URL}/api/events/${EVENT_ID}/claim\\?token=`),
        ),
        eventUrl: `${APP_BASE_URL}/events/secret`,
        startsAtIso: baseEvent.startsAt.toISOString(),
        endsAtIso: baseEvent.endsAt!.toISOString(),
      }),
      scope: { kind: "EVENT", eventId: EVENT_ID },
      // One key per approval instance: a re-approve after a rescind mints a
      // new token, so it gets its own notice.
      idempotencyKey: approvalNotifyIdempotencyKey(
        SUBMISSION_ID,
        result.submission.approvalToken!,
      ),
    });
    // The token is a 7-day bearer secret; the key reaches mailer logs, the
    // X-Idempotency-Key header and the ESP, so it must never carry it.
    const approvalInput = deps.notify.mock.calls[0]?.[0];
    expect(approvalInput?.idempotencyKey).toMatch(
      new RegExp(`^application-approved:${SUBMISSION_ID}:[0-9a-f]{16}$`),
    );
    expect(approvalInput?.idempotencyKey).not.toContain(
      result.submission.approvalToken!,
    );

    // Verify EventUnlock was created on approval
    expect(deps.eventUnlocksRepo.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
    });
    // Signed-in path uses notify, not the direct mailer.
    expect(deps.mailerSend).not.toHaveBeenCalled();
  });

  it("approve → rescind → re-approve sends a SECOND approval notice under a distinct key", async () => {
    makeSubmissionStateful(deps);
    // A notify() stand-in with the real port's replay semantics: same key +
    // same payload replays, same key + DIFFERENT payload is a conflict (the
    // renderer fingerprint carries the approval token, so a submission-only
    // key made the re-approval collide and the notice was swallowed).
    const seen = new Map<string, string>();
    deps.notify.mockImplementation(async (input: NotifyInput) => {
      const body = JSON.stringify(input.payload);
      const prior = seen.get(input.idempotencyKey ?? "");
      if (prior !== undefined && prior !== body) {
        throw { code: "IDEMPOTENCY_KEY_CONFLICT" };
      }
      seen.set(input.idempotencyKey ?? "", body);
      return {
        ok: true,
        variant: input.variant,
        category: "transactional",
        scope: { kind: "GLOBAL" },
        inApp: { status: "skipped", reason: "channel_disabled" },
      } as NotifyOutput;
    });
    const approve = () =>
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      });

    const first = await approve();
    // Without the rescind the row is APPROVED and a second approval loses
    // the compare-and-swap.
    await expect(approve()).rejects.toMatchObject({ code: "INVALID_STATUS" });
    const rescinded = await rescind(deps);
    expect(rescinded.submission.status).toBe("PENDING");
    expect(rescinded.submission.approvalToken).toBeNull();
    const second = await approve();

    const approvalCalls = deps.notify.mock.calls
      .map(([input]) => input)
      .filter((input) => input.variant === "event.application-approved");
    expect(approvalCalls).toHaveLength(2);
    expect(first.submission.approvalToken).not.toBe(
      second.submission.approvalToken,
    );
    const keys = approvalCalls.map((c) => c.idempotencyKey);
    expect(keys).toEqual([
      approvalNotifyIdempotencyKey(
        SUBMISSION_ID,
        first.submission.approvalToken!,
      ),
      approvalNotifyIdempotencyKey(
        SUBMISSION_ID,
        second.submission.approvalToken!,
      ),
    ]);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) {
      expect(key).not.toContain(first.submission.approvalToken!);
      expect(key).not.toContain(second.submission.approvalToken!);
    }
    // The rescind in between told the applicant they're back in review.
    expect(
      deps.notify.mock.calls.filter(
        ([input]) => input.variant === "event.application-back-in-review",
      ),
    ).toHaveLength(1);
    // Neither send hit the swallow branch.
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("emails an anonymous applicant a direct claim link on approval", async () => {
    deps = createDeps({ submission: { humanId: null } });

    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      },
    );

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.mailerSend).toHaveBeenCalledTimes(1);
    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      to: { to: string };
      subject: string;
      text: string;
      html?: string;
      template: { key: string; variables: Record<string, unknown> };
    };
    expect(sent.to).toEqual({ to: baseSubmission.contactEmail });
    const claimUrl = `${APP_BASE_URL}/api/events/${EVENT_ID}/claim?token=${result.submission.approvalToken}`;
    expect(sent.subject).toBe("You're in: Secret show");
    expect(sent.text).toContain(claimUrl);
    // Branded template, never inline HTML.
    expect(sent.html).toBeUndefined();
    expect(sent.template).toEqual({
      key: "event.application_approved",
      variables: {
        eventTitle: "Secret show",
        approvalUrl: claimUrl,
        eventUrl: `${APP_BASE_URL}/events/secret`,
        expiresAtISO: result.submission.tokenExpiresAt!.toISOString(),
        startsAtISO: baseEvent.startsAt.toISOString(),
        endsAtISO: baseEvent.endsAt!.toISOString(),
        timezone: "America/Chicago",
      },
    });
    // No humanId → no persisted unlock.
    expect(deps.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("reports to Sentry when the signed-in notify send throws", async () => {
    const notifyError = new Error("notify boom");
    deps.notify.mockRejectedValueOnce(notifyError);

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "APPROVED",
    });

    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(notifyError, {
      tags: {
        useCase: "reviewEventApplicationSubmission",
        channel: "notify",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
  });

  it("reports to Sentry when the anonymous claim email send throws", async () => {
    deps = createDeps({ submission: { humanId: null } });
    const mailError = new Error("mailer boom");
    deps.mailerSend.mockRejectedValueOnce(mailError);

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "APPROVED",
    });

    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(mailError, {
      tags: {
        useCase: "reviewEventApplicationSubmission",
        channel: "anonEmail",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
  });

  it("hands the raw title to the template (it escapes) and builds no HTML in core", async () => {
    deps = createDeps({
      event: { title: "<script>alert(1)</script> Show" },
      submission: { humanId: null },
    });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "APPROVED",
    });

    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      html?: string;
      template: { variables: Record<string, unknown> };
    };
    expect(sent.html).toBeUndefined();
    expect(sent.template.variables.eventTitle).toBe(
      "<script>alert(1)</script> Show",
    );
  });

  it("applies explicit TTL overrides", async () => {
    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
        approvalTokenTtlMinutes: 30,
      },
    );

    expect(result.submission.tokenExpiresAt).toEqual(
      new Date(NOW.getTime() + 30 * 60 * 1000),
    );
  });

  it("defaults the claim link to 7 days (owner decision 2026-09-30)", async () => {
    expect(__test__.DEFAULT_TOKEN_TTL_MINUTES).toBe(60 * 24 * 7);

    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      },
    );

    expect(result.submission.tokenExpiresAt).toEqual(
      new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    );
  });

  it("gives guests and signed-in applicants the org contact as Reply-To + template prop", async () => {
    deps = createDeps({
      submission: { humanId: null },
      org: { contactEmail: "hello@sunset.test" },
    });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "APPROVED",
    });

    expect(deps.organizationsRepo.getById).toHaveBeenCalledWith(ORG_ID);
    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      replyTo?: { to: string };
      template: { variables: Record<string, unknown> };
    };
    expect(sent.replyTo).toEqual({ to: "hello@sunset.test" });
    expect(sent.template.variables.organizerContactEmail).toBe(
      "hello@sunset.test",
    );
  });

  it("links the organizing org's PUBLIC page in a rejection (signed-in + guest)", async () => {
    const orgUrl = `${APP_BASE_URL}/orgs/sunset-page`;
    deps = createDeps({
      org: { page: { slug: "sunset-page", visibility: "PUBLIC" } },
    });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "REJECTED",
    });
    expect(deps.entityPagesRepo.getByOwner).toHaveBeenCalledWith(
      "ORGANIZATION",
      ORG_ID,
    );
    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "event.application-rejected",
        payload: expect.objectContaining({ organizerEventsUrl: orgUrl }),
      }),
    );

    const guestDeps = createDeps({
      submission: { humanId: null },
      org: { page: { slug: "sunset-page", visibility: "PUBLIC" } },
    });
    await reviewEventApplicationSubmission(buildUseCaseDeps(guestDeps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "REJECTED",
    });
    const sent = guestDeps.mailerSend.mock.calls[0]![0] as unknown as {
      template: { variables: Record<string, unknown> };
    };
    expect(sent.template.variables.organizerEventsUrl).toBe(orgUrl);
  });

  it("omits the org page link when the page isn't PUBLIC", async () => {
    deps = createDeps({
      submission: { humanId: null },
      org: { page: { slug: "sunset-page", visibility: "UNLISTED" } },
    });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "REJECTED",
    });

    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      template: { variables: Record<string, unknown> };
    };
    expect(sent.template.variables).not.toHaveProperty("organizerEventsUrl");
  });

  it("reports a failed guest rejection email, logs at error, and a throwing reporter changes nothing", async () => {
    deps = createDeps({ submission: { humanId: null } });
    const mailError = new Error("mailer boom");
    deps.mailerSend.mockRejectedValueOnce(mailError);
    deps.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
      },
    );

    expect(result.submission.status).toBe("REJECTED");
    expect(deps.reportError).toHaveBeenCalledWith(mailError, {
      tags: {
        useCase: "reviewEventApplicationSubmission",
        channel: "rejectionAnonEmail",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
    expect(deps.logger.error).toHaveBeenCalledWith(
      "events.reviewEventApplicationSubmission.rejectionAnonEmail_failed",
      expect.objectContaining({ err: mailError }),
    );
  });

  it("rejects a submission and clears tokens", async () => {
    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
      },
    );

    expect(result.submission.status).toBe("REJECTED");
    expect(result.submission.approvalToken).toBeNull();
    expect(result.submission.tokenExpiresAt).toBeNull();
    // Signed-in rejection notifies via notify() (no direct mailer email).
    expect(deps.mailerSend).not.toHaveBeenCalled();
    // Should NOT create unlock on rejection
    expect(deps.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("sends the rejection notification with the decision reason to a signed-in applicant", async () => {
    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
        decisionReason: "  We ran out of vendor spots this round.  ",
      },
    );

    // Sanitized + trimmed at the boundary, stored on the submission.
    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        status: "REJECTED",
        decisionReason: "We ran out of vendor spots this round.",
      }),
    );
    expect(result.submission.decisionReason).toBe(
      "We ran out of vendor spots this round.",
    );

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      variant: "event.application-rejected",
      payload: {
        eventId: EVENT_ID,
        eventTitle: baseEvent.title,
        submissionId: SUBMISSION_ID,
        decisionReason: "We ran out of vendor spots this round.",
      },
      scope: { kind: "EVENT", eventId: EVENT_ID },
      idempotencyKey: rejectionNotifyIdempotencyKey(SUBMISSION_ID, NOW),
      channels: { sms: { enabled: false } },
    });
    expect(deps.mailerSend).not.toHaveBeenCalled();
  });

  it("strips HTML from the decision reason before storing/sending", async () => {
    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "REJECTED",
      decisionReason: '<img src=x onerror=alert(1)>Full lineup already',
    });

    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ decisionReason: "Full lineup already" }),
    );
  });

  it("rejects a decision reason longer than 500 characters", async () => {
    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
        decisionReason: "x".repeat(501),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).not.toHaveBeenCalled();
  });

  it("rejects a decision reason on approval", async () => {
    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
        decisionReason: "not allowed here",
      }),
    ).rejects.toMatchObject({ issues: expect.any(Array) });
  });

  it("emails an anonymous applicant the rejection with the reason", async () => {
    deps = createDeps({ submission: { humanId: null } });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "REJECTED",
      decisionReason: "Full lineup already",
    });

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.mailerSend).toHaveBeenCalledTimes(1);
    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      to: { to: string };
      subject: string;
      text: string;
      html?: string;
      template: { key: string; variables: Record<string, unknown> };
    };
    expect(sent.to).toEqual({ to: baseSubmission.contactEmail });
    expect(sent.subject).toBe("Not approved: Secret show");
    expect(sent.text).toContain("Note from the organizer: Full lineup already");
    expect(sent.html).toBeUndefined();
    expect(sent.template).toEqual({
      key: "event.application_rejected",
      variables: {
        eventTitle: "Secret show",
        decisionReason: "Full lineup already",
      },
    });
  });

  it("passes the sanitized decision reason through unescaped (the template escapes)", async () => {
    deps = createDeps({ submission: { humanId: null } });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "REJECTED",
      // Sanitization strips tags; belt-and-braces: raw special chars that
      // survive sanitization must still be escaped at the HTML sink.
      decisionReason: "Tickets < $10 & > $5",
    });

    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      html?: string;
      text: string;
      template: { variables: Record<string, unknown> };
    };
    expect(sent.html).toBeUndefined();
    expect(sent.template.variables.decisionReason).toBe("Tickets < $10 & > $5");
    expect(sent.text).toContain("Tickets < $10 & > $5");
  });

  it("reports to Sentry when the rejection notify send throws", async () => {
    const notifyError = new Error("rejection notify boom");
    deps.notify.mockRejectedValueOnce(notifyError);

    const result = await reviewEventApplicationSubmission(
      buildUseCaseDeps(deps),
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
      },
    );

    // Swallowed — the decision still lands.
    expect(result.submission.status).toBe("REJECTED");
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(notifyError, {
      tags: {
        useCase: "reviewEventApplicationSubmission",
        channel: "rejectionNotify",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
  });

  it("does not notify when the submission is missing a human", async () => {
    deps = createDeps({ submission: { humanId: null } });

    await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      decision: "APPROVED",
    });

    expect(deps.notify).not.toHaveBeenCalled();
  });

  describe("decision-instance idempotency keys (rescind → re-decide)", () => {
    it.each([
      ["REJECTED", "event.application-rejected", "application-rejected"],
      ["WAITLISTED", "event.application-waitlisted", "application-waitlisted"],
    ] as const)(
      "%s → rescind → %s sends a second notice under a distinct key",
      async (decision, variant, prefix) => {
        makeSubmissionStateful(deps);
        // notify()'s replay semantics: a reused key with the SAME payload is
        // silently replayed (the newer email is dropped) — so the second
        // notice only goes out if its key differs.
        const sent: string[] = [];
        const seen = new Set<string>();
        deps.notify.mockImplementation(async (input: NotifyInput) => {
          if (input.variant === variant && !seen.has(input.idempotencyKey!)) {
            sent.push(input.idempotencyKey!);
          }
          seen.add(input.idempotencyKey ?? "");
          return {
            ok: true,
            variant: input.variant,
            category: "transactional",
            scope: { kind: "GLOBAL" },
            inApp: { status: "skipped", reason: "channel_disabled" },
          } as NotifyOutput;
        });
        const decide = () =>
          reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
            actorHumanId: ACTOR_ID,
            eventId: EVENT_ID,
            submissionId: SUBMISSION_ID,
            decision,
          });

        const first = await decide();
        await rescind(deps);
        const second = await decide();

        const firstAt = first.submission.reviewedAt!;
        const secondAt = second.submission.reviewedAt!;
        expect(secondAt.getTime()).toBeGreaterThan(firstAt.getTime());
        expect(sent).toEqual([
          `${prefix}:${SUBMISSION_ID}:${firstAt.getTime()}`,
          `${prefix}:${SUBMISSION_ID}:${secondAt.getTime()}`,
        ]);
        expect(deps.reportError).not.toHaveBeenCalled();
      },
    );

    it("a retry of the SAME decision instance reuses its key", () => {
      expect(rejectionNotifyIdempotencyKey(SUBMISSION_ID, NOW)).toBe(
        rejectionNotifyIdempotencyKey(SUBMISSION_ID, new Date(NOW)),
      );
      expect(waitlistNotifyIdempotencyKey(SUBMISSION_ID, NOW)).toBe(
        `application-waitlisted:${SUBMISSION_ID}:${NOW.getTime()}`,
      );
    });
  });

  describe("WAITLISTED decision (spec Phase 2)", () => {
    it("sets the status and writes a waitlist entry with source APPLICATION + submissionId linkback", async () => {
      const result = await reviewEventApplicationSubmission(
        buildUseCaseDeps(deps),
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "WAITLISTED",
        },
      );

      expect(
        deps.eventApplicationsRepo.updateSubmissionStatus,
      ).toHaveBeenCalledWith({
        submissionId: SUBMISSION_ID,
        status: "WAITLISTED",
        reviewerHumanId: ACTOR_ID,
        reviewedAt: NOW,
        approvalToken: null,
        tokenExpiresAt: null,
        decisionReason: null,
        expectedFromStatuses: ["PENDING", "EXPIRED"],
      });
      expect(deps.eventWaitlistsRepo.createEntry).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        humanId: HUMAN_ID,
        contactEmail: baseSubmission.contactEmail,
        contactPhone: baseSubmission.contactPhone,
        source: "APPLICATION",
        status: "PENDING",
        metadata: { submissionId: SUBMISSION_ID },
      });
      // No approval side effects.
      expect(deps.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
      expect(result.submission.status).toBe("WAITLISTED");
      expect(result.submission.approvalToken).toBeNull();
      expect(deps.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toStatus: "WAITLISTED",
            waitlistEntryId: "e0000000-0000-4000-8000-00000000000e",
          }),
        }),
      );
    });

    it("links an EXISTING entry instead of erroring (dedupe: one entry per event+person)", async () => {
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce({
        id: "f0000000-0000-4000-8000-00000000000f",
        eventId: EVENT_ID,
        humanId: HUMAN_ID,
        contactEmail: baseSubmission.contactEmail,
        contactPhone: null,
        source: "PUBLIC",
        status: "NOTIFIED",
        metadata: { note: "keep me" },
        notifiedAt: NOW,
        convertedOrderId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "WAITLISTED",
      });

      expect(deps.eventWaitlistsRepo.createEntry).not.toHaveBeenCalled();
      // Metadata merged (existing keys preserved) + linkback; NOTIFIED
      // status preserved (only DROPPED entries are revived).
      expect(deps.eventWaitlistsRepo.updateEntry).toHaveBeenCalledWith({
        entryId: "f0000000-0000-4000-8000-00000000000f",
        status: "NOTIFIED",
        metadata: { note: "keep me", submissionId: SUBMISSION_ID },
        updatedAt: NOW,
      });
    });

    it("revives a previously DROPPED entry to PENDING", async () => {
      deps.eventWaitlistsRepo.findEntry.mockResolvedValueOnce({
        id: "f0000000-0000-4000-8000-00000000000f",
        eventId: EVENT_ID,
        humanId: HUMAN_ID,
        contactEmail: baseSubmission.contactEmail,
        contactPhone: null,
        source: "APPLICATION",
        status: "DROPPED",
        metadata: {},
        notifiedAt: null,
        convertedOrderId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "WAITLISTED",
      });

      expect(deps.eventWaitlistsRepo.updateEntry).toHaveBeenCalledWith(
        expect.objectContaining({ status: "PENDING" }),
      );
    });

    it("sends the neutral waitlist notification to a signed-in applicant", async () => {
      await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "WAITLISTED",
      });

      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(deps.notify).toHaveBeenCalledWith({
        humanId: HUMAN_ID,
        variant: "event.application-waitlisted",
        payload: {
          eventId: EVENT_ID,
          eventTitle: baseEvent.title,
          submissionId: SUBMISSION_ID,
          eventUrl: `${APP_BASE_URL}/events/secret`,
        },
        scope: { kind: "EVENT", eventId: EVENT_ID },
        idempotencyKey: waitlistNotifyIdempotencyKey(SUBMISSION_ID, NOW),
        channels: { sms: { enabled: false } },
      });
      expect(deps.mailerSend).not.toHaveBeenCalled();
    });

    it("emails an anonymous applicant the neutral waitlist copy", async () => {
      deps = createDeps({ submission: { humanId: null } });

      await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "WAITLISTED",
      });

      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.mailerSend).toHaveBeenCalledTimes(1);
      const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
        subject: string;
        text: string;
        html?: string;
        template: { key: string; variables: Record<string, unknown> };
      };
      expect(sent.subject).toBe("Waitlisted: Secret show");
      expect(sent.text).toContain("If a spot opens, we'll email you a link.");
      expect(sent.html).toBeUndefined();
      expect(sent.template).toEqual({
        key: "event.application_waitlisted",
        variables: {
          eventTitle: "Secret show",
          eventUrl: `${APP_BASE_URL}/events/secret`,
          // Guest leg: hides the status link anonymous viewers can't use.
          isGuest: true,
        },
      });
    });

    it("reports to Sentry when the waitlist notify send throws", async () => {
      deps.notify.mockRejectedValueOnce(new Error("notify boom"));

      const result = await reviewEventApplicationSubmission(
        buildUseCaseDeps(deps),
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "WAITLISTED",
        },
      );

      // Decision committed regardless — deliberate swallow + report.
      expect(result.submission.status).toBe("WAITLISTED");
      expect(deps.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ channel: "waitlistNotify" }),
        }),
      );
    });

    it("rejects a decision reason on a waitlist decision (neutral copy only)", async () => {
      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "WAITLISTED",
          decisionReason: "You're third in line",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects TTL controls on a waitlist decision", async () => {
      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "WAITLISTED",
          approvalTokenTtlMinutes: 60,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("from-status guards (reviewable = PENDING | EXPIRED)", () => {
    it.each([
      // Applicant-owned: deciding would mint access + email against their
      // expressed intent.
      ["WITHDRAWN", "APPROVED"],
      ["WITHDRAWN", "REJECTED"],
      ["WITHDRAWN", "WAITLISTED"],
      // Already-decided: changing a decision is rescind-then-decide, because
      // deciding straight over one performs no unwind (an APPROVED→REJECTED
      // would leave the durable EventUnlock; WAITLISTED→REJECTED would
      // strand the waitlist linkback).
      ["APPROVED", "REJECTED"],
      ["APPROVED", "WAITLISTED"],
      ["REJECTED", "APPROVED"],
      ["WAITLISTED", "REJECTED"],
      ["WAITLISTED", "APPROVED"],
    ] as const)(
      "throws INVALID_STATUS when deciding %s → %s",
      async (fromStatus, decision) => {
        deps = createDeps({
          submission: {
            status: fromStatus,
            approvalToken: null,
            tokenExpiresAt: null,
          },
        });

        await expect(
          reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
            actorHumanId: ACTOR_ID,
            eventId: EVENT_ID,
            submissionId: SUBMISSION_ID,
            decision,
          }),
        ).rejects.toMatchObject({ code: "INVALID_STATUS" });
        expect(
          deps.eventApplicationsRepo.updateSubmissionStatus,
        ).not.toHaveBeenCalled();
        expect(deps.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
        expect(deps.eventWaitlistsRepo.createEntry).not.toHaveBeenCalled();
        expect(deps.notify).not.toHaveBeenCalled();
      },
    );

    it("guards every decision write with a PENDING|EXPIRED compare-and-swap", async () => {
      await reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
      });

      expect(
        deps.eventApplicationsRepo.updateSubmissionStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedFromStatuses: ["PENDING", "EXPIRED"],
        }),
      );
    });

    it("maps a lost CAS (withdraw committed mid-review) to INVALID_STATUS with NO side effects", async () => {
      // The in-tx read saw PENDING; the applicant's withdraw committed
      // before our write, so the guarded update matched zero rows.
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValueOnce({
        code: "conflict",
        message: "application_submission_status_changed",
      });

      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "APPROVED",
        }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });

      // The status write runs FIRST, so a lost race mints no unlock and
      // sends no approval email.
      expect(deps.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.auditRepo.log).not.toHaveBeenCalled();
    });

    it("maps a lost CAS on a WAITLISTED decision before any waitlist entry is written", async () => {
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValueOnce({
        code: "conflict",
        message: "application_submission_status_changed",
      });

      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "WAITLISTED",
        }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });

      expect(deps.eventWaitlistsRepo.createEntry).not.toHaveBeenCalled();
      expect(deps.eventWaitlistsRepo.updateEntry).not.toHaveBeenCalled();
    });

    it("rethrows a non-conflict repo error unchanged", async () => {
      const boom = new Error("db down");
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValueOnce(
        boom,
      );

      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "REJECTED",
        }),
      ).rejects.toBe(boom);
    });

    it("DELIBERATELY allows approving an EXPIRED submission (late-approval escape hatch)", async () => {
      deps = createDeps({
        submission: {
          status: "EXPIRED",
          approvalToken: null,
          tokenExpiresAt: null,
        },
      });

      const result = await reviewEventApplicationSubmission(
        buildUseCaseDeps(deps),
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "APPROVED",
        },
      );

      expect(result.submission.status).toBe("APPROVED");
      expect(deps.eventUnlocksRepo.upsert).toHaveBeenCalled();
    });
  });

  it("throws when TTL is provided for a rejection", async () => {
    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "REJECTED",
        approvalTokenTtlMinutes: 60,
      }),
    ).rejects.toMatchObject({ issues: expect.any(Array) });
  });

  it("throws when the expiration is in the past", async () => {
    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
        approvalTokenExpiresAt: new Date("2025-12-01T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRATION_IN_PAST" });
  });

  it("throws when the submission belongs to another event", async () => {
    deps = createDeps({ submission: { eventId: "other-event" } });

    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "SUBMISSION_EVENT_MISMATCH" });
  });

  it("treats a PERFORM (open-call) submission as not found and writes nothing", async () => {
    // Open calls v1: this is the attendee review path. Approving a PERFORM
    // submission here would mint an EventUnlock through applyApprovalDecision,
    // which never goes through lockApprovedSubmission.
    deps = createDeps({ submission: { purpose: "PERFORM" } });

    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
    expect(
      deps.eventApplicationsRepo.updateSubmissionStatus,
    ).not.toHaveBeenCalled();
    expect(deps.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("throws when the event is not application gated", async () => {
    deps = createDeps({ event: { gateType: "PASSWORD" } });

    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });

  it("throws when the actor lacks permission", async () => {
    deps = createDeps({ membership: null });

    await expect(
      reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });


  // ── DB open-set collision on the decision write ─────────────────────────
  // Real organizer flow: a guest applies -> the window closes -> the nightly
  // sweep marks the row EXPIRED -> the guest legitimately re-applies (allowed
  // from EXPIRED) -> the organizer now approves the STALE row. That write puts
  // a second open row on (eventId, lower(contactEmail)) and the partial unique
  // index rejects it. Unmapped it 500s and rolls back the whole review.
  describe("duplicate open application (P2002 from the decision write)", () => {
    it("surfaces APPLICATION_ALREADY_SUBMITTED when APPROVING a stale row the applicant re-applied past", async () => {
      deps = createDeps();
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValue({
        code: "duplicate_open_application",
        message: "duplicate_open_application",
      });

      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "APPROVED",
        }),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
    });

    it("surfaces APPLICATION_ALREADY_SUBMITTED on a REJECTED/WAITLISTED decision too", async () => {
      deps = createDeps();
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValue({
        code: "duplicate_open_application",
        message: "duplicate_open_application",
      });

      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "WAITLISTED",
        }),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
    });

    it("still maps the CAS conflict to INVALID_STATUS (the two are not conflated)", async () => {
      deps = createDeps();
      deps.eventApplicationsRepo.updateSubmissionStatus.mockRejectedValue({
        code: "conflict",
        message: "application_submission_status_changed",
      });

      await expect(
        reviewEventApplicationSubmission(buildUseCaseDeps(deps), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          submissionId: SUBMISSION_ID,
          decision: "REJECTED",
        }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    });
  });
});
