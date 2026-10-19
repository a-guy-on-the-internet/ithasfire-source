import { beforeEach, describe, expect, it, vi } from "vitest";

import * as placeReviewUseCases from "@th/core/use-cases/place-reviews";

import { buildBaseCtx } from "./test-helpers";
import { placeReviewsRouter } from "../place-reviews";
import { router } from "../../init";

describe("placeReviewsRouter — Discord alerts on new venue submit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const baseInput = {
    placeName: "E2E Jazz Club",
    placeCity: "Austin",
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

  function createCallerWithDiscord(
    discordAlert: ReturnType<typeof vi.fn>,
    publicAppUrl: string,
  ) {
    const baseCtx = buildBaseCtx();
    const ctx = { ...baseCtx, discordAlert, publicAppUrl } as any;
    const testRouter = router(placeReviewsRouter);
    return { caller: testRouter.createCaller(ctx) as any, ctx };
  }

  it("sends a Discord alert with platform link when a new venue is created", async () => {
    const discordAlert = vi.fn(async () => {});

    vi.spyOn(placeReviewUseCases, "submitPlaceReview").mockResolvedValue({
      reviewId: "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      placeId: "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      createdStubPlace: true,
    });

    const { caller } = createCallerWithDiscord(
      discordAlert,
      "https://ithasfire.com",
    );

    await caller.submit(baseInput);

    // Should fire TWO discord alerts: the review alert + the new venue alert
    expect(discordAlert).toHaveBeenCalledTimes(2);

    // Second call is the new-venue alert
    const venueAlert = discordAlert.mock.calls[1]![0];
    expect(venueAlert.title).toContain("New place submitted");
    expect(venueAlert.colour).toBe("warning");
    const venueField = venueAlert.fields?.find(
      (f: { name: string }) => f.name === "Place",
    );
    expect(venueField).toBeDefined();
    expect(venueField!.value).toContain("E2E Jazz Club");

    // Verify it includes the exact unverified filter link to platform places
    const reviewField = venueAlert.fields?.find(
      (f: { name: string }) => f.name === "Review",
    );
    expect(reviewField).toBeDefined();
    expect(reviewField!.value).toBe(
      "[Open platform places](https://ithasfire.com/platform/places?filter=unverified)",
    );
  });

  it("does NOT send the venue alert for an existing venue", async () => {
    const discordAlert = vi.fn(async () => {});

    vi.spyOn(placeReviewUseCases, "submitPlaceReview").mockResolvedValue({
      reviewId: "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      placeId: "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      createdStubPlace: false,
    });

    const { caller } = createCallerWithDiscord(
      discordAlert,
      "https://ithasfire.com",
    );

    await caller.submit({
      ...baseInput,
      placeId: "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    // Only the review alert, no venue alert
    expect(discordAlert).toHaveBeenCalledTimes(1);
    expect(discordAlert.mock.calls[0]![0].title).toContain("New place review");
  });
});
