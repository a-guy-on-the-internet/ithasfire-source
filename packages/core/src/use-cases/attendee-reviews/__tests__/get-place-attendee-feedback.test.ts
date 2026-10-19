import { describe, expect, it, vi } from "vitest";

import {
  getPlaceAttendeeFeedback,
  type GetPlaceAttendeeFeedbackDeps,
} from "../get-place-attendee-feedback";
import type {
  AttendeeReviewRecord,
  AttendeeReviewSource,
} from "@th/ports/repos/attendee-reviews";

const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
const OWNER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const STRANGER_ID = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

let counter = 0;
function rec(
  source: AttendeeReviewSource,
  overrides: Partial<AttendeeReviewRecord> = {},
): AttendeeReviewRecord {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${counter}`,
    eventId: source === "COMMUNITY" ? null : `event-${counter}`,
    humanId: source === "COMMUNITY" ? null : `human-${counter}`,
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
    createdAt: new Date(`2026-07-${10 + counter}T12:00:00.000Z`),
    updatedAt: new Date(`2026-07-${10 + counter}T12:00:00.000Z`),
    ...overrides,
  };
}

function buildDeps(args: {
  reviews: AttendeeReviewRecord[];
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
  const attendeeReviews = {
    listForPlaceFeedback: vi.fn(async () => args.reviews),
  };
  const deps: GetPlaceAttendeeFeedbackDeps = {
    repos: {
      places,
      authz,
      attendeeReviews,
    } as unknown as GetPlaceAttendeeFeedbackDeps["repos"],
  };
  return { deps, attendeeReviews };
}

describe("getPlaceAttendeeFeedback", () => {
  it("splits the exact aggregate by source and never merges community into verified", async () => {
    // 3 verified + 2 community. Exact aggregates (no k-gate) count each source
    // separately.
    const reviews = [
      rec("VERIFIED_TICKET", { overallRating: 5 }),
      rec("VERIFIED_TICKET", { overallRating: 4 }),
      rec("VERIFIED_TICKET", { overallRating: 3 }),
      rec("COMMUNITY", { overallRating: 2 }),
      rec("COMMUNITY", { overallRating: 4 }),
    ];
    const { deps } = buildDeps({ reviews });

    const out = await getPlaceAttendeeFeedback(deps, {
      placeId: PLACE_ID,
      actorHumanId: OWNER_ID,
    });

    expect(out.verified.reviewCount).toBe(3);
    expect(out.verified.overallMean).toBeCloseTo(4); // (5+4+3)/3
    expect(out.community.reviewCount).toBe(2);
    expect(out.community.overallMean).toBeCloseTo(3); // (2+4)/2
  });

  it("returns unattributed entries — source + rating + text + createdAt only", async () => {
    const reviews = [
      rec("COMMUNITY", { overallRating: 4, text: "Nice venue" }),
      rec("VERIFIED_TICKET", { overallRating: 5, text: null }),
    ];
    const { deps } = buildDeps({ reviews });

    const out = await getPlaceAttendeeFeedback(deps, {
      placeId: PLACE_ID,
      actorHumanId: OWNER_ID,
    });

    expect(out.entries).toHaveLength(2);
    const community = out.entries.find((e) => e.source === "COMMUNITY")!;
    expect(community).toEqual({
      reviewId: expect.any(String),
      source: "COMMUNITY",
      rating: 4,
      text: "Nice venue",
      createdAt: expect.any(Date),
    });
    // The no-text verified entry omits `text` entirely.
    const verified = out.entries.find((e) => e.source === "VERIFIED_TICKET")!;
    expect(verified).not.toHaveProperty("text");
    // No identity leaks in any entry.
    for (const entry of out.entries) {
      expect(entry).not.toHaveProperty("humanId");
      expect(entry).not.toHaveProperty("anonymousName");
      expect(entry).not.toHaveProperty("anonymousEmail");
      expect(entry).not.toHaveProperty("id");
    }
  });

  it("allows an org member to read", async () => {
    const { deps } = buildDeps({
      reviews: [rec("VERIFIED_TICKET")],
      humanIdsWithAccess: [],
      orgIdsWithAccess: ["org-1"],
      membership: true,
    });

    const out = await getPlaceAttendeeFeedback(deps, {
      placeId: PLACE_ID,
      actorHumanId: OWNER_ID,
    });
    expect(out.verified.reviewCount).toBe(1);
  });

  it("rejects a non-owner with NOT_RESOURCE_OWNER", async () => {
    const { deps, attendeeReviews } = buildDeps({
      reviews: [rec("VERIFIED_TICKET")],
      humanIdsWithAccess: [OWNER_ID],
    });

    await expect(
      getPlaceAttendeeFeedback(deps, {
        placeId: PLACE_ID,
        actorHumanId: STRANGER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(attendeeReviews.listForPlaceFeedback).not.toHaveBeenCalled();
  });
});
