import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { PlaceReviewSessionRecord } from "@th/types/repos/place-review-sessions";

import { completeReviewSession } from "../complete-review-session";
import { createReviewSession } from "../create-review-session";
import { patchReviewEmail } from "../patch-review-email";
import { submitPlaceReview } from "../submit-place-review";

// F16 (2026-09-29): a review is bound to the browser's (token, place)
// session row in the transaction that creates it, and only that binding lets
// the session set the review's email. The token is PERMANENT in the browser's
// localStorage and reused across places and re-reviews, so the binding must
// survive: the same place twice, and A → B → A.

const PLACE_A = "a1000000-0000-4000-8000-00000000000a";
const PLACE_B = "b1000000-0000-4000-8000-00000000000b";
const TOKEN = "c1000000-0000-4000-8000-0000000000cc";
const STRANGER = "d1000000-0000-4000-8000-0000000000dd";

/**
 * In-memory stand-in for the Prisma repos with the real constraints:
 * (sessionToken, placeId) unique, placeReviewId unique.
 */
function makeWorld() {
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, tick++)) };
  const sessions: PlaceReviewSessionRecord[] = [];
  const reviews = new Map<
    string,
    {
      id: string;
      placeId: string;
      anonymousEmail: string | null;
      createdAt: Date;
    }
  >();

  const assertReviewUnbound = (reviewId: string, rowId: string) => {
    if (sessions.some((s) => s.placeReviewId === reviewId && s.id !== rowId)) {
      throw Object.assign(new Error("unique placeReviewId"), { code: "P2002" });
    }
  };

  const placeReviewSessions = {
    upsert: vi.fn(async (input: { sessionToken: string; placeId: string }) => {
      let row = sessions.find(
        (s) =>
          s.sessionToken === input.sessionToken && s.placeId === input.placeId,
      );
      if (!row) {
        row = {
          id: randomUUID(),
          sessionToken: input.sessionToken,
          placeId: input.placeId,
          humanId: null,
          placeReviewId: null,
          completedAt: null,
          createdAt: clock.now(),
        } as PlaceReviewSessionRecord;
        sessions.push(row);
      }
      return row;
    }),
    bindReview: vi.fn(
      async (input: {
        sessionToken: string;
        placeId: string;
        placeReviewId: string;
        completedAt: Date;
      }) => {
        let row = sessions.find(
          (s) =>
            s.sessionToken === input.sessionToken &&
            s.placeId === input.placeId,
        );
        if (!row) {
          row = {
            id: randomUUID(),
            sessionToken: input.sessionToken,
            placeId: input.placeId,
            humanId: null,
            placeReviewId: null,
            completedAt: null,
            createdAt: clock.now(),
          } as PlaceReviewSessionRecord;
          sessions.push(row);
        }
        assertReviewUnbound(input.placeReviewId, row.id);
        row.placeReviewId = input.placeReviewId;
        row.completedAt = input.completedAt;
        return row;
      },
    ),
    getBySessionTokenAndPlace: vi.fn(
      async (token: string, placeId: string) =>
        sessions.find(
          (s) => s.sessionToken === token && s.placeId === placeId,
        ) ?? null,
    ),
    // "Newest by token" — the lookup that broke re-reviews. Present so a
    // regression back to it would be observable, never used by the fix.
    getBySessionToken: vi.fn(
      async (token: string) =>
        [...sessions]
          .filter((s) => s.sessionToken === token)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
        null,
    ),
    complete: vi.fn(),
  };

  const placeReviews = {
    create: vi.fn(
      async (input: { placeId: string; anonymousEmail: string | null }) => {
        const review = {
          id: randomUUID(),
          placeId: input.placeId,
          anonymousEmail: input.anonymousEmail,
          createdAt: clock.now(),
        };
        reviews.set(review.id, review);
        return review;
      },
    ),
    getById: vi.fn(async (id: string) => reviews.get(id) ?? null),
    patchEmail: vi.fn(async (input: { reviewId: string; email: string }) => {
      const r = reviews.get(input.reviewId);
      if (r) r.anonymousEmail = input.email;
    }),
  };

  const places = {
    getById: vi.fn(async (id: string) => ({
      id,
      communityReviewsEnabled: true,
    })),
  };
  const audit = { log: vi.fn(async () => undefined) };

  const txRepos = { placeReviewSessions, placeReviews, places, audit };
  const repos = {
    ...txRepos,
    tx: async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos),
  } as any;

  const review = async (placeId: string, sessionToken = TOKEN) => {
    await createReviewSession({ repos }, { sessionToken, placeId });
    const out = await submitPlaceReview(
      { repos, clock },
      {
        sessionToken,
        placeId,
        paymentMethod: "GUARANTEE",
        venuePromoted: "ACTIVELY_PROMOTED",
        soundQuality: "GREAT",
        stageEquipment: "FULL",
        audienceFit: "PERFECT_FIT",
        wouldPlayAgain: "YES",
        parkingLoadIn: "DEDICATED_LOT",
        bookerRating: "EXCELLENT",
      },
    );
    // The web still fires completeSession; it must not change anything.
    await completeReviewSession(
      { repos },
      { sessionToken, placeReviewId: out.reviewId },
    );
    return out.reviewId;
  };

  const patch = (reviewId: string, sessionToken = TOKEN) =>
    patchReviewEmail(
      { repos },
      { reviewId, sessionToken, email: `${reviewId.slice(0, 8)}@example.com` },
    );

  return { review, patch, reviews, sessions, placeReviewSessions };
}

