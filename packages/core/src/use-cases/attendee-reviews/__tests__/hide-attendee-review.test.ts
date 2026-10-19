import { describe, expect, it, vi } from "vitest";

import { hideAttendeeReview } from "../hide-attendee-review";
import type { HideAttendeeReviewDeps } from "../hide-attendee-review";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const ACTOR_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = new Date("2026-07-15T12:00:00.000Z");

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    eventId: EVENT_ID,
    humanId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
    hidden: false,
    flagged: false,
    flagReason: null,
    ...overrides,
  };
}

function makeDeps(opts: { review?: unknown; staff?: boolean }) {
  const review = opts.review === undefined ? makeReview() : opts.review;
  const getById = vi.fn(async () => review);
  const setHidden = vi.fn(async () => ({ ...(review as object), hidden: true }));
  const auditLog = vi.fn(async () => {});
  const hasStaffRole = vi.fn(async () => ({ allowed: opts.staff === true }));

  const deps: HideAttendeeReviewDeps = {
    repos: {
      attendeeReviews: { getById, setHidden },
      audit: { log: auditLog },
    } as any,
    authz: { hasStaffRole },
    clock: { now: () => NOW },
  };
  return { deps, getById, setHidden, auditLog, hasStaffRole };
}

const INPUT = { reviewId: REVIEW_ID, actorHumanId: ACTOR_ID };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("hideAttendeeReview (FR-009 — staff moderation)", () => {
  it("REJECTS a non-staff actor — no read, no hide, no audit", async () => {
    const { deps, getById, setHidden, auditLog } = makeDeps({ staff: false });

    await expect(hideAttendeeReview(deps, INPUT)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });

    expect(getById).not.toHaveBeenCalled();
    expect(setHidden).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("staff hide sets hidden and audit-logs", async () => {
    const { deps, setHidden, auditLog, hasStaffRole } = makeDeps({
      staff: true,
    });

    const result = await hideAttendeeReview(deps, INPUT);

    expect(result).toStrictEqual({ reviewId: REVIEW_ID, hidden: true });

    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN"],
      }),
    );
    expect(setHidden).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      hidden: true,
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "attendee_review",
        entityId: REVIEW_ID,
        action: "attendee_review.hidden",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
        }),
        at: NOW,
      }),
    );
  });

  it("is idempotent on an already-hidden review — skips setHidden, still audit-logs", async () => {
    // The use case guards the write with `if (!review.hidden)`, so re-hiding is
    // a no-op on the repo but still returns success and records the action.
    const { deps, setHidden, auditLog } = makeDeps({
      review: makeReview({ hidden: true }),
      staff: true,
    });

    const result = await hideAttendeeReview(deps, INPUT);

    expect(result).toStrictEqual({ reviewId: REVIEW_ID, hidden: true });
    expect(setHidden).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it("REVIEW_NOT_FOUND for a missing review", async () => {
    const { deps, setHidden, auditLog } = makeDeps({
      review: null,
      staff: true,
    });

    await expect(hideAttendeeReview(deps, INPUT)).rejects.toMatchObject({
      code: "REVIEW_NOT_FOUND",
    });
    expect(setHidden).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});
