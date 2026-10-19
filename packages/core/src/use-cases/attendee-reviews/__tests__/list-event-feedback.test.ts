import { describe, expect, it, vi } from "vitest";

import { listEventFeedback } from "../list-event-feedback";
import type { ListEventFeedbackDeps } from "../list-event-feedback";
import type { AttendeeReviewRecord } from "@th/ports/repos/attendee-reviews";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const ORG_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const OWNER_HUMAN_ID = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const ACTOR_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

let counter = 0;
function reviewRecord(
  overrides: Partial<AttendeeReviewRecord> = {},
): AttendeeReviewRecord {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${counter}`,
    eventId: EVENT_ID,
    humanId: `secret-human-${counter}`,
    overallRating: 5,
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
    createdAt: new Date("2026-07-15T12:00:00.000Z"),
    updatedAt: new Date("2026-07-15T12:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(opts: {
  event?: { orgId?: string | null; humanId?: string | null } | null;
  reviews?: AttendeeReviewRecord[];
  membershipRole?: string | null;
}) {
  const getById = vi.fn(async () =>
    opts.event === null
      ? null
      : {
          id: EVENT_ID,
          orgId: opts.event?.orgId ?? null,
          humanId: opts.event?.humanId ?? null,
        },
  );
  const listForEventFeedback = vi.fn(async () => opts.reviews ?? []);
  const getOrgMembership = vi.fn(async () =>
    opts.membershipRole ? { role: opts.membershipRole } : null,
  );

  const deps: ListEventFeedbackDeps = {
    repos: {
      events: { getById },
      attendeeReviews: { listForEventFeedback },
      authz: { getOrgMembership },
    } as any,
  };
  return { deps, getById, listForEventFeedback, getOrgMembership };
}

describe("listEventFeedback (FR-007)", () => {
  const input = { eventId: EVENT_ID, actorHumanId: ACTOR_ID };

  describe("authorization", () => {
    it("allows an org EDITOR of the owning org", async () => {
      const { deps } = makeDeps({
        event: { orgId: ORG_ID },
        membershipRole: "EDITOR",
        reviews: [reviewRecord()],
      });

      const result = await listEventFeedback(deps, input);
      expect(result.aggregate.reviewCount).toBe(1);
    });

    it("rejects a non-member of the owning org", async () => {
      const { deps } = makeDeps({
        event: { orgId: ORG_ID },
        membershipRole: null,
      });

      await expect(listEventFeedback(deps, input)).rejects.toBeDefined();
    });

    it("allows the human owner of a human-owned event", async () => {
      const { deps } = makeDeps({
        event: { humanId: ACTOR_ID },
        reviews: [reviewRecord()],
      });

      const result = await listEventFeedback(deps, input);
      expect(result.aggregate.reviewCount).toBe(1);
    });

    it("rejects a non-owner of a human-owned event", async () => {
      const { deps } = makeDeps({ event: { humanId: OWNER_HUMAN_ID } });

      await expect(listEventFeedback(deps, input)).rejects.toBeDefined();
    });

    it("throws when the event does not exist", async () => {
      const { deps } = makeDeps({ event: null });
      await expect(listEventFeedback(deps, input)).rejects.toBeDefined();
    });
  });

  describe("privacy (FR-002 — no identity leak)", () => {
    it("returns text UNATTRIBUTED — no humanId, rating, or timestamp per item", async () => {
      const { deps } = makeDeps({
        event: { orgId: ORG_ID },
        membershipRole: "OWNER",
        reviews: [
          reviewRecord({ text: "great sound", overallRating: 5, flagged: false }),
          reviewRecord({ text: null }), // no comment → excluded from list
          reviewRecord({ text: "too loud", overallRating: 2, flagged: true }),
        ],
      });

      const result = await listEventFeedback(deps, input);

      // Only the two rows WITH text appear, newest-first order preserved.
      expect(result.feedback).toHaveLength(2);
      for (const item of result.feedback) {
        // Exactly these three keys — nothing that identifies the reviewer.
        expect(Object.keys(item).sort()).toStrictEqual([
          "flagged",
          "reviewId",
          "text",
        ]);
        expect(item).not.toHaveProperty("humanId");
        expect(item).not.toHaveProperty("createdAt");
        expect(item).not.toHaveProperty("overallRating");
      }
      expect(result.feedback.map((f) => f.text)).toStrictEqual([
        "great sound",
        "too loud",
      ]);
      expect(result.feedback[1]!.flagged).toBe(true);
    });
  });

  describe("exact aggregate (FR-007 — organizers see their own numbers)", () => {
    it("returns EXACT unrounded means with NO k-gate", async () => {
      // Only 3 reviewers (below the public MIN_REVIEWERS) — the organizer STILL
      // sees exact numbers on their own event.
      const { deps } = makeDeps({
        event: { orgId: ORG_ID },
        membershipRole: "ADMIN",
        reviews: [
          reviewRecord({ overallRating: 5, soundQuality: 4 }),
          reviewRecord({ overallRating: 4, soundQuality: 3 }),
          reviewRecord({ overallRating: 3, soundQuality: null }),
        ],
      });

      const result = await listEventFeedback(deps, input);

      expect(result.aggregate.reviewCount).toBe(3);
      expect(result.aggregate.overallMean).toBeCloseTo(4);
      expect(result.aggregate.soundQualityMean).toBeCloseTo(3.5);
      expect(result.aggregate.valueForMoneyMean).toBeNull();
      // recommend proxy: 2 of 3 rated >= 4 → 66.66…% unrounded.
      expect(result.aggregate.recommendPct).toBeCloseTo((2 / 3) * 100);
    });
  });
});
