import { describe, expect, it, vi } from "vitest";

import {
  getAttendeeReviewEligibility,
  type GetAttendeeReviewEligibilityDeps,
} from "../get-attendee-review-eligibility";
import { ATTENDEE_REVIEW_WINDOW_MS } from "../constants";
import {
  EVENT_ID,
  HUMAN_ID,
  NOW,
  makeClock,
  makeEvent,
  makeFakeAttendeeReviewsRepo,
} from "./helpers";

function createDeps(args: {
  event?: ReturnType<typeof makeEvent> | null;
  scanned?: boolean;
  existingReview?: boolean;
}) {
  const fake = makeFakeAttendeeReviewsRepo({ scanned: args.scanned });
  if (args.existingReview) {
    fake.rows.push({
      id: "00000000-0000-4000-8000-000000000009",
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      overallRating: 4,
      soundQuality: null,
      venueComfort: null,
      organization: null,
      valueForMoney: null,
      text: null,
      placeId: null,
      ownerType: null,
      ownerId: null,
      seriesId: null,
      hidden: false,
      flagged: false,
      flagReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const events = {
    getById: vi.fn(async () =>
      args.event === undefined ? makeEvent() : args.event,
    ),
  };
  const deps: GetAttendeeReviewEligibilityDeps = {
    repos: {
      events,
      attendeeReviews: fake.repo,
    } as unknown as GetAttendeeReviewEligibilityDeps["repos"],
    clock: makeClock(),
  };
  return { deps, fake };
}

const INPUT = { eventId: EVENT_ID, actorHumanId: HUMAN_ID };

describe("getAttendeeReviewEligibility", () => {
  it("is eligible for a scanned attendee of an ended event inside the window", async () => {
    const { deps } = createDeps({});

    const result = await getAttendeeReviewEligibility(deps, INPUT);

    const endsAt = makeEvent().endsAt as Date;
    expect(result).toEqual({
      eligible: true,
      reason: null,
      windowClosesAt: new Date(endsAt.getTime() + ATTENDEE_REVIEW_WINDOW_MS),
    });
  });

  it("event_not_found when the event doesn't exist", async () => {
    const { deps } = createDeps({ event: null });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: false,
      reason: "event_not_found",
    });
  });

  it("event_cancelled for CANCELLED events", async () => {
    const { deps } = createDeps({ event: makeEvent({ status: "CANCELLED" }) });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: false,
      reason: "event_cancelled",
    });
  });

  it("event_not_ended while the event is still in the future", async () => {
    const { deps } = createDeps({
      event: makeEvent({
        startsAt: new Date("2026-07-20T22:00:00.000Z"),
        endsAt: new Date("2026-07-20T23:30:00.000Z"),
      }),
    });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: false,
      reason: "event_not_ended",
    });
  });

  it("window_closed more than 30 days after the event ended", async () => {
    const { deps } = createDeps({
      event: makeEvent({
        startsAt: new Date("2026-06-01T22:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:30:00.000Z"),
      }),
    });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: false,
      reason: "window_closed",
      windowClosesAt: new Date(
        new Date("2026-06-01T23:30:00.000Z").getTime() +
          ATTENDEE_REVIEW_WINDOW_MS,
      ),
    });
  });

  it("is still eligible exactly at the window boundary", async () => {
    const endsAt = new Date(NOW.getTime() - ATTENDEE_REVIEW_WINDOW_MS);
    const { deps } = createDeps({
      event: makeEvent({
        startsAt: new Date(endsAt.getTime() - 60 * 60 * 1000),
        endsAt,
      }),
    });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({ eligible: true });
  });

  it("no_scanned_ticket for unscanned humans (unscanned tickets don't count)", async () => {
    const { deps } = createDeps({ scanned: false });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: false,
      reason: "no_scanned_ticket",
    });
  });

  it("already_reviewed when a review exists for the pair", async () => {
    const { deps } = createDeps({ existingReview: true });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: false,
      reason: "already_reviewed",
    });
  });

  it("falls back to startsAt when endsAt is null", async () => {
    const { deps } = createDeps({
      event: makeEvent({
        startsAt: new Date("2026-07-12T22:00:00.000Z"),
        endsAt: null,
      }),
    });
    const result = await getAttendeeReviewEligibility(deps, INPUT);
    expect(result).toMatchObject({
      eligible: true,
      windowClosesAt: new Date(
        new Date("2026-07-12T22:00:00.000Z").getTime() +
          ATTENDEE_REVIEW_WINDOW_MS,
      ),
    });
  });
});
