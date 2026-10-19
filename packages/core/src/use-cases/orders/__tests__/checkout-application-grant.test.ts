import { describe, expect, it, vi } from "vitest";

import type {
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
} from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { recordApplicationGrantUnlock } from "../../events/record-application-grant-unlock";
import { ensureEventAccessible } from "../checkout-helpers";

/**
 * Approved guest → checkout, end to end through core: the web sync turns the
 * application grant into a durable unlock for the subject, and checkout's own
 * gate (`ensureEventAccessible`, used by createCheckout / claimFreeTickets /
 * updateOrderItems) then lets them buy. A revoked grant leaves no row, so the
 * same gate refuses with a clean FORBIDDEN — never EVENT_NOT_PASSWORD_GATED.
 */

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const BUYER_ID = "80000000-0000-4000-8000-000000000008";
const NOW = new Date("2025-12-05T12:00:00Z");

const event = { id: EVENT_ID, gateType: "APPLICATION" } as unknown as EventRecord;

function harness(status: EventApplicationSubmissionRecord["status"]) {
  const submission: EventApplicationSubmissionRecord = {
    id: SUBMISSION_ID,
    // An attendee (ATTEND) application: the grant path treats any other
    // purpose as not found (open calls step 2).
    formId: "f0000000-0000-4000-8000-00000000000f",
    purpose: "ATTEND",
    eventId: EVENT_ID,
    humanId: null,
    contactEmail: "guest@example.com",
    contactPhone: null,
    status,
    answers: {},
    decisionReason: null,
    questionsSnapshot: {},
    reviewerHumanId: null,
    reviewedAt: status === "APPROVED" ? NOW : null,
    approvalToken: null,
    tokenExpiresAt: null,
    inviteId: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
  // In-memory unlock table, shared by the sync and the checkout gate.
  const rows = new Set<string>();
  const eventUnlocks = {
    upsert: vi.fn(async (row: { eventId: string; humanId: string }) => {
      rows.add(`${row.eventId}:${row.humanId}`);
      return { id: "unlock-1" };
    }),
    isUnlocked: vi.fn(async (eventId: string, humanId: string) =>
      rows.has(`${eventId}:${humanId}`),
    ),
  };
  const repos: Record<string, unknown> = {
    events: { getById: vi.fn(async () => event) },
    eventApplications: {
      getSubmissionById: vi.fn(async () => submission),
      attachSubmissionToHuman: vi.fn(async () => ({
        ...submission,
        humanId: BUYER_ID,
      })),
      lockApprovedSubmission: vi.fn(
        async (lock: { reviewedAt: Date }) =>
          submission.status === "APPROVED" &&
          submission.reviewedAt?.getTime() === lock.reviewedAt.getTime(),
      ),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: BUYER_ID },
        identity: { email: "guest@example.com", emailVerified: true },
      })),
    },
    eventUnlocks,
  };
  repos.tx = async (fn: (tx: unknown) => Promise<unknown>) => fn(repos);
  return { repos, eventUnlocks };
}

describe("checkout with an application grant", () => {
  it("valid grant → synced for the subject → checkout's gate passes", async () => {
    const { repos } = harness("APPROVED");

    const sync = await recordApplicationGrantUnlock(
      { repos: repos as unknown as Repos, logger: createTestLogger() },
      {
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        approvedAtMs: NOW.getTime(),
        humanId: BUYER_ID,
      },
    );
    expect(sync.persisted).toBe(true);

    await expect(
      ensureEventAccessible(repos as never, event, BUYER_ID),
    ).resolves.toBeUndefined();
  });

  it("revoked grant (rescinded → PENDING) → nothing synced → checkout's gate refuses with FORBIDDEN", async () => {
    const { repos, eventUnlocks } = harness("PENDING");

    const sync = await recordApplicationGrantUnlock(
      { repos: repos as unknown as Repos, logger: createTestLogger() },
      {
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        approvedAtMs: NOW.getTime(),
        humanId: BUYER_ID,
      },
    );
    expect(sync).toMatchObject({ persisted: false, outcome: "grant_invalid" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();

    await expect(
      ensureEventAccessible(repos as never, event, BUYER_ID),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
