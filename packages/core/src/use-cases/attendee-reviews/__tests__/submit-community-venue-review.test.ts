import { describe, expect, it, vi } from "vitest";

import {
  submitCommunityVenueReview,
  type SubmitCommunityVenueReviewDeps,
} from "../submit-community-venue-review";
import type { CreateCommunityAttendeeReviewInput } from "@th/ports/repos/attendee-reviews";

const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
const HUMAN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = new Date("2026-07-24T15:00:00.000Z");

function createDeps(
  args: { placeExists?: boolean; placeStatus?: string } = {},
) {
  const created: CreateCommunityAttendeeReviewInput[] = [];
  let counter = 0;
  const attendeeReviews = {
    createCommunityReview: vi.fn(
      async (input: CreateCommunityAttendeeReviewInput) => {
        created.push(input);
        counter += 1;
        return {
          id: `00000000-0000-4000-8000-00000000000${counter}`,
          eventId: null,
          humanId: input.humanId ?? null,
          anonymousName: input.anonymousName ?? null,
          anonymousEmail: input.anonymousEmail ?? null,
          source: "COMMUNITY" as const,
          overallRating: input.overallRating,
          soundQuality: input.soundQuality ?? null,
          venueComfort: input.venueComfort ?? null,
          organization: input.organization ?? null,
          valueForMoney: input.valueForMoney ?? null,
          text: input.text ?? null,
          placeId: input.placeId,
          ownerType: null,
          ownerId: null,
          seriesId: null,
          hidden: false,
          flagged: false,
          flagReason: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
      },
    ),
  };
  const places = {
    getById: vi.fn(async () =>
      (args.placeExists ?? true)
        ? { id: PLACE_ID, status: args.placeStatus ?? "ACTIVE" }
        : null,
    ),
  };
  const audit = { log: vi.fn() };
  const txRepos = { attendeeReviews, audit };
  const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(txRepos));

  const deps: SubmitCommunityVenueReviewDeps = {
    repos: {
      tx,
      places,
      attendeeReviews,
      audit,
    } as unknown as SubmitCommunityVenueReviewDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, created, attendeeReviews, audit };
}

describe("submitCommunityVenueReview", () => {
  it("persists a guest review with source=COMMUNITY and eventId=null", async () => {
    const { deps, created, audit } = createDeps();

    const result = await submitCommunityVenueReview(deps, {
      placeId: PLACE_ID,
      anonymousName: "Casey Guest",
      anonymousEmail: "Casey@Example.com",
      overallRating: 5,
      soundQuality: 4,
      text: "Loved the room.",
    });

    expect(result.reviewId).toMatch(/^0{8}-/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      placeId: PLACE_ID,
      humanId: null,
      anonymousName: "Casey Guest",
      // Email normalized to lowercase by the schema.
      anonymousEmail: "casey@example.com",
      overallRating: 5,
      soundQuality: 4,
      text: "Loved the room.",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "attendee_review.community_submitted",
        data: expect.objectContaining({ source: "COMMUNITY", signedIn: false }),
      }),
    );
  });

  it("binds a signed-in submitter to humanId and drops any guest identity", async () => {
    const { deps, created } = createDeps();

    await submitCommunityVenueReview(deps, {
      placeId: PLACE_ID,
      humanId: HUMAN_ID,
      // Even if guest fields sneak in, a signed-in submitter binds to humanId.
      anonymousName: "Ignored",
      anonymousEmail: "ignored@example.com",
      overallRating: 4,
    });

    expect(created[0]).toMatchObject({
      humanId: HUMAN_ID,
      anonymousName: null,
      anonymousEmail: null,
    });
  });

  it("rejects a guest with no email (REQUIRED-but-unverified)", async () => {
    const { deps, attendeeReviews } = createDeps();

    await expect(
      submitCommunityVenueReview(deps, {
        placeId: PLACE_ID,
        anonymousName: "No Email",
        overallRating: 3,
      }),
    ).rejects.toBeDefined();
    expect(attendeeReviews.createCommunityReview).not.toHaveBeenCalled();
  });

  it("rejects a guest with no name", async () => {
    const { deps, attendeeReviews } = createDeps();

    await expect(
      submitCommunityVenueReview(deps, {
        placeId: PLACE_ID,
        anonymousEmail: "nameless@example.com",
        overallRating: 3,
      }),
    ).rejects.toBeDefined();
    expect(attendeeReviews.createCommunityReview).not.toHaveBeenCalled();
  });

  it("throws PLACE_NOT_FOUND for an unknown place", async () => {
    const { deps, attendeeReviews } = createDeps({ placeExists: false });

    await expect(
      submitCommunityVenueReview(deps, {
        placeId: PLACE_ID,
        humanId: HUMAN_ID,
        overallRating: 5,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(attendeeReviews.createCommunityReview).not.toHaveBeenCalled();
  });

  it("throws PLACE_NOT_ACTIVE for an archived place", async () => {
    const { deps, attendeeReviews } = createDeps({ placeStatus: "ARCHIVED" });

    await expect(
      submitCommunityVenueReview(deps, {
        placeId: PLACE_ID,
        humanId: HUMAN_ID,
        overallRating: 5,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    expect(attendeeReviews.createCommunityReview).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range rating", async () => {
    const { deps } = createDeps();
    await expect(
      submitCommunityVenueReview(deps, {
        placeId: PLACE_ID,
        humanId: HUMAN_ID,
        overallRating: 6,
      }),
    ).rejects.toBeDefined();
  });
});
