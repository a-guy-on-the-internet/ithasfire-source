import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { placeReviewsRouter } from "../place-reviews";

// ---------------------------------------------------------------------------
// venue-track-record-and-review-switch (docs/specs/2026-09-24) FR-002, R1 —
// the transport surfaces PLACE_COMMUNITY_REVIEWS_DISABLED as
// PRECONDITION_FAILED. REAL router, REAL schemas, REAL use cases, fake repos:
// the lesson from e09e1a8 is that a mocked test can pass while the real
// submit 400s.
// ---------------------------------------------------------------------------

const PLACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const closedPlace = {
  id: PLACE_A,
  name: "Fishbowl House",
  status: "ACTIVE",
  communityReviewsEnabled: false,
};

const reviewInput = {
  placeId: PLACE_A,
  paymentMethod: "GUARANTEE" as const,
  venuePromoted: "ACTIVELY_PROMOTED" as const,
  soundQuality: "GREAT" as const,
  stageEquipment: "FULL" as const,
  audienceFit: "PERFECT_FIT" as const,
  wouldPlayAgain: "YES" as const,
  parkingLoadIn: "DEDICATED_LOT" as const,
  bookerRating: "EXCELLENT" as const,
  genreTags: [] as string[],
};

function fakeRepos() {
  const repos: Record<string, unknown> = {
    places: { getById: vi.fn(async () => closedPlace) },
    placeReviews: { create: vi.fn() },
    placeReviewSessions: { upsert: vi.fn() },
    audit: { log: vi.fn() },
  };
  // `submitPlaceReview` runs inside `repos.tx`; hand the same fakes back.
  repos.tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos));
  return repos;
}

describe("placeReviewsRouter — performer-review switch off", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("submit → PRECONDITION_FAILED / PLACE_COMMUNITY_REVIEWS_DISABLED, nothing written", async () => {
    const repos = fakeRepos();
    const { caller } = createCaller(placeReviewsRouter, {
      actorHumanId: null,
      auth: null,
      authToken: null,
      repos: repos as any,
    });

    await expect(caller.submit(reviewInput)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "PLACE_COMMUNITY_REVIEWS_DISABLED",
    });
    expect((repos.placeReviews as { create: ReturnType<typeof vi.fn> }).create)
      .not.toHaveBeenCalled();
    expect((repos.audit as { log: ReturnType<typeof vi.fn> }).log).not.toHaveBeenCalled();
  });

  it("createSession → PRECONDITION_FAILED / PLACE_COMMUNITY_REVIEWS_DISABLED, no session row", async () => {
    const repos = fakeRepos();
    const { caller } = createCaller(placeReviewsRouter, {
      actorHumanId: null,
      auth: null,
      authToken: null,
      repos: repos as any,
    });

    await expect(
      caller.createSession({
        sessionToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        placeId: PLACE_A,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "PLACE_COMMUNITY_REVIEWS_DISABLED",
    });
    expect(
      (repos.placeReviewSessions as { upsert: ReturnType<typeof vi.fn> }).upsert,
    ).not.toHaveBeenCalled();
  });
});
