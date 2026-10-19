import { describe, expect, it, vi } from "vitest";

import { resolveAttendeeReviewIdentity } from "../resolve-attendee-review-identity";
import type { ResolveAttendeeReviewIdentityDeps } from "../resolve-attendee-review-identity";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const REVIEWER_HUMAN_ID = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const ACTOR_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = new Date("2026-07-15T12:00:00.000Z");

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    eventId: EVENT_ID,
    humanId: REVIEWER_HUMAN_ID,
    hidden: false,
    flagged: false,
    flagReason: null,
    ...overrides,
  };
}

function makeDeps(opts: { review?: unknown; staff?: boolean }) {
  const getById = vi.fn(async () =>
    opts.review === undefined ? makeReview() : opts.review,
  );
  const auditLog = vi.fn(async () => {});
  const hasStaffRole = vi.fn(async () => ({ allowed: opts.staff === true }));

  const deps: ResolveAttendeeReviewIdentityDeps = {
    repos: {
      attendeeReviews: { getById },
      audit: { log: auditLog },
    } as any,
    authz: { hasStaffRole },
    clock: { now: () => NOW },
  };
  return { deps, getById, auditLog, hasStaffRole };
}

const INPUT = { reviewId: REVIEW_ID, actorHumanId: ACTOR_ID };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveAttendeeReviewIdentity (FR-002 — identity disclosure)", () => {
  it("REJECTS a non-staff actor — no identity returned, no audit row, no lookup", async () => {
    const { deps, getById, auditLog } = makeDeps({ staff: false });

    await expect(
      resolveAttendeeReviewIdentity(deps, INPUT),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    // The disclosure must be blocked BEFORE any read or audit write.
    expect(getById).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("REJECTS when hasStaffRole returns allowed=false explicitly (no role)", async () => {
    // hasStaffRole is the sole gate — a falsy `allowed` must fail closed.
    const { deps, auditLog } = makeDeps({ review: makeReview(), staff: false });

    await expect(
      resolveAttendeeReviewIdentity(deps, INPUT),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("staff actor gets the identity AND the disclosure is audit-logged", async () => {
    const { deps, auditLog, hasStaffRole } = makeDeps({
      review: makeReview(),
      staff: true,
    });

    const result = await resolveAttendeeReviewIdentity(deps, INPUT);

    expect(result).toStrictEqual({
      reviewId: REVIEW_ID,
      humanId: REVIEWER_HUMAN_ID,
      eventId: EVENT_ID,
    });

    // The staff gate required ADMIN.
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN"],
      }),
    );

    // The disclosure is ALWAYS recorded: WHO resolved WHICH review, WHEN, and
    // whose identity was revealed.
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "attendee_review",
        entityId: REVIEW_ID,
        action: "attendee_review.identity_resolved",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          resolvedHumanId: REVIEWER_HUMAN_ID,
        }),
        at: NOW,
      }),
    );
  });

  it("REVIEW_NOT_FOUND for a missing review — no crash, no partial disclosure", async () => {
    const { deps, auditLog } = makeDeps({ review: null, staff: true });

    await expect(
      resolveAttendeeReviewIdentity(deps, INPUT),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });

    // Nothing disclosed → nothing logged.
    expect(auditLog).not.toHaveBeenCalled();
  });
});
