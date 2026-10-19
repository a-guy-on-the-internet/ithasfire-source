import { describe, expect, it, vi } from "vitest";

import { patchReviewEmail } from "../patch-review-email";
import type { PatchReviewEmailDeps } from "../patch-review-email";
import type { PlaceReviewRecord } from "@th/types/repos/place-reviews";

// ── Constants ────────────────────────────────────────────────────────────────

const REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-04-13T12:00:00.000Z");
const PLACE_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_TOKEN = "00000000-0000-4000-8000-0000000000aa";

const baseRecord: PlaceReviewRecord = {
  id: REVIEW_ID,
  placeId: "00000000-0000-4000-8000-000000000002",
  humanId: null,
  anonymousName: null,
  anonymousEmail: null,
  payoutCents: null,
  paymentMethod: "GUARANTEE",
  paymentDetail: null,
  venuePromoted: "ACTIVELY_PROMOTED",
  promotionDetail: null,
  soundQuality: "GREAT",
  soundDetail: null,
  stageEquipment: "FULL",
  stageEquipmentDetail: null,
  audienceFit: "PERFECT_FIT",
  audienceDetail: null,
  parkingLoadIn: "DEDICATED_LOT",
  parkingDetail: null,
  bookerRating: "EXCELLENT",
  bookerDetail: null,
  wouldPlayAgain: "YES",
  comment: null,
  genre: null,
  genreTags: [],
  estimatedDraw: null,
  dayOfWeek: null,
  merchAllowed: null,
  merchCutPct: null,
  staffSupport: null,
  photoKeys: [],
  independentVenue: null,
  source: "SURVEY",
  eventId: null,
  responseText: null,
  responseById: null,
  respondedAt: null,
  flagged: false,
  flagReason: null,
  hidden: false,
  createdAt: NOW,
  updatedAt: NOW,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(
  overrides: {
    getById?: PlaceReviewRecord | null;
    session?: { placeId: string; placeReviewId: string | null } | null;
  } = {},
): PatchReviewEmailDeps & { patchEmail: ReturnType<typeof vi.fn> } {
  const patchEmail = vi.fn(async () => undefined);
  const session =
    overrides.session !== undefined
      ? overrides.session
      : { placeId: PLACE_ID, placeReviewId: REVIEW_ID };
  return {
    repos: {
      placeReviews: {
        getById: vi.fn(async () =>
          overrides.getById !== undefined ? overrides.getById : baseRecord,
        ),
        patchEmail,
      },
      placeReviewSessions: {
        getBySessionTokenAndPlace: vi.fn(
          async (token: string, placeId: string) =>
            token === SESSION_TOKEN && session && session.placeId === placeId
              ? { id: "s1", sessionToken: token, ...session }
              : null,
        ),
      },
    } as any,
    patchEmail,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("patchReviewEmail", () => {
  it("patches email on a review with no existing email", async () => {
    const deps = makeDeps();
    const result = await patchReviewEmail(deps, {
      reviewId: REVIEW_ID,
      sessionToken: SESSION_TOKEN,
      email: "musician@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(deps.patchEmail).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      email: "musician@example.com",
    });
  });

  it("no-ops when email is already set (idempotent)", async () => {
    const deps = makeDeps({
      getById: { ...baseRecord, anonymousEmail: "existing@example.com" },
    });
    const result = await patchReviewEmail(deps, {
      reviewId: REVIEW_ID,
      sessionToken: SESSION_TOKEN,
      email: "attacker@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(deps.patchEmail).not.toHaveBeenCalled();
  });

  it("throws not_found for unknown reviewId", async () => {
    const deps = makeDeps({ getById: null });

    await expect(
      patchReviewEmail(deps, {
        reviewId: REVIEW_ID,
        sessionToken: SESSION_TOKEN,
        email: "musician@example.com",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });

  // F16 (2026-09-29): only the session that wrote the review may add an
  // email to it; every mismatch answers like a missing review.
  it("refuses a caller without the review's session token", async () => {
    const deps = makeDeps();

    await expect(
      patchReviewEmail(deps, {
        reviewId: REVIEW_ID,
        sessionToken: "00000000-0000-4000-8000-0000000000bb",
        email: "victim@example.com",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    expect(deps.patchEmail).not.toHaveBeenCalled();
  });

  it("refuses a session bound to a different review", async () => {
    const deps = makeDeps({
      session: {
        placeId: PLACE_ID,
        placeReviewId: "00000000-0000-4000-8000-000000000009",
      },
    });

    await expect(
      patchReviewEmail(deps, {
        reviewId: REVIEW_ID,
        sessionToken: SESSION_TOKEN,
        email: "victim@example.com",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    expect(deps.patchEmail).not.toHaveBeenCalled();
  });

  it("refuses a session that never completed", async () => {
    const deps = makeDeps({
      session: { placeId: PLACE_ID, placeReviewId: null },
    });

    await expect(
      patchReviewEmail(deps, {
        reviewId: REVIEW_ID,
        sessionToken: SESSION_TOKEN,
        email: "victim@example.com",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });

  it("rejects a missing sessionToken (schema)", async () => {
    const deps = makeDeps();

    await expect(
      patchReviewEmail(deps, { reviewId: REVIEW_ID, email: "a@example.com" }),
    ).rejects.toThrow();
    expect(deps.patchEmail).not.toHaveBeenCalled();
  });

  it("rejects invalid email (Zod parse failure)", async () => {
    const deps = makeDeps();

    await expect(
      patchReviewEmail(deps, {
        reviewId: REVIEW_ID,
        sessionToken: SESSION_TOKEN,
        email: "not-an-email",
      }),
    ).rejects.toThrow();
  });

  it("rejects missing reviewId", async () => {
    const deps = makeDeps();

    await expect(
      patchReviewEmail(deps, { email: "test@example.com" }),
    ).rejects.toThrow();
  });
});
