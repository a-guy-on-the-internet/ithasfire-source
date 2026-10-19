import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type {
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
} from "@th/ports/repos";
import type { EventInviteRecord } from "@th/ports/repos/events";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { loadApprovedApplicationGrantSubmission } from "../_shared/application-gate-grant";
import { getEventGateState } from "../get-event-gate-state";

/**
 * The application grant is the anonymous approved applicant's way through an
 * APPLICATION gate. It must be REVOCABLE: every check re-reads the submission
 * and requires APPROVED for THIS event, and it must never open a PASSWORD gate.
 */

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-00000000000a";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const VIEWER_ID = "80000000-0000-4000-8000-000000000008";
const NOW = new Date("2025-12-05T12:00:00Z");
/** The grant as the transport hands it over: bound to the approval at NOW. */
const GRANT = { submissionId: SUBMISSION_ID, approvedAtMs: NOW.getTime() };

const submission = (
  overrides: Partial<EventApplicationSubmissionRecord> = {},
): EventApplicationSubmissionRecord => ({
  id: SUBMISSION_ID,
  formId: "a0000000-0000-4000-8000-0000000000f0",
  purpose: "ATTEND",
  eventId: EVENT_ID,
  humanId: null,
  contactEmail: "guest@example.com",
  contactPhone: null,
  status: "APPROVED",
  answers: {},
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: "reviewer",
  reviewedAt: NOW,
  approvalToken: "tok",
  tokenExpiresAt: NOW,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("loadApprovedApplicationGrantSubmission", () => {
  const appEvent = { id: EVENT_ID, gateType: "APPLICATION" } as const;

  const repoReturning = (record: EventApplicationSubmissionRecord | null) => ({
    getSubmissionById: vi.fn(async () => record),
  });
  const reposFor = (
    eventApplications: Pick<
      Repos["eventApplications"],
      "getSubmissionById"
    >,
    invite: EventInviteRecord | null = null,
  ) => ({
    eventApplications,
    eventInvites: { getById: vi.fn(async () => invite) },
  });
  const INVITE_ID = "90000000-0000-4000-8000-000000000009";
  const invite = (
    overrides: Partial<EventInviteRecord> = {},
  ): EventInviteRecord =>
    ({
      id: INVITE_ID,
      eventId: EVENT_ID,
      kind: "PERSONAL",
      revokedAt: null,
      grantsRevokedAt: null,
      ...overrides,
    }) as EventInviteRecord;

  // R9 on the read path: the revoke's per-submission rescind phase may not
  // reach every approval, so a revoked PERSONAL invite's approvals must stop
  // opening the gate on their own.
  it("returns null for an approval from a REVOKED PERSONAL invite (R9)", async () => {
    const repos = reposFor(
      repoReturning(submission({ inviteId: INVITE_ID })),
      invite({ revokedAt: NOW }),
    );
    await expect(
      loadApprovedApplicationGrantSubmission(repos, appEvent, GRANT),
    ).resolves.toBeNull();
    expect(repos.eventInvites.getById).toHaveBeenCalledWith(INVITE_ID);
  });

  it("keeps an approval from a LIVE PERSONAL invite", async () => {
    const repos = reposFor(
      repoReturning(submission({ inviteId: INVITE_ID })),
      invite(),
    );
    await expect(
      loadApprovedApplicationGrantSubmission(repos, appEvent, GRANT),
    ).resolves.toMatchObject({ id: SUBMISSION_ID });
  });

  it("keeps an approval from a RESET SHARED link (R5: a reset keeps people in)", async () => {
    const repos = reposFor(
      repoReturning(submission({ inviteId: INVITE_ID })),
      invite({ kind: "SHARED", revokedAt: NOW }),
    );
    await expect(
      loadApprovedApplicationGrantSubmission(repos, appEvent, GRANT),
    ).resolves.toMatchObject({ id: SUBMISSION_ID });
  });

  it("returns null for an approval from a SHARED link whose grants were removed (Reset and remove everyone)", async () => {
    const repos = reposFor(
      repoReturning(submission({ inviteId: INVITE_ID })),
      invite({ kind: "SHARED", revokedAt: NOW, grantsRevokedAt: NOW }),
    );
    await expect(
      loadApprovedApplicationGrantSubmission(repos, appEvent, GRANT),
    ).resolves.toBeNull();
  });

  it("does not look up an invite for a non-invite approval", async () => {
    const repos = reposFor(repoReturning(submission({ inviteId: null })));
    await expect(
      loadApprovedApplicationGrantSubmission(repos, appEvent, GRANT),
    ).resolves.toMatchObject({ id: SUBMISSION_ID });
    expect(repos.eventInvites.getById).not.toHaveBeenCalled();
  });

  it("propagates an invite lookup failure instead of reading it as open", async () => {
    const repos = {
      eventApplications: repoReturning(submission({ inviteId: INVITE_ID })),
      eventInvites: {
        getById: vi.fn(async () => {
          throw new Error("invites down");
        }),
      },
    };
    await expect(
      loadApprovedApplicationGrantSubmission(repos, appEvent, GRANT),
    ).rejects.toThrow("invites down");
  });

  it("returns the submission when it is APPROVED for this APPLICATION event", async () => {
    const repo = repoReturning(submission());
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).resolves.toMatchObject({ id: SUBMISSION_ID });
    expect(repo.getSubmissionById).toHaveBeenCalledWith(SUBMISSION_ID);
  });

  it.each(["PENDING", "REJECTED", "WITHDRAWN", "WAITLISTED", "EXPIRED"] as const)(
    "returns null once the submission is %s (rescind / withdraw / reject revoke the grant)",
    async (status) => {
      const repo = repoReturning(submission({ status }));
      await expect(
        loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
      ).resolves.toBeNull();
    },
  );

  it("returns null when the submission was approved AGAIN after the grant's approval (rescind → re-approve)", async () => {
    const repo = repoReturning(
      submission({ reviewedAt: new Date(NOW.getTime() + 3_600_000) }),
    );
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).resolves.toBeNull();
  });

  it("returns null for an APPROVED submission with no approval stamp (fails closed)", async () => {
    const repo = repoReturning(submission({ reviewedAt: null }));
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).resolves.toBeNull();
  });

  it("returns null for an APPROVED PERFORM (open-call) submission: only ATTEND opens the gate", async () => {
    const repo = repoReturning(submission({ purpose: "PERFORM" }));
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).resolves.toBeNull();
  });

  it("returns null for a submission that belongs to ANOTHER event", async () => {
    const repo = repoReturning(submission({ eventId: OTHER_EVENT_ID }));
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).resolves.toBeNull();
  });

  it("returns null for an unknown submission", async () => {
    const repo = repoReturning(null);
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).resolves.toBeNull();
  });

  it.each(["PASSWORD", "NONE"] as const)(
    "never opens a %s event, and does not even look the submission up",
    async (gateType) => {
      const repo = repoReturning(submission());
      await expect(
        loadApprovedApplicationGrantSubmission(
          reposFor(repo),
          { id: EVENT_ID, gateType },
          GRANT,
        ),
      ).resolves.toBeNull();
      expect(repo.getSubmissionById).not.toHaveBeenCalled();
    },
  );

  it("returns null without a lookup when there is no grant", async () => {
    const repo = repoReturning(submission());
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, null),
    ).resolves.toBeNull();
    expect(repo.getSubmissionById).not.toHaveBeenCalled();
  });

  it("propagates a lookup failure instead of reading it as open", async () => {
    const repo = {
      getSubmissionById: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    await expect(
      loadApprovedApplicationGrantSubmission(reposFor(repo), appEvent, GRANT),
    ).rejects.toThrow("db down");
  });
});

