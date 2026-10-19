import { describe, expect, it, vi } from "vitest";

import { flagPlaceReview } from "../flag-place-review";
import type { FlagPlaceReviewDeps } from "../flag-place-review";

// ── Helpers ──────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000099";
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

function makeDeps(opts: { review?: unknown }): FlagPlaceReviewDeps {
  return {
    repos: {
      placeReviews: {
        getById: vi.fn(async () => opts.review ?? null),
        flag: vi.fn(async () => ({ ...opts.review, flagged: true })),
      },
      audit: {
        log: vi.fn(async () => {}),
      },
    } as any,
    clock: { now: () => NOW },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("flagPlaceReview", () => {
  it("flags a review and returns flagged: true", async () => {
    const deps = makeDeps({ review: makeReview() });

    const result = await flagPlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ACTOR_ID,
      flagReason: "Looks fake",
    });

    expect(result).toEqual({ reviewId: REVIEW_ID, flagged: true });
    expect(deps.repos.placeReviews.flag).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      flagReason: "Looks fake",
    });
  });

  it("logs audit entry", async () => {
    const deps = makeDeps({ review: makeReview() });

    await flagPlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ACTOR_ID,
      flagReason: "Spam content",
    });

    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place_review",
        entityId: REVIEW_ID,
        action: "place_review.flagged",
      }),
    );
  });

  it("throws not_found when review does not exist", async () => {
    const deps = makeDeps({ review: null });

    await expect(
      flagPlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ACTOR_ID,
        flagReason: "Reason",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });

  it("throws conflict when review is already flagged", async () => {
    const deps = makeDeps({ review: makeReview({ flagged: true }) });

    await expect(
      flagPlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ACTOR_ID,
        flagReason: "Reason",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ALREADY_FLAGGED" });
  });
});
