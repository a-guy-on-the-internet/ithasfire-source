import { describe, expect, it, vi } from "vitest";

import { listPlaceReviews } from "../list-place-reviews";
import type { ListPlaceReviewsDeps } from "../list-place-reviews";
import type { PlaceReviewRecord } from "@th/types/repos/place-reviews";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PLACE_A = "00000000-0000-4000-8000-00000000000a";
const NOW = new Date("2026-04-07T12:00:00.000Z");

function makeReview(
  overrides: Partial<PlaceReviewRecord> = {},
): PlaceReviewRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    placeId: PLACE_A,
    humanId: null,
    anonymousName: "Anon Band",
    anonymousEmail: "secret@band.com",
    payoutCents: 20000,
    paymentMethod: "GUARANTEE",
    paymentDetail: null,
    venuePromoted: "ACTIVELY_PROMOTED",
    promotionDetail: null,
    soundQuality: "GREAT",
    soundDetail: "Awesome PA system",
    stageEquipment: "FULL",
    stageEquipmentDetail: null,
    audienceFit: "PERFECT_FIT",
    audienceDetail: null,
    parkingLoadIn: "DEDICATED_LOT",
    parkingDetail: null,
    bookerRating: "EXCELLENT",
    bookerDetail: "Very responsive",
    wouldPlayAgain: "YES",
    comment: "Great venue!",
    genre: "rock",
    estimatedDraw: 100,
    source: "SURVEY",
    eventId: null,
    responseText: "Thanks for playing!",
    responseById: "resp-human-1",
    respondedAt: NOW,
    flagged: false,
    flagReason: null,
    hidden: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDeps(opts: {
  reviews?: PlaceReviewRecord[];
  total?: number;
}): ListPlaceReviewsDeps {
  return {
    repos: {
      placeReviews: {
        listByPlace: vi.fn(async () => opts.reviews ?? []),
        countByPlace: vi.fn(async () => opts.total ?? 0),
      },
    } as any,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listPlaceReviews", () => {
  it("returns mapped reviews with total count", async () => {
    const review = makeReview();
    const deps = makeDeps({ reviews: [review], total: 1 });

    const result = await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(result.total).toBe(1);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]!.id).toBe(review.id);
    expect(result.reviews[0]!.paymentMethod).toBe("GUARANTEE");
    expect(result.reviews[0]!.createdAt).toBe(NOW.toISOString());
  });

  it("strips anonymousEmail from output (privacy)", async () => {
    const review = makeReview({ anonymousEmail: "secret@band.com" });
    const deps = makeDeps({ reviews: [review], total: 1 });

    const result = await listPlaceReviews(deps, { placeId: PLACE_A });

    // anonymousEmail should NOT be in the output
    expect((result.reviews[0] as any).anonymousEmail).toBeUndefined();
    // But anonymousName should be present
    expect(result.reviews[0]!.anonymousName).toBe("Anon Band");
  });

  it("includes all detail fields in output", async () => {
    const review = makeReview({
      soundDetail: "Great monitors",
      stageEquipmentDetail: "Full backline",
      audienceDetail: "Perfect crowd",
      parkingDetail: "Easy loading dock",
      bookerDetail: "Professional",
    });
    const deps = makeDeps({ reviews: [review], total: 1 });

    const result = await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(result.reviews[0]!.soundDetail).toBe("Great monitors");
    expect(result.reviews[0]!.stageEquipmentDetail).toBe("Full backline");
    expect(result.reviews[0]!.audienceDetail).toBe("Perfect crowd");
    expect(result.reviews[0]!.parkingDetail).toBe("Easy loading dock");
    expect(result.reviews[0]!.bookerDetail).toBe("Professional");
  });

  it("passes visibleOnly: true to listByPlace and countByPlace", async () => {
    const deps = makeDeps({ reviews: [], total: 0 });

    await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(deps.repos.placeReviews.listByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ visibleOnly: true }),
    );
    expect(deps.repos.placeReviews.countByPlace).toHaveBeenCalledWith(
      PLACE_A,
      true,
    );
  });

  it("defaults limit to 20 and offset to 0", async () => {
    const deps = makeDeps({ reviews: [], total: 0 });

    await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(deps.repos.placeReviews.listByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
  });

  it("passes custom limit and offset to repo", async () => {
    const deps = makeDeps({ reviews: [], total: 0 });

    await listPlaceReviews(deps, { placeId: PLACE_A, limit: 10, offset: 30 });

    expect(deps.repos.placeReviews.listByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 30 }),
    );
  });

  it("serializes respondedAt to ISO string", async () => {
    const review = makeReview({
      responseText: "Thank you!",
      respondedAt: new Date("2026-04-08T15:30:00.000Z"),
    });
    const deps = makeDeps({ reviews: [review], total: 1 });

    const result = await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(result.reviews[0]!.respondedAt).toBe("2026-04-08T15:30:00.000Z");
  });

  it("returns null respondedAt when no response exists", async () => {
    const review = makeReview({ responseText: null, respondedAt: null });
    const deps = makeDeps({ reviews: [review], total: 1 });

    const result = await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(result.reviews[0]!.respondedAt).toBeNull();
  });

  it("returns empty array for place with no reviews", async () => {
    const deps = makeDeps({ reviews: [], total: 0 });

    const result = await listPlaceReviews(deps, { placeId: PLACE_A });

    expect(result.reviews).toEqual([]);
    expect(result.total).toBe(0);
  });
});
