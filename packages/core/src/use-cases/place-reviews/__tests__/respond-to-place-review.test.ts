import { describe, expect, it, vi } from "vitest";

import { respondToPlaceReview } from "../respond-to-place-review";
import type { RespondToPlaceReviewDeps } from "../respond-to-place-review";

// ── Helpers ──────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const PLACE_ID = "00000000-0000-4000-8000-00000000000a";
const ACTOR_ID = "00000000-0000-4000-8000-000000000099";
const ORG_ID = "00000000-0000-4000-8000-0000000000b0";
const NOW = new Date("2026-04-07T12:00:00.000Z");

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    placeId: PLACE_ID,
    responseText: null,
    respondedAt: null,
    ...overrides,
  };
}

function makePlace(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    humanIdsWithAccess: [ACTOR_ID],
    orgIdsWithAccess: [],
    ...overrides,
  };
}

function makeDeps(opts: {
  review?: unknown;
  place?: unknown;
  orgMemberships?: unknown[];
}): RespondToPlaceReviewDeps {
  return {
    repos: {
      placeReviews: {
        getById: vi.fn(async () => opts.review ?? null),
        respond: vi.fn(async () => ({
          ...(opts.review ?? {}),
          responseText: "Thanks!",
          respondedAt: NOW,
        })),
      },
      places: {
        getById: vi.fn(async () => opts.place ?? null),
      },
      authz: {
        getOrgMemberships: vi.fn(async () => opts.orgMemberships ?? []),
      },
      audit: {
        log: vi.fn(async () => {}),
      },
    } as any,
    clock: { now: () => NOW },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("respondToPlaceReview", () => {
  it("allows direct place owner to respond", async () => {
    const deps = makeDeps({
      review: makeReview(),
      place: makePlace({ humanIdsWithAccess: [ACTOR_ID] }),
    });

    const result = await respondToPlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ACTOR_ID,
      responseText: "Thanks for playing!",
    });

    expect(result.reviewId).toBe(REVIEW_ID);
    expect(result.respondedAt).toBe(NOW.toISOString());
    expect(deps.repos.placeReviews.respond).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      responseById: ACTOR_ID,
      responseText: "Thanks for playing!",
    });
  });

  it("allows org member to respond", async () => {
    const deps = makeDeps({
      review: makeReview(),
      place: makePlace({
        humanIdsWithAccess: [], // not direct owner
        orgIdsWithAccess: [ORG_ID],
      }),
      orgMemberships: [{ orgId: ORG_ID, role: "OWNER" }],
    });

    const result = await respondToPlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ACTOR_ID,
      responseText: "Come back any time!",
    });

    expect(result.reviewId).toBe(REVIEW_ID);
  });

  it("throws forbidden when actor has no access", async () => {
    const deps = makeDeps({
      review: makeReview(),
      place: makePlace({
        humanIdsWithAccess: ["other-human"],
        orgIdsWithAccess: [],
      }),
    });

    await expect(
      respondToPlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ACTOR_ID,
        responseText: "Response",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found when review does not exist", async () => {
    const deps = makeDeps({ review: null });

    await expect(
      respondToPlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ACTOR_ID,
        responseText: "Response",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });

  it("throws not_found when place does not exist", async () => {
    const deps = makeDeps({
      review: makeReview(),
      place: null,
    });

    await expect(
      respondToPlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ACTOR_ID,
        responseText: "Response",
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("throws conflict when review already has a response", async () => {
    const deps = makeDeps({
      review: makeReview({ responseText: "Already responded" }),
      place: makePlace(),
    });

    await expect(
      respondToPlaceReview(deps, {
        reviewId: REVIEW_ID,
        actorHumanId: ACTOR_ID,
        responseText: "Another response",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ALREADY_RESPONDED" });
  });

  it("logs audit entry on successful response", async () => {
    const deps = makeDeps({
      review: makeReview(),
      place: makePlace(),
    });

    await respondToPlaceReview(deps, {
      reviewId: REVIEW_ID,
      actorHumanId: ACTOR_ID,
      responseText: "Thanks!",
    });

    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place_review",
        entityId: REVIEW_ID,
        action: "place_review.response_added",
      }),
    );
  });
});
