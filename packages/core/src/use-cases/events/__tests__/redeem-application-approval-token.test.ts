import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type {
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
} from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { redeemApplicationApprovalToken } from "../redeem-application-approval-token";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-00000000000a";
const VIEWER_ID = "80000000-0000-4000-8000-000000000008";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const TOKEN = "approvaltoken0123456789abcdef";
const NOW = new Date("2025-12-05T12:00:00Z");
const FUTURE = new Date("2025-12-06T12:00:00Z");
const PAST = new Date("2025-12-04T12:00:00Z");

const baseEvent = {
  id: EVENT_ID,
  slug: "secret-show",
} as unknown as EventRecord;

const baseSubmission: EventApplicationSubmissionRecord = {
  id: SUBMISSION_ID,
  // Open calls v1: the submission's form. ATTEND = the attendee gate.
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
  approvalToken: TOKEN,
  tokenExpiresAt: FUTURE,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const INVITE_ID = "90000000-0000-4000-8000-000000000009";

function makeDeps(
  overrides: {
    submission?: Partial<EventApplicationSubmissionRecord> | null;
    event?: EventRecord | null;
    /** Redeemer's account identity, for the guest→account attach path. */
    viewerIdentity?: { email: string; emailVerified: boolean } | null;
    /** `null` = the attach CAS lost (already claimed / open-human conflict). */
    attachResult?: EventApplicationSubmissionRecord | null;
    /** Runs after the APPROVED read, before the locked write (a racing rescind). */
    betweenReadAndWrite?: (row: EventApplicationSubmissionRecord) => void;
    /** The invite `submission.inviteId` points at (invite approvals). */
    invite?: { kind: "SHARED" | "PERSONAL"; revokedAt: Date | null } | null;
  } = {},
) {
  const submissionValue =
    overrides.submission === null
      ? null
      : { ...baseSubmission, ...(overrides.submission ?? {}) };
  const eventValue =
    overrides.event === undefined ? baseEvent : overrides.event;

  const calls: string[] = [];
  const eventApplicationsRepo = {
    // A snapshot, so a later "rescind" mutation of the row is not seen by
    // the read that already happened.
    getSubmissionByToken: vi.fn(async () =>
      submissionValue ? { ...submissionValue } : null,
    ),
    updateSubmissionStatus: vi.fn(async () => submissionValue),
    attachSubmissionToHuman: vi.fn(async () =>
      overrides.attachResult === undefined
        ? submissionValue
          ? { ...submissionValue, humanId: VIEWER_ID }
          : null
        : overrides.attachResult,
    ),
    // Checks the CURRENT row, the way the adapter's guarded UPDATE does.
    lockApprovedSubmission: vi.fn(
      async (lock: { submissionId: string; eventId: string; reviewedAt: Date }) => {
        calls.push("lock");
        if (!submissionValue) return false;
        overrides.betweenReadAndWrite?.(submissionValue);
        return (
          submissionValue.id === lock.submissionId &&
          submissionValue.eventId === lock.eventId &&
          submissionValue.status === "APPROVED" &&
          submissionValue.reviewedAt?.getTime() === lock.reviewedAt.getTime()
        );
      },
    ),
  };
  // Default identity MATCHES the guest submission's contactEmail and is
  // verified, so the happy attach path is the default.
  const identity =
    overrides.viewerIdentity === undefined
      ? { email: "guest@example.com", emailVerified: true }
      : overrides.viewerIdentity;
  const humansRepo = {
    getByIdWithIdentity: vi.fn(async () =>
      identity ? { human: { id: VIEWER_ID }, identity } : null,
    ),
  };
  const eventsRepo = {
    getById: vi.fn(async () => eventValue),
  };
  const eventUnlocksRepo = {
    upsert: vi.fn(async () => {
      calls.push("upsert");
      return { id: "unlock-id" };
    }),
  };

  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const repos: Record<string, unknown> = {
    events: eventsRepo,
    eventApplications: eventApplicationsRepo,
    eventUnlocks: eventUnlocksRepo,
    humans: humansRepo,
    eventInvites: {
      getById: vi.fn(async (id: string) =>
        overrides.invite ? { id, eventId: EVENT_ID, ...overrides.invite } : null,
      ),
      lockIfLive: vi.fn(async () => !!overrides.invite && !overrides.invite.revokedAt),
    },
  };
  repos.tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push("tx:begin");
    try {
      return await fn(repos);
    } finally {
      calls.push("tx:end");
    }
  });
  const deps = {
    repos: repos as unknown as Repos,
    clock,
    logger: createTestLogger(),
  };

  return {
    deps,
    calls,
    eventApplicationsRepo,
    eventsRepo,
    eventUnlocksRepo,
    humansRepo,
  };
}

