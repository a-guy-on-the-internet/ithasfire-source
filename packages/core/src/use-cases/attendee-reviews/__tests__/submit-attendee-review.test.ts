import { describe, expect, it, vi } from "vitest";

import {
  submitAttendeeReview,
  type SubmitAttendeeReviewDeps,
} from "../submit-attendee-review";
import { ATTENDEE_REVIEW_WINDOW_MS } from "../constants";
import {
  EVENT_ID,
  HUMAN_ID,
  NOW,
  ORG_ID,
  OWNER_HUMAN_ID,
  PLACE_ID,
  SERIES_ID,
  makeClock,
  makeEvent,
  makeFakeAttendeeReviewsRepo,
} from "./helpers";

function createDeps(args: {
  event?: ReturnType<typeof makeEvent> | null;
  scanned?: boolean;
  seriesId?: string | null;
}) {
  const fake = makeFakeAttendeeReviewsRepo({ scanned: args.scanned });
  const events = {
    getById: vi.fn(async () =>
      args.event === undefined ? makeEvent() : args.event,
    ),
  };
  const seriesOccurrences = {
    findSeriesIdByEventId: vi.fn(async () =>
      args.seriesId === undefined || args.seriesId === null
        ? null
        : { seriesId: args.seriesId, seriesName: "Loud Nights" },
    ),
  };
  const audit = { log: vi.fn() };
  const txRepos = { attendeeReviews: fake.repo, audit };
  const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
    fn(txRepos),
  );

  const deps: SubmitAttendeeReviewDeps = {
    repos: {
      tx,
      events,
      attendeeReviews: fake.repo,
      seriesOccurrences,
      audit,
    } as unknown as SubmitAttendeeReviewDeps["repos"],
    clock: makeClock(),
  };

  return { deps, fake, audit, tx };
}

const BASE_INPUT = {
  eventId: EVENT_ID,
  actorHumanId: HUMAN_ID,
  overallRating: 4,
};

describe("submitAttendeeReview", () => {
  it("writes the review with targets denormalized from the EVENT ROW (org owner + series)", async () => {
    const { deps, fake, audit } = createDeps({ seriesId: SERIES_ID });

    const result = await submitAttendeeReview(deps, {
      ...BASE_INPUT,
      soundQuality: 5,
      valueForMoney: 3,
      text: "Great sound, slow bar.",
    });

    expect(result.reviewId).toBe(fake.rows[0]!.id);
    expect(fake.rows[0]).toMatchObject({
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      overallRating: 4,
      soundQuality: 5,
      venueComfort: null,
      organization: null,
      valueForMoney: 3,
      text: "Great sound, slow bar.",
      // Denormalized from the event, never from input:
      placeId: PLACE_ID,
      ownerType: "organization",
      ownerId: ORG_ID,
      seriesId: SERIES_ID,
    });
    // Audit trail records who/when/targets — no rating values, no text.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "attendee_review",
        action: "attendee_review.submitted",
        data: expect.objectContaining({
          eventId: EVENT_ID,
          humanId: HUMAN_ID,
          hasText: true,
        }),
        at: NOW,
      }),
    );
    const auditData = audit.log.mock.calls[0]![0].data as Record<
      string,
      unknown
    >;
    expect(auditData).not.toHaveProperty("text");
    expect(auditData).not.toHaveProperty("overallRating");
  });

  it("stamps a human owner pair for human-owned events", async () => {
    const { deps, fake } = createDeps({
      event: makeEvent({ orgId: null, humanId: OWNER_HUMAN_ID }),
    });

    await submitAttendeeReview(deps, BASE_INPUT);

    expect(fake.rows[0]).toMatchObject({
      ownerType: "human",
      ownerId: OWNER_HUMAN_ID,
      seriesId: null,
    });
  });

  it("sanitizes the private text BEFORE the length check and stores plain text", async () => {
    const { deps, fake } = createDeps({});

    await submitAttendeeReview(deps, {
      ...BASE_INPUT,
      text: "  <script>alert(1)</script>Great   show‮!  ",
    });

    expect(fake.rows[0]!.text).toBe("Great show!");
  });

  it("normalizes an all-whitespace comment to NULL", async () => {
    const { deps, fake } = createDeps({});

    await submitAttendeeReview(deps, { ...BASE_INPUT, text: "   \n\n  " });

    expect(fake.rows[0]!.text).toBeNull();
  });

  it("rejects ratings outside 1-5", async () => {
    const { deps } = createDeps({});
    await expect(
      submitAttendeeReview(deps, { ...BASE_INPUT, overallRating: 6 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      submitAttendeeReview(deps, { ...BASE_INPUT, soundQuality: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("EVENT_NOT_FOUND when the event doesn't exist", async () => {
    const { deps } = createDeps({ event: null });
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "EVENT_NOT_FOUND" },
    );
  });

  it("EVENT_ALREADY_CANCELLED for cancelled events", async () => {
    const { deps, fake } = createDeps({
      event: makeEvent({ status: "CANCELLED" }),
    });
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "EVENT_ALREADY_CANCELLED" },
    );
    expect(fake.rows).toHaveLength(0);
  });

  it("ATTENDEE_REVIEW_EVENT_NOT_ENDED before the event ends", async () => {
    const { deps } = createDeps({
      event: makeEvent({
        startsAt: new Date("2026-07-20T22:00:00.000Z"),
        endsAt: new Date("2026-07-20T23:30:00.000Z"),
      }),
    });
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "ATTENDEE_REVIEW_EVENT_NOT_ENDED" },
    );
  });

  it("ATTENDEE_REVIEW_WINDOW_CLOSED more than 30 days after event end", async () => {
    const endsAt = new Date(NOW.getTime() - ATTENDEE_REVIEW_WINDOW_MS - 1000);
    const { deps } = createDeps({
      event: makeEvent({
        startsAt: new Date(endsAt.getTime() - 60 * 60 * 1000),
        endsAt,
      }),
    });
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "ATTENDEE_REVIEW_WINDOW_CLOSED" },
    );
  });

  it("TICKET_NOT_SCANNED when the actor has no scanned ticket (server-enforced, never client-trusted)", async () => {
    const { deps, fake } = createDeps({ scanned: false });
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "TICKET_NOT_SCANNED" },
    );
    expect(fake.rows).toHaveLength(0);
  });

  it("ATTENDEE_REVIEW_ALREADY_SUBMITTED on a duplicate (pre-check)", async () => {
    const { deps } = createDeps({});

    await submitAttendeeReview(deps, BASE_INPUT);
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "ATTENDEE_REVIEW_ALREADY_SUBMITTED" },
    );
  });

  it("ATTENDEE_REVIEW_ALREADY_SUBMITTED via the unique-index backstop on a pre-check race", async () => {
    const { deps, fake } = createDeps({});
    // Simulate the race: the pre-check misses, the insert hits the index.
    (
      fake.repo.findByEventAndHuman as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    await submitAttendeeReview(deps, BASE_INPUT);

    (
      fake.repo.findByEventAndHuman as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    await expect(submitAttendeeReview(deps, BASE_INPUT)).rejects.toMatchObject(
      { code: "ATTENDEE_REVIEW_ALREADY_SUBMITTED" },
    );
    expect(fake.rows).toHaveLength(1);
  });
});
