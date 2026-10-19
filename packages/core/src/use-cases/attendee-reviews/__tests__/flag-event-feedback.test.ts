import { describe, expect, it, vi } from "vitest";

import { flagEventFeedback } from "../flag-event-feedback";
import type { FlagEventFeedbackDeps } from "../flag-event-feedback";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const ORG_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const OWNER_HUMAN_ID = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const ACTOR_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = new Date("2026-07-15T12:00:00.000Z");

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    eventId: EVENT_ID,
    humanId: "cccccccc-1111-4111-8111-cccccccccccc",
    hidden: false,
    flagged: false,
    flagReason: null,
    ...overrides,
  };
}

function makeDeps(opts: {
  review?: unknown;
  event?: { orgId?: string | null; humanId?: string | null } | null;
  membershipRole?: string | null;
}) {
  const reviewGetById = vi.fn(async () =>
    opts.review === undefined ? makeReview() : opts.review,
  );
  const eventGetById = vi.fn(async () =>
    opts.event === null
      ? null
      : {
          id: EVENT_ID,
          orgId: opts.event?.orgId ?? null,
          humanId: opts.event?.humanId ?? null,
        },
  );
  const setFlagged = vi.fn(async () => makeReview({ flagged: true }));
  const getOrgMembership = vi.fn(async () =>
    opts.membershipRole ? { role: opts.membershipRole } : null,
  );
  const auditLog = vi.fn(async () => {});

  const deps: FlagEventFeedbackDeps = {
    repos: {
      events: { getById: eventGetById },
      attendeeReviews: { getById: reviewGetById, setFlagged },
      authz: { getOrgMembership },
      audit: { log: auditLog },
    } as any,
    clock: { now: () => NOW },
  };
  return { deps, reviewGetById, eventGetById, setFlagged, getOrgMembership, auditLog };
}

const INPUT = { reviewId: REVIEW_ID, actorHumanId: ACTOR_ID };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("flagEventFeedback (FR-007 — owner report action)", () => {
  it("an org EDITOR of the owning org can flag → setFlagged + audit", async () => {
    const { deps, setFlagged, auditLog } = makeDeps({
      event: { orgId: ORG_ID },
      membershipRole: "EDITOR",
    });

    const result = await flagEventFeedback(deps, {
      ...INPUT,
      reason: "  spam & abuse  ",
    });

    expect(result).toStrictEqual({ reviewId: REVIEW_ID, flagged: true });
    expect(setFlagged).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      flagged: true,
      flagReason: "spam & abuse",
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "attendee_review",
        entityId: REVIEW_ID,
        action: "attendee_review.flagged",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          hasReason: true,
        }),
        at: NOW,
      }),
    );
    // FR-002: the trail records who/when, never the review content.
    const auditData = auditLog.mock.calls[0]![0].data as Record<
      string,
      unknown
    >;
    expect(auditData).not.toHaveProperty("text");
    expect(auditData).not.toHaveProperty("overallRating");
  });

  it("the human owner of a human-owned event can flag", async () => {
    const { deps, setFlagged } = makeDeps({
      event: { humanId: ACTOR_ID },
    });

    const result = await flagEventFeedback(deps, INPUT);
    expect(result.flagged).toBe(true);
    expect(setFlagged).toHaveBeenCalledTimes(1);
  });

  it("records hasReason=false and a null flagReason when no reason is given", async () => {
    const { deps, setFlagged, auditLog } = makeDeps({
      event: { orgId: ORG_ID },
      membershipRole: "OWNER",
    });

    await flagEventFeedback(deps, INPUT);

    expect(setFlagged).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      flagged: true,
      flagReason: null,
    });
    expect(
      (auditLog.mock.calls[0]![0].data as Record<string, unknown>).hasReason,
    ).toBe(false);
  });

  it("IDOR: a non-member of the owning org is REJECTED and setFlagged is NOT called", async () => {
    const { deps, setFlagged, auditLog } = makeDeps({
      event: { orgId: ORG_ID },
      membershipRole: null,
    });

    await expect(flagEventFeedback(deps, INPUT)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(setFlagged).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("IDOR: an org VIEWER (below EDIT) cannot flag", async () => {
    const { deps, setFlagged } = makeDeps({
      event: { orgId: ORG_ID },
      membershipRole: "VIEWER",
    });

    await expect(flagEventFeedback(deps, INPUT)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(setFlagged).not.toHaveBeenCalled();
  });

  it("IDOR: a different human cannot flag a human-owned event", async () => {
    const { deps, setFlagged, auditLog } = makeDeps({
      event: { humanId: OWNER_HUMAN_ID },
    });

    await expect(flagEventFeedback(deps, INPUT)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(setFlagged).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("REVIEW_NOT_FOUND when the review does not exist", async () => {
    const { deps, eventGetById, setFlagged } = makeDeps({
      review: null,
      event: { orgId: ORG_ID },
      membershipRole: "OWNER",
    });

    await expect(flagEventFeedback(deps, INPUT)).rejects.toMatchObject({
      code: "REVIEW_NOT_FOUND",
    });
    // Never even looks up the event / mutates when the review is missing.
    expect(eventGetById).not.toHaveBeenCalled();
    expect(setFlagged).not.toHaveBeenCalled();
  });

  it("EVENT_NOT_FOUND when the owning event is missing", async () => {
    const { deps, setFlagged } = makeDeps({
      event: null,
      membershipRole: "OWNER",
    });

    await expect(flagEventFeedback(deps, INPUT)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
    expect(setFlagged).not.toHaveBeenCalled();
  });

  it("NOT_RESOURCE_OWNER when the event has neither an org nor a human owner", async () => {
    const { deps, setFlagged } = makeDeps({
      event: { orgId: null, humanId: null },
    });

    await expect(flagEventFeedback(deps, INPUT)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(setFlagged).not.toHaveBeenCalled();
  });
});