describe("redeemApplicationApprovalToken", () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it("persists a humanId unlock for the signed-in APPLICANT (the submission's subject)", async () => {
    ctx = makeDeps({ submission: { humanId: VIEWER_ID } });

    const result = await redeemApplicationApprovalToken(ctx.deps, {
      eventId: EVENT_ID,
      token: TOKEN,
      viewerHumanId: VIEWER_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      // Signed into the web claim route's application grant cookie.
      submissionId: SUBMISSION_ID,
      // The approval instance the claim route binds the grant to.
      approvedAt: NOW,
      slug: "secret-show",
      unlocked: true,
      persisted: true,
      // Already owned by the viewer: nothing to attach.
      attached: false,
    });
    expect(ctx.eventUnlocksRepo.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: VIEWER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
    });
    expect(
      ctx.eventApplicationsRepo.attachSubmissionToHuman,
    ).not.toHaveBeenCalled();
    // Non-consuming: token is never invalidated.
    expect(ctx.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it("writes the subject's unlock inside one transaction, under the approval lock", async () => {
    ctx = makeDeps({ submission: { humanId: VIEWER_ID } });

    await redeemApplicationApprovalToken(ctx.deps, {
      eventId: EVENT_ID,
      token: TOKEN,
      viewerHumanId: VIEWER_ID,
    });

    expect(ctx.calls).toEqual(["tx:begin", "lock", "upsert", "tx:end"]);
    expect(ctx.eventApplicationsRepo.lockApprovedSubmission).toHaveBeenCalledWith({
      submissionId: SUBMISSION_ID,
      eventId: EVENT_ID,
      // Only an ATTEND approval may mint an EventUnlock.
      purpose: "ATTEND",
      reviewedAt: NOW,
    });
  });

  it("rescind wins: a rescind landing between the APPROVED read and the write leaves no unlock", async () => {
    ctx = makeDeps({
      submission: { humanId: VIEWER_ID },
      betweenReadAndWrite: (row) => {
        row.status = "PENDING";
        row.reviewedAt = null;
        row.approvalToken = null;
      },
    });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
    expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("throws APPLICATION_TOKEN_INVALID for an approval from a REVOKED PERSONAL invite, and writes no unlock (R9)", async () => {
    ctx = makeDeps({
      submission: { humanId: VIEWER_ID, inviteId: INVITE_ID },
      invite: { kind: "PERSONAL", revokedAt: NOW },
    });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
    expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("an invite approval from a LIVE invite redeems, and the unlock carries the inviteId (phase-1 revocable)", async () => {
    ctx = makeDeps({
      submission: { humanId: VIEWER_ID, inviteId: INVITE_ID },
      invite: { kind: "PERSONAL", revokedAt: null },
    });

    await redeemApplicationApprovalToken(ctx.deps, {
      eventId: EVENT_ID,
      token: TOKEN,
      viewerHumanId: VIEWER_ID,
    });
    expect(ctx.eventUnlocksRepo.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: VIEWER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
      inviteId: INVITE_ID,
    });
  });

  it("a PERSONAL revoke landing after the token check: no unlock, APPLICATION_TOKEN_INVALID", async () => {
    const invite = { kind: "PERSONAL" as const, revokedAt: null as Date | null };
    ctx = makeDeps({
      submission: { humanId: VIEWER_ID, inviteId: INVITE_ID },
      invite,
      betweenReadAndWrite: () => {
        invite.revokedAt = NOW;
      },
    });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
    expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("throws APPLICATION_TOKEN_INVALID for an APPROVED row with no approval stamp (fails closed)", async () => {
    ctx = makeDeps({ submission: { reviewedAt: null } });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: null,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
  });

  it("throws APPLICATION_TOKEN_INVALID for a PERFORM (open-call) submission's token and writes no unlock", async () => {
    ctx = makeDeps({ submission: { purpose: "PERFORM" } });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
    expect(ctx.calls).not.toContain("upsert");
  });

  it("attaches an ownerless guest submission to the matching account, THEN persists its unlock", async () => {
    const result = await redeemApplicationApprovalToken(ctx.deps, {
      eventId: EVENT_ID,
      token: TOKEN,
      viewerHumanId: VIEWER_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      // Signed into the web claim route's application grant cookie.
      submissionId: SUBMISSION_ID,
      // The approval instance the claim route binds the grant to.
      approvedAt: NOW,
      slug: "secret-show",
      unlocked: true,
      persisted: true,
      // Default fixture: an ownerless guest submission + a verified,
      // matching account email → the submission gets bound to the redeemer.
      attached: true,
    });
    expect(ctx.eventUnlocksRepo.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: VIEWER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
    });
    // Non-consuming: token is never invalidated.
    expect(ctx.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it("does NOT persist a durable unlock for a DIFFERENT signed-in account (forwarded link)", async () => {
    // Owned by someone else; the viewer merely holds the bearer link.
    ctx = makeDeps({
      submission: { humanId: "90000000-0000-4000-8000-000000000009" },
    });

    const result = await redeemApplicationApprovalToken(ctx.deps, {
      eventId: EVENT_ID,
      token: TOKEN,
      viewerHumanId: VIEWER_ID,
    });

    // Same outcome as an anonymous clicker: the token is valid (the web
    // route sets its 24h cookie), but no per-account grant is minted.
    expect(result).toEqual({
      eventId: EVENT_ID,
      // Signed into the web claim route's application grant cookie.
      submissionId: SUBMISSION_ID,
      // The approval instance the claim route binds the grant to.
      approvedAt: NOW,
      slug: "secret-show",
      unlocked: true,
      persisted: false,
      attached: false,
    });
    expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
    expect(ctx.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it("unlocks anonymously without persisting", async () => {
    const result = await redeemApplicationApprovalToken(ctx.deps, {
      eventId: EVENT_ID,
      token: TOKEN,
      viewerHumanId: null,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      // Signed into the web claim route's application grant cookie.
      submissionId: SUBMISSION_ID,
      // The approval instance the claim route binds the grant to.
      approvedAt: NOW,
      slug: "secret-show",
      unlocked: true,
      persisted: false,
      attached: false,
    });
    expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
    expect(ctx.eventApplicationsRepo.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it("throws APPLICATION_TOKEN_EXPIRED for an expired token", async () => {
    ctx = makeDeps({ submission: { tokenExpiresAt: PAST } });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_EXPIRED" });
    expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
  });

  it("throws APPLICATION_TOKEN_INVALID when the event id does not match", async () => {
    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: OTHER_EVENT_ID,
        token: TOKEN,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
  });

  it("throws APPLICATION_TOKEN_INVALID when the submission is not approved", async () => {
    ctx = makeDeps({ submission: { status: "PENDING" } });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
  });

  it("throws APPLICATION_TOKEN_INVALID for an unknown token", async () => {
    ctx = makeDeps({ submission: null });

    await expect(
      redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TOKEN_INVALID" });
  });

  // ── Guest → account linkage on redeem (spec Phase 3 item 3) ─────────────
  describe("attach-on-redeem", () => {
    const attachArgs = {
      submissionId: SUBMISSION_ID,
      humanId: VIEWER_ID,
    };

    it("binds an ownerless guest submission to a redeemer with the SAME verified email", async () => {
      ctx = makeDeps();

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      });

      expect(result.attached).toBe(true);
      expect(
        ctx.eventApplicationsRepo.attachSubmissionToHuman,
      ).toHaveBeenCalledWith(attachArgs);
    });

    it("matches emails case- and whitespace-insensitively", async () => {
      ctx = makeDeps({
        viewerIdentity: { email: "  Guest@Example.COM ", emailVerified: true },
      });

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      });

      expect(result.attached).toBe(true);
    });

    it("does NOT attach when the redeemer's email differs (forwarded claim link)", async () => {
      ctx = makeDeps({
        viewerIdentity: { email: "someone-else@example.com", emailVerified: true },
      });

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      });

      // Neither the identity binding NOR a durable unlock: this account is
      // not the applicant. The redemption itself still succeeds (cookie path).
      expect(result.unlocked).toBe(true);
      expect(result.persisted).toBe(false);
      expect(result.attached).toBe(false);
      expect(
        ctx.eventApplicationsRepo.attachSubmissionToHuman,
      ).not.toHaveBeenCalled();
      expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
    });

    it("does NOT attach when the redeemer's email is UNVERIFIED", async () => {
      ctx = makeDeps({
        viewerIdentity: { email: "guest@example.com", emailVerified: false },
      });

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      });

      // An unverified mailbox proves nothing: no binding and no durable
      // unlock either (the cookie path still opens the page).
      expect(result.unlocked).toBe(true);
      expect(result.persisted).toBe(false);
      expect(result.attached).toBe(false);
      expect(
        ctx.eventApplicationsRepo.attachSubmissionToHuman,
      ).not.toHaveBeenCalled();
      expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
    });

    it("does NOT re-point a submission that already has an owner", async () => {
      ctx = makeDeps({
        submission: { humanId: "90000000-0000-4000-8000-000000000009" },
      });

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      });

      expect(result.attached).toBe(false);
      expect(
        ctx.eventApplicationsRepo.attachSubmissionToHuman,
      ).not.toHaveBeenCalled();
    });

    it("does NOT attach for an anonymous redeemer", async () => {
      ctx = makeDeps();

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: null,
      });

      expect(result.attached).toBe(false);
      expect(ctx.humansRepo.getByIdWithIdentity).not.toHaveBeenCalled();
    });

    it("reports attached:false when the repo CAS loses (already claimed / open-human conflict)", async () => {
      ctx = makeDeps({ attachResult: null });

      const result = await redeemApplicationApprovalToken(ctx.deps, {
        eventId: EVENT_ID,
        token: TOKEN,
        viewerHumanId: VIEWER_ID,
      });

      expect(result.unlocked).toBe(true);
      expect(result.attached).toBe(false);
      // Not bound to the viewer ⇒ not the subject ⇒ no durable unlock.
      expect(result.persisted).toBe(false);
      expect(ctx.eventUnlocksRepo.upsert).not.toHaveBeenCalled();
    });

    it("swallows + REPORTS an attach failure without failing the redemption", async () => {
      ctx = makeDeps();
      const boom = new Error("db down");
      ctx.eventApplicationsRepo.attachSubmissionToHuman.mockRejectedValue(boom);
      const reportError = vi.fn();

      const result = await redeemApplicationApprovalToken(
        { ...ctx.deps, reportError },
        { eventId: EVENT_ID, token: TOKEN, viewerHumanId: VIEWER_ID },
      );

      // The redemption still succeeds (cookie path); without a successful
      // attach the viewer isn't the subject, so nothing durable is minted.
      expect(result.unlocked).toBe(true);
      expect(result.persisted).toBe(false);
      expect(result.attached).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "redeemApplicationApprovalToken" },
        }),
      );
    });

    it("survives a THROWING reporter (best-effort reporting never fails the redeem)", async () => {
      ctx = makeDeps();
      ctx.eventApplicationsRepo.attachSubmissionToHuman.mockRejectedValue(
        new Error("db down"),
      );
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });

      await expect(
        redeemApplicationApprovalToken(
          { ...ctx.deps, reportError },
          { eventId: EVENT_ID, token: TOKEN, viewerHumanId: VIEWER_ID },
        ),
      ).resolves.toMatchObject({ unlocked: true, attached: false });
    });
  });
});
