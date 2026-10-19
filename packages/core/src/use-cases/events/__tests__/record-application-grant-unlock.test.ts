import { describe, expect, it, vi } from "vitest";

import type {
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
} from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { recordApplicationGrantUnlock } from "../record-application-grant-unlock";

/**
 * Checkout is signed-in only and the buyer's own API calls never carry the
 * web-host grant cookie, so the web syncs the grant into a durable unlock
 * first. That row is minted for the submission's SUBJECT only — the same rule
 * redeem applies — so a forwarded link can never be laundered into one.
 */

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-00000000000a";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const BUYER_ID = "80000000-0000-4000-8000-000000000008";
const SOMEONE_ELSE = "90000000-0000-4000-8000-000000000009";
const NOW = new Date("2025-12-05T12:00:00Z");

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
  approvalToken: "tok",
  tokenExpiresAt: NOW,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const INVITE_ID = "90000000-0000-4000-8000-000000000009";

function makeDeps(
  overrides: {
    submission?: Partial<EventApplicationSubmissionRecord> | null;
    gateType?: "APPLICATION" | "PASSWORD" | "NONE";
    event?: null;
    buyerIdentity?: { email: string; emailVerified: boolean } | null;
    attachThrows?: boolean;
    /** Runs after the APPROVED read, before the locked write (a racing rescind). */
    betweenReadAndWrite?: (row: EventApplicationSubmissionRecord) => void;
    /** The invite `submission.inviteId` points at (invite approvals). */
    invite?: {
      kind: "SHARED" | "PERSONAL";
      revokedAt: Date | null;
      grantsRevokedAt?: Date | null;
    } | null;
  } = {},
) {
  const submission =
    overrides.submission === null
      ? null
      : { ...baseSubmission, ...(overrides.submission ?? {}) };
  const event =
    overrides.event === null
      ? null
      : ({
          id: EVENT_ID,
          gateType: overrides.gateType ?? "APPLICATION",
        } as unknown as EventRecord);
  const identity =
    overrides.buyerIdentity === undefined
      ? { email: "Guest@Example.com", emailVerified: true }
      : overrides.buyerIdentity;

  // Mutable invite row: a test can revoke it mid-flight.
  const inviteRow = overrides.invite
    ? { eventId: EVENT_ID, ...overrides.invite }
    : null;
  // Stateful row: reads return a snapshot; `lockApprovedSubmission` checks
  // the CURRENT row, the way the guarded UPDATE does.
  const calls: string[] = [];
  const eventApplications = {
    getSubmissionById: vi.fn(async () => (submission ? { ...submission } : null)),
    attachSubmissionToHuman: vi.fn(async () => {
      if (overrides.attachThrows) throw new Error("db down");
      return submission ? { ...submission, humanId: BUYER_ID } : null;
    }),
    lockApprovedSubmission: vi.fn(
      async (lock: { submissionId: string; eventId: string; reviewedAt: Date }) => {
        calls.push("lock");
        if (submission) overrides.betweenReadAndWrite?.(submission);
        return (
          !!submission &&
          submission.id === lock.submissionId &&
          submission.eventId === lock.eventId &&
          submission.status === "APPROVED" &&
          submission.reviewedAt?.getTime() === lock.reviewedAt.getTime()
        );
      },
    ),
  };
  const eventUnlocks = {
    upsert: vi.fn(async () => {
      calls.push("upsert");
      return { id: "unlock-1" };
    }),
  };
  const humans = {
    getByIdWithIdentity: vi.fn(async () =>
      identity ? { human: { id: BUYER_ID }, identity } : null,
    ),
  };
  const reportError = vi.fn();
  const repos: Record<string, unknown> = {
    events: { getById: vi.fn(async () => event) },
    eventApplications,
    eventUnlocks,
    humans,
    eventInvites: {
      getById: vi.fn(async (id: string) =>
        inviteRow ? { ...inviteRow, id } : null,
      ),
      // The guarded no-op UPDATE: true only while the CURRENT row is live.
      lockIfLive: vi.fn(async () => {
        calls.push("inviteLock");
        return !!inviteRow && inviteRow.revokedAt === null;
      }),
      // SHARED rows: live while their grants were not removed.
      lockIfGrantsHold: vi.fn(async () => {
        calls.push("sharedGrantLock");
        return !!inviteRow && !inviteRow.grantsRevokedAt;
      }),
    },
  };
  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) => {
    calls.push("tx:begin");
    try {
      return await fn(repos);
    } finally {
      calls.push("tx:end");
    }
  });
  repos.tx = tx;

  return {
    inviteRow,
    eventApplications,
    eventUnlocks,
    reportError,
    calls,
    tx,
    deps: {
      repos: repos as unknown as Repos,
      logger: createTestLogger(),
      reportError,
    },
  };
}

