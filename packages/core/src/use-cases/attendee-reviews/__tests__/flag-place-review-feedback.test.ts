import { describe, expect, it, vi } from "vitest";

import {
  flagPlaceReviewFeedback,
  type FlagPlaceReviewFeedbackDeps,
} from "../flag-place-review-feedback";
import type {
  AttendeeReviewRecord,
  AttendeeReviewSource,
} from "@th/ports/repos/attendee-reviews";

const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
const OTHER_PLACE_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const OWNER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const STRANGER_ID = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-25T12:00:00.000Z");

function rec(
  source: AttendeeReviewSource,
  overrides: Partial<AttendeeReviewRecord> = {},
): AttendeeReviewRecord {
  return {
    id: REVIEW_ID,
    eventId: source === "COMMUNITY" ? null : "event-1",
    humanId: source === "COMMUNITY" ? null : "human-1",
    anonymousName: source === "COMMUNITY" ? "Guest" : null,
    anonymousEmail: source === "COMMUNITY" ? "guest@example.com" : null,
    source,
    overallRating: 5,
    soundQuality: null,
    venueComfort: null,
    organization: null,
    valueForMoney: null,
    text: null,
    placeId: PLACE_ID,
    ownerType: null,
    ownerId: null,
    seriesId: null,
    hidden: false,
    flagged: false,
    flagReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildDeps(args: {
  review: AttendeeReviewRecord | null;
  humanIdsWithAccess?: string[];
  orgIdsWithAccess?: string[];
  membership?: boolean;
}) {
  const places = {
    getById: vi.fn(async () => ({
      id: PLACE_ID,
      humanIdsWithAccess: args.humanIdsWithAccess ?? [OWNER_ID],
      orgIdsWithAccess: args.orgIdsWithAccess ?? [],
    })),
  };
  const authz = {
    getOrgMemberships: vi.fn(async () =>
      args.membership ? [{ orgId: "o", humanId: OWNER_ID, role: "ADMIN" }] : [],
    ),
  };
  const setFlagged = vi.fn(async () => args.review as AttendeeReviewRecord);
  const attendeeReviews = {
    getById: vi.fn(async () => args.review),
    setFlagged,
  };
  const audit = { log: vi.fn(async () => {}) };
  const deps: FlagPlaceReviewFeedbackDeps = {
    repos: {
      places,
      authz,
      attendeeReviews,
      audit,
    } as unknown as FlagPlaceReviewFeedbackDeps["repos"],
    clock: { now: () => NOW },
  };
  return { deps, setFlagged, audit, attendeeReviews };
}

describe("flagPlaceReviewFeedback", () => {
  it("lets the venue owner flag a COMMUNITY review on their place", async () => {
    const { deps, setFlagged, audit } = buildDeps({
      review: rec("COMMUNITY"),
    });

    const out = await flagPlaceReviewFeedback(deps, {
      placeId: PLACE_ID,
      reviewId: REVIEW_ID,
      actorHumanId: OWNER_ID,
      reason: "Spam",
    });

    expect(out).toEqual({ reviewId: REVIEW_ID, flagged: true });
    expect(setFlagged).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      flagged: true,
      flagReason: "Spam",
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("lets an org member flag", async () => {
    const { deps, setFlagged } = buildDeps({
      review: rec("COMMUNITY"),
      humanIdsWithAccess: [],
      orgIdsWithAccess: ["org-1"],
      membership: true,
    });

    await flagPlaceReviewFeedback(deps, {
      placeId: PLACE_ID,
      reviewId: REVIEW_ID,
      actorHumanId: OWNER_ID,
    });

    expect(setFlagged).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      flagged: true,
      flagReason: null,
    });
  });

  it("rejects a non-owner with NOT_RESOURCE_OWNER and never touches the review", async () => {
    const { deps, setFlagged, attendeeReviews } = buildDeps({
      review: rec("COMMUNITY"),
      humanIdsWithAccess: [OWNER_ID],
    });

    await expect(
      flagPlaceReviewFeedback(deps, {
        placeId: PLACE_ID,
        reviewId: REVIEW_ID,
        actorHumanId: STRANGER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(attendeeReviews.getById).not.toHaveBeenCalled();
    expect(setFlagged).not.toHaveBeenCalled();
  });

  it("rejects flagging a review that belongs to a different place (REVIEW_NOT_FOUND)", async () => {
    const { deps, setFlagged } = buildDeps({
      review: rec("COMMUNITY", { placeId: OTHER_PLACE_ID }),
    });

    await expect(
      flagPlaceReviewFeedback(deps, {
        placeId: PLACE_ID,
        reviewId: REVIEW_ID,
        actorHumanId: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    expect(setFlagged).not.toHaveBeenCalled();
  });

  it("rejects a missing review with REVIEW_NOT_FOUND", async () => {
    const { deps, setFlagged } = buildDeps({ review: null });

    await expect(
      flagPlaceReviewFeedback(deps, {
        placeId: PLACE_ID,
        reviewId: REVIEW_ID,
        actorHumanId: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    expect(setFlagged).not.toHaveBeenCalled();
  });
});
