import { describe, expect, it, vi } from "vitest";

import { hidePlaceReview } from "../hide-place-review";
import type { HidePlaceReviewDeps } from "../hide-place-review";

// ── Helpers ──────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-04-07T12:00:00.000Z");

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    placeId: "00000000-0000-4000-8000-00000000000a",
    flagged: false,
    flagReason: null,
    hidden: false,
    ...overrides,
  };
}

function makeDeps(opts: {
  review?: unknown;
  role?: string | null;
}): HidePlaceReviewDeps {
  return {
    repos: {
      placeReviews: {
        getById: vi.fn(async () => opts.review ?? null),
        hide: vi.fn(async () => ({ ...opts.review, hidden: true })),
      },
      audit: {
        log: vi.fn(async () => {}),
      },
    } as any,
    authz: {
      hasStaffRole: vi.fn(async () => ({
        allowed: opts.role === "ADMIN",
      })),
    },
    clock: { now: () => NOW },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("hidePlaceReview", () => {
  it("hides a review when actor is ADMIN", async () => {
    const deps = makeDeps({ review: makeReview(), role: "ADMIN" });

    const result = await hidePlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ADMIN_ID,
    });

    expect(result).toEqual({ reviewId: REVIEW_ID, hidden: true });
    expect(deps.repos.placeReviews.hide).toHaveBeenCalledWith(REVIEW_ID);
  });

  it("logs audit entry", async () => {
    const deps = makeDeps({ review: makeReview(), role: "ADMIN" });

    await hidePlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ADMIN_ID,
    });

    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place_review",
        entityId: REVIEW_ID,
        action: "place_review.hidden",
      }),
    );
  });

  it("throws forbidden when actor is not platform admin", async () => {
    const deps = makeDeps({ review: makeReview(), role: "USER" });

    await expect(
      hidePlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws forbidden when no role found", async () => {
    const deps = makeDeps({ review: makeReview(), role: null });

    await expect(
      hidePlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when review does not exist (admin)", async () => {
    const deps = makeDeps({ review: null, role: "ADMIN" });

    await expect(
      hidePlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });

  it("throws conflict when review is already hidden", async () => {
    const deps = makeDeps({
      review: makeReview({ hidden: true }),
      role: "ADMIN",
    });

    await expect(
      hidePlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ALREADY_HIDDEN" });
  });
});