describe("getEventGateState — application grant", () => {
  const makeDeps = (
    opts: {
      gateType?: "APPLICATION" | "PASSWORD" | "NONE";
      submission?: EventApplicationSubmissionRecord | null;
      viewerIsUnlocked?: boolean;
    } = {},
  ) => {
    const event = {
      id: EVENT_ID,
      orgId: "org-1",
      humanId: null,
      gateType: opts.gateType ?? "APPLICATION",
      visibility: "PUBLIC",
      status: "PUBLISHED",
      publishedAt: new Date("2025-11-01T00:00:00Z"),
      stewardship: "OWNED",
      passwordHash: "set",
      waitlistStatus: "DISABLED",
      waitlistPublishAt: null,
      waitlistDescription: null,
      waitlistCap: null,
    } as unknown as EventRecord;
    const eventApplications = {
      getSubmissionById: vi.fn(async () =>
        opts.submission === undefined ? submission() : opts.submission,
      ),
    };
    const eventUnlocks = {
      isUnlocked: vi.fn(async () => opts.viewerIsUnlocked ?? false),
    };
    const clock: ClockPort = { now: () => NOW };
    return {
      eventApplications,
      eventUnlocks,
      deps: {
        repos: {
          events: { getById: vi.fn(async () => event) },
          authz: { getOrgMembership: vi.fn(async () => null) },
          eventUnlocks,
          eventApplications,
        } as unknown as Repos,
        authz: { hasStaffRole: async () => ({ allowed: false }) },
        clock,
        logger: createTestLogger(),
      },
    };
  };

  it("an APPROVED grant opens the APPLICATION gate for an anonymous viewer", async () => {
    const { deps } = makeDeps();
    const state = await getEventGateState(deps, {
      eventId: EVENT_ID,
      viewerHumanId: null,
      applicationGrant: GRANT,
    });
    expect(state).toMatchObject({
      gateType: "APPLICATION",
      applicationRequired: false,
      viewerHasApplicationGrant: true,
      viewerIsUnlocked: false,
    });
  });

  it("stays locked without a grant", async () => {
    const { deps, eventApplications } = makeDeps();
    const state = await getEventGateState(deps, {
      eventId: EVENT_ID,
      viewerHumanId: null,
    });
    expect(state).toMatchObject({
      applicationRequired: true,
      viewerHasApplicationGrant: false,
    });
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });

  it("locks again the moment the decision is rescinded (submission back to PENDING)", async () => {
    const { deps } = makeDeps({ submission: submission({ status: "PENDING" }) });
    const state = await getEventGateState(deps, {
      eventId: EVENT_ID,
      viewerHumanId: null,
      applicationGrant: GRANT,
    });
    expect(state).toMatchObject({
      applicationRequired: true,
      viewerHasApplicationGrant: false,
    });
  });

  it("rescind → re-approve: the old grant stays locked, the new approval's grant opens", async () => {
    const row = submission();
    const { deps } = makeDeps({ submission: row });
    const read = (grant: typeof GRANT) =>
      getEventGateState(deps, {
        eventId: EVENT_ID,
        viewerHumanId: null,
        applicationGrant: grant,
      });

    await expect(read(GRANT)).resolves.toMatchObject({ applicationRequired: false });

    // Rescind (what rescindEventApplicationDecision writes).
    row.status = "PENDING";
    row.reviewedAt = null;
    await expect(read(GRANT)).resolves.toMatchObject({ applicationRequired: true });

    // Re-approve (applyApprovalDecision stamps a fresh reviewedAt).
    const reApprovedAt = new Date(NOW.getTime() + 3_600_000);
    row.status = "APPROVED";
    row.reviewedAt = reApprovedAt;
    await expect(read(GRANT)).resolves.toMatchObject({
      applicationRequired: true,
      viewerHasApplicationGrant: false,
    });
    await expect(
      read({ submissionId: SUBMISSION_ID, approvedAtMs: reApprovedAt.getTime() }),
    ).resolves.toMatchObject({
      applicationRequired: false,
      viewerHasApplicationGrant: true,
    });
  });

  it("a grant naming another event's submission stays locked", async () => {
    const { deps } = makeDeps({
      submission: submission({ eventId: OTHER_EVENT_ID }),
    });
    const state = await getEventGateState(deps, {
      eventId: EVENT_ID,
      viewerHumanId: null,
      applicationGrant: GRANT,
    });
    expect(state.applicationRequired).toBe(true);
  });

  it("an APPROVED grant does NOT open a PASSWORD gate", async () => {
    const { deps, eventApplications } = makeDeps({ gateType: "PASSWORD" });
    const state = await getEventGateState(deps, {
      eventId: EVENT_ID,
      viewerHumanId: null,
      applicationGrant: GRANT,
    });
    expect(state).toMatchObject({
      gateType: "PASSWORD",
      passwordRequired: true,
      viewerHasApplicationGrant: false,
    });
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });

  it("signed-in subject path unchanged: a durable unlock opens the gate with no grant lookup", async () => {
    const { deps, eventApplications, eventUnlocks } = makeDeps({
      viewerIsUnlocked: true,
    });
    const state = await getEventGateState(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      applicationGrant: GRANT,
    });
    expect(state).toMatchObject({
      applicationRequired: false,
      viewerIsUnlocked: true,
      viewerHasApplicationGrant: false,
    });
    expect(eventUnlocks.isUnlocked).toHaveBeenCalledWith(EVENT_ID, VIEWER_ID);
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });
});