const input = {
  eventId: EVENT_ID,
  submissionId: SUBMISSION_ID,
  approvedAtMs: NOW.getTime(),
  humanId: BUYER_ID,
};

describe("recordApplicationGrantUnlock", () => {
  it("an invite approval's unlock carries the inviteId, so revoking the PERSONAL invite removes it in phase 1", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID, inviteId: INVITE_ID },
      invite: { kind: "PERSONAL", revokedAt: null },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "persisted",
    });
    expect(ctx.eventUnlocks.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: BUYER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
      inviteId: INVITE_ID,
    });
  });

  it("a PERSONAL revoke landing between the pre-check and the write: no unlock (re-checked under the invite lock)", async () => {
    let revokeNow: () => void = () => {};
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID, inviteId: INVITE_ID },
      invite: { kind: "PERSONAL", revokedAt: null },
      // Runs inside the transaction, AFTER the pre-transaction invite check
      // read the invite as live.
      betweenReadAndWrite: () => revokeNow(),
    });
    revokeNow = () => {
      ctx.inviteRow!.revokedAt = NOW;
    };

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "grant_invalid",
      persisted: false,
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
    // Submission lock first, then the invite lock, inside one transaction.
    expect(ctx.calls).toEqual(["tx:begin", "lock", "inviteLock", "tx:end"]);
  });

  it("a persist transaction aborted for a deadlock (P2034) is retried once", async () => {
    const ctx = makeDeps({ submission: { humanId: BUYER_ID } });
    ctx.tx.mockImplementationOnce(async () => {
      throw { code: "P2034", message: "Transaction failed due to a deadlock" };
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "persisted",
    });
    expect(ctx.tx).toHaveBeenCalledTimes(2);
    expect(ctx.eventUnlocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("a second deadlock propagates; other errors are not retried", async () => {
    const deadlock = makeDeps({ submission: { humanId: BUYER_ID } });
    deadlock.tx.mockImplementation(async () => {
      throw { message: "Raw query failed. Code: `40P01`. deadlock detected" };
    });
    await expect(recordApplicationGrantUnlock(deadlock.deps, input)).rejects.toMatchObject({
      message: expect.stringContaining("40P01"),
    });
    expect(deadlock.tx).toHaveBeenCalledTimes(2);

    const other = makeDeps({ submission: { humanId: BUYER_ID } });
    other.tx.mockImplementation(async () => {
      throw new Error("db down");
    });
    await expect(recordApplicationGrantUnlock(other.deps, input)).rejects.toThrow("db down");
    expect(other.tx).toHaveBeenCalledTimes(1);
  });

  it("holds the live PERSONAL invite's lock across the unlock write", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID, inviteId: INVITE_ID },
      invite: { kind: "PERSONAL", revokedAt: null },
    });
    await recordApplicationGrantUnlock(ctx.deps, input);
    expect(ctx.calls).toEqual(["tx:begin", "lock", "inviteLock", "upsert", "tx:end"]);
  });

  it("a reset SHARED invite never blocks the write (R5); it takes the grants lock, not the live lock", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID, inviteId: INVITE_ID },
      invite: { kind: "SHARED", revokedAt: NOW, grantsRevokedAt: null },
    });
    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "persisted",
    });
    expect(ctx.calls).toEqual([
      "tx:begin",
      "lock",
      "sharedGrantLock",
      "upsert",
      "tx:end",
    ]);
  });

  it("grant_invalid for an approval from a SHARED link whose grants were removed: no unlock", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID, inviteId: INVITE_ID },
      invite: { kind: "SHARED", revokedAt: NOW, grantsRevokedAt: NOW },
    });
    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "grant_invalid",
      persisted: false,
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("grant_invalid for an approval from a REVOKED PERSONAL invite: no unlock is minted (R9)", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID, inviteId: INVITE_ID },
      invite: { kind: "PERSONAL", revokedAt: NOW },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "grant_invalid",
      persisted: false,
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("persists a submission-linked unlock for the signed-in applicant", async () => {
    const ctx = makeDeps({ submission: { humanId: BUYER_ID } });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toEqual({
      eventId: EVENT_ID,
      persisted: true,
      attached: false,
      outcome: "persisted",
    });
    // Linked to the submission, so a later rescind revokes it
    // (`revokeBySubmission`).
    expect(ctx.eventUnlocks.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: BUYER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
    });
    expect(ctx.eventApplications.attachSubmissionToHuman).not.toHaveBeenCalled();
    // Check and write in ONE transaction, the lock before the upsert.
    expect(ctx.calls).toEqual(["tx:begin", "lock", "upsert", "tx:end"]);
    expect(ctx.eventApplications.lockApprovedSubmission).toHaveBeenCalledWith({
      submissionId: SUBMISSION_ID,
      eventId: EVENT_ID,
      // Only an ATTEND approval may mint an EventUnlock.
      purpose: "ATTEND",
      reviewedAt: NOW,
    });
  });

  it("rescind wins: a rescind landing between the APPROVED read and the write leaves no unlock", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID },
      betweenReadAndWrite: (row) => {
        row.status = "PENDING";
        row.reviewedAt = null;
      },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "grant_invalid",
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("re-approval wins the race the same way: a different approval instance writes nothing", async () => {
    const ctx = makeDeps({
      submission: { humanId: BUYER_ID },
      betweenReadAndWrite: (row) => {
        row.reviewedAt = new Date(NOW.getTime() + 60_000);
      },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "grant_invalid",
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("a grant from an EARLIER approval (rescinded, then approved again) is dead", async () => {
    const ctx = makeDeps({
      submission: {
        humanId: BUYER_ID,
        reviewedAt: new Date(NOW.getTime() + 3_600_000),
      },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "grant_invalid",
    });
    expect(ctx.tx).not.toHaveBeenCalled();
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("attaches the GUEST submission to a verified, email-matching buyer, then persists", async () => {
    const ctx = makeDeps();

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toEqual({
      eventId: EVENT_ID,
      persisted: true,
      attached: true,
      outcome: "persisted",
    });
    expect(ctx.eventApplications.attachSubmissionToHuman).toHaveBeenCalledWith({
      submissionId: SUBMISSION_ID,
      humanId: BUYER_ID,
    });
    expect(ctx.eventUnlocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("does NOT persist for a buyer who merely holds a forwarded grant (submission owned by someone else)", async () => {
    const ctx = makeDeps({ submission: { humanId: SOMEONE_ELSE } });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "not_subject",
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("does NOT persist for a buyer whose account email does not match the guest application", async () => {
    const ctx = makeDeps({
      buyerIdentity: { email: "forwardee@example.com", emailVerified: true },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      attached: false,
      outcome: "not_subject",
    });
    expect(ctx.eventApplications.attachSubmissionToHuman).not.toHaveBeenCalled();
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "WITHDRAWN", "REJECTED", "EXPIRED"] as const)(
    "a %s submission (revoked grant) persists nothing and attaches nothing",
    async (status) => {
      const ctx = makeDeps({ submission: { status, humanId: BUYER_ID } });

      await expect(
        recordApplicationGrantUnlock(ctx.deps, input),
      ).resolves.toMatchObject({ persisted: false, outcome: "grant_invalid" });
      expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
      expect(ctx.eventApplications.attachSubmissionToHuman).not.toHaveBeenCalled();
    },
  );

  it("a grant for ANOTHER event's submission persists nothing", async () => {
    const ctx = makeDeps({
      submission: { eventId: OTHER_EVENT_ID, humanId: BUYER_ID },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "grant_invalid",
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("an application grant never mints a row on a PASSWORD-gated event", async () => {
    const ctx = makeDeps({
      gateType: "PASSWORD",
      submission: { humanId: BUYER_ID },
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "grant_invalid",
    });
    expect(ctx.eventApplications.getSubmissionById).not.toHaveBeenCalled();
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("throws EVENT_NOT_FOUND for an unknown event", async () => {
    const ctx = makeDeps({ event: null });
    await expect(recordApplicationGrantUnlock(ctx.deps, input)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });

  it("a failing guest attach is reported, not thrown, and persists nothing", async () => {
    const ctx = makeDeps({ attachThrows: true });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      persisted: false,
      outcome: "not_subject",
    });
    expect(ctx.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "recordApplicationGrantUnlock" },
      extra: { submissionId: SUBMISSION_ID },
    });
    expect(ctx.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("a throwing reporter does not change the outcome", async () => {
    const ctx = makeDeps({ attachThrows: true });
    ctx.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(recordApplicationGrantUnlock(ctx.deps, input)).resolves.toMatchObject({
      outcome: "not_subject",
    });
  });

  it("rejects client-shaped extra input (strict schema)", async () => {
    const ctx = makeDeps();
    await expect(
      recordApplicationGrantUnlock(ctx.deps, { ...input, persisted: true }),
    ).rejects.toBeDefined();
  });
});