describe("review ↔ session binding", () => {
  it("binds at submit, so the email capture works for the first review", async () => {
    const w = makeWorld();
    const r1 = await w.review(PLACE_A);
    await expect(w.patch(r1)).resolves.toEqual({ ok: true });
    expect(w.reviews.get(r1)?.anonymousEmail).toMatch(/@example\.com$/);
    expect(w.placeReviewSessions.complete).not.toHaveBeenCalled();
  });

  it("re-reviewing the SAME place: the new review's email capture works", async () => {
    const w = makeWorld();
    const first = await w.review(PLACE_A);
    const second = await w.review(PLACE_A);

    await expect(w.patch(second)).resolves.toEqual({ ok: true });
    // The superseded review can no longer be patched through the session.
    await expect(w.patch(first)).rejects.toMatchObject({
      code: "REVIEW_NOT_FOUND",
    });
    expect(w.sessions).toHaveLength(1);
  });

  it("A → B → A: the latest review of A is patchable, and B's still is", async () => {
    const w = makeWorld();
    await w.review(PLACE_A);
    const b = await w.review(PLACE_B);
    const a2 = await w.review(PLACE_A);

    // "Newest row by token" is B's row here — the old lookup failed this.
    await expect(w.patch(a2)).resolves.toEqual({ ok: true });
    await expect(w.patch(b)).resolves.toEqual({ ok: true });
  });

  it("a stranger's token can neither patch nor claim someone else's review", async () => {
    const w = makeWorld();
    const victim = await w.review(PLACE_A);

    // The stranger opens a session on the same place, then tries to claim
    // the victim's review through completeSession and to patch it.
    await createReviewSession(
      {
        repos: {
          places: { getById: async () => ({ communityReviewsEnabled: true }) },
          placeReviewSessions: w.placeReviewSessions,
        },
      } as any,
      { sessionToken: STRANGER, placeId: PLACE_A },
    );
    await expect(
      completeReviewSession(
        {
          repos: {
            placeReviews: { getById: async () => w.reviews.get(victim) },
            placeReviewSessions: w.placeReviewSessions,
          },
        } as any,
        { sessionToken: STRANGER, placeReviewId: victim },
      ),
    ).resolves.toEqual({ ok: false });
    await expect(w.patch(victim, STRANGER)).rejects.toMatchObject({
      code: "REVIEW_NOT_FOUND",
    });
    expect(w.reviews.get(victim)?.anonymousEmail).toBeNull();
  });
});
