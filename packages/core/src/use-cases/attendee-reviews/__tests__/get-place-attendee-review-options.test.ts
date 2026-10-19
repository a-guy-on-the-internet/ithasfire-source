import { describe, expect, it, vi } from "vitest";

import {
  getPlaceAttendeeReviewOptions,
  type GetPlaceAttendeeReviewOptionsDeps,
} from "../get-place-attendee-review-options";
import { ATTENDEE_REVIEW_WINDOW_MS } from "../constants";
import type { PlaceReviewableEventCandidate } from "@th/ports/repos/attendee-reviews";

const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
const VIEWER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = new Date("2026-07-24T12:00:00.000Z");

function buildDeps(candidates: PlaceReviewableEventCandidate[]) {
  const attendeeReviews = {
    listReviewableEventCandidatesForPlace: vi.fn(async () => candidates),
  };
  const deps: GetPlaceAttendeeReviewOptionsDeps = {
    repos: {
      attendeeReviews,
    } as unknown as GetPlaceAttendeeReviewOptionsDeps["repos"],
    clock: { now: () => NOW },
  };
  return { deps, attendeeReviews };
}

function candidate(
  id: string,
  endsAt: Date | null,
  startsAt = new Date(endsAt ?? NOW),
): PlaceReviewableEventCandidate {
  return { eventId: id, title: `Show ${id}`, startsAt, endsAt, status: "PUBLISHED" };
}

const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe("getPlaceAttendeeReviewOptions", () => {
  it("returns ended events still inside the 30-day window", async () => {
    const endedYesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const { deps } = buildDeps([candidate(uuid(1), endedYesterday)]);

    const out = await getPlaceAttendeeReviewOptions(deps, {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER_ID,
    });

    expect(out.eligibleEvents).toEqual([
      { eventId: uuid(1), title: "Show " + uuid(1), date: endedYesterday },
    ]);
  });

  it("excludes an event that has not ended yet", async () => {
    const endsTomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const { deps } = buildDeps([candidate(uuid(2), endsTomorrow)]);

    const out = await getPlaceAttendeeReviewOptions(deps, {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER_ID,
    });

    expect(out.eligibleEvents).toEqual([]);
  });

  it("excludes an event whose review window has closed", async () => {
    const longEnded = new Date(NOW.getTime() - ATTENDEE_REVIEW_WINDOW_MS - 1000);
    const { deps } = buildDeps([candidate(uuid(3), longEnded)]);

    const out = await getPlaceAttendeeReviewOptions(deps, {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER_ID,
    });

    expect(out.eligibleEvents).toEqual([]);
  });

  it("never throws when there are no candidates (community floor is unaffected)", async () => {
    const { deps } = buildDeps([]);

    const out = await getPlaceAttendeeReviewOptions(deps, {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER_ID,
    });

    expect(out.eligibleEvents).toEqual([]);
  });
});
