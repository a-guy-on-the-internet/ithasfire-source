import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { attendeeReviewsRouter } from "../attendee-reviews";
import { createCaller } from "./test-helpers";
import type { Ctx } from "../../context";

// Regression coverage for the community venue-review submit path. The bug this
// guards against: the procedure was wired to `publicProcedure`, whose
// `publicOnly` middleware never resolves `ctx.actorHumanId`, so a signed-in
// submit always fell through to the guest branch and the use case's
// guest-identity guard rejected it with `invalid_input` (HTTP 400). It must be
// `optionalProcedure` — identity resolved when present, still fully open to
// guests. These assertions can only be made at the transport layer, because the
// use-case tests pass `humanId` directly and so never exercise the middleware's
// identity injection.

const PLACE_ID = "00000000-0000-4000-8000-00000000d035";
const REVIEW_ID = "99999999-9999-4999-8999-999999999999";
const SIGNED_IN_HUMAN_ID = "11111111-1111-4111-8111-111111111111";

const activePlace = { id: PLACE_ID, status: "ACTIVE" };

/** Repos mock backing the community-review use case (places + tx + audit). */
const buildRepos = () => {
  const createCommunityReview = vi.fn(async () => ({ id: REVIEW_ID }));
  const auditLog = vi.fn(async () => {});
  const getById = vi.fn(async () => activePlace);

  const tx = vi.fn(async (fn: (txCtx: unknown) => unknown) =>
    fn({
      attendeeReviews: { createCommunityReview },
      audit: { log: auditLog },
    }),
  );

  const repos = {
    places: { getById },
    tx,
  } as unknown as Ctx["repos"];

  return { repos, createCommunityReview, auditLog, getById };
};

/** Ctx overrides that make `optionalAuth` resolve `ctx.actorHumanId` to null. */
const guestCtxOverrides = {
  actorHumanId: null,
  auth: null,
  authToken: null,
  apiKey: null,
} satisfies Partial<Ctx>;

const validInput = {
  placeId: PLACE_ID,
  overallRating: 5,
} as const;

describe("attendeeReviews.submitCommunityVenueReview", () => {
  it("injects the session humanId for a signed-in submitter and succeeds WITHOUT guest name/email", async () => {
    const { repos, createCommunityReview } = buildRepos();
    // Default ctx from the harness is signed in (actorHumanId + auth token set),
    // which `optionalAuth` carries through unchanged.
    const { caller } = createCaller(
      { attendeeReviews: attendeeReviewsRouter },
      { repos, actorHumanId: SIGNED_IN_HUMAN_ID },
    );

    const result =
      await caller.attendeeReviews.submitCommunityVenueReview(validInput);

    expect(result).toEqual({ reviewId: REVIEW_ID });
    expect(createCommunityReview).toHaveBeenCalledTimes(1);
    expect(createCommunityReview).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        humanId: SIGNED_IN_HUMAN_ID,
        anonymousName: null,
        anonymousEmail: null,
      }),
    );
  });

  it("still requires guest name + email when no session is present", async () => {
    const { repos, createCommunityReview } = buildRepos();
    const { caller } = createCaller(
      { attendeeReviews: attendeeReviewsRouter },
      { repos, ...guestCtxOverrides },
    );

    await expect(
      caller.attendeeReviews.submitCommunityVenueReview(validInput),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    } satisfies Partial<TRPCError>);
    expect(createCommunityReview).not.toHaveBeenCalled();
  });

  it("accepts a guest submission that carries name + email", async () => {
    const { repos, createCommunityReview } = buildRepos();
    const { caller } = createCaller(
      { attendeeReviews: attendeeReviewsRouter },
      { repos, ...guestCtxOverrides },
    );

    const result = await caller.attendeeReviews.submitCommunityVenueReview({
      ...validInput,
      anonymousName: "Casey Guest",
      anonymousEmail: "casey@example.com",
    });

    expect(result).toEqual({ reviewId: REVIEW_ID });
    expect(createCommunityReview).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        humanId: null,
        anonymousName: "Casey Guest",
        anonymousEmail: "casey@example.com",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// flagPlaceFeedback: the role bar is deliberately broad (ANY member of an
// owning org may report a review — see the comment block in
// `flag-place-review-feedback.ts`), so the control on moderation-queue spam is
// the pair of rate limits on this procedure. These assertions can only be made
// at the transport layer: the use case never sees a rate limiter.
// ---------------------------------------------------------------------------

const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REVIEW_ID = "88888888-8888-4888-8888-888888888888";
const REVIEW_KEY = `attendee-reviews:flagPlace:review:${REVIEW_ID}:${OWNER_HUMAN_ID}`;
const PLACE_KEY = `attendee-reviews:flagPlace:place:${PLACE_ID}:${OWNER_HUMAN_ID}`;

/**
 * `RateLimitPort.consume` fake that denies exactly the listed keys. The two
 * limits use DISTINCT Redis keys, so denying one at a time proves the windows
 * compose independently rather than one masking the other.
 */
const denyingRateLimit = (deniedKeys: string[] = []) => {
  const consume = vi.fn(async (key: string) =>
    deniedKeys.includes(key)
      ? { allowed: false, remaining: 0, retryAfterSeconds: 7 }
      : {
          allowed: true,
          remaining: Number.POSITIVE_INFINITY,
          retryAfterSeconds: 0,
        },
  );
  return { consume } as unknown as Ctx["rateLimit"] & { consume: typeof consume };
};

/** Repos backing `flagPlaceReviewFeedback` for a DIRECT human owner. */
const buildFlagRepos = () => {
  const setFlagged = vi.fn(async () => {});
  const auditLog = vi.fn(async () => {});
  const repos = {
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        humanIdsWithAccess: [OWNER_HUMAN_ID],
        orgIdsWithAccess: [],
      })),
    },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    attendeeReviews: {
      getById: vi.fn(async (id: string) => ({
        id,
        placeId: PLACE_ID,
        source: "COMMUNITY",
      })),
      setFlagged,
    },
    audit: { log: auditLog },
  } as unknown as Ctx["repos"];

  return { repos, setFlagged, auditLog };
};

describe("attendeeReviews.flagPlaceFeedback rate limiting", () => {
  it("consumes BOTH buckets — per (actor, review) and per (actor, place) — on a permitted report", async () => {
    const { repos, setFlagged } = buildFlagRepos();
    const rateLimit = denyingRateLimit();
    const { caller } = createCaller(
      { attendeeReviews: attendeeReviewsRouter },
      { repos, rateLimit, actorHumanId: OWNER_HUMAN_ID },
    );

    const result = await caller.attendeeReviews.flagPlaceFeedback({
      placeId: PLACE_ID,
      reviewId: REVIEW_ID,
    });

    expect(result).toEqual({ reviewId: REVIEW_ID, flagged: true });
    expect(setFlagged).toHaveBeenCalledTimes(1);
    const keys = (rateLimit as unknown as { consume: ReturnType<typeof vi.fn> })
      .consume.mock.calls.map((call) => call[0] as string);
    expect(keys).toEqual(expect.arrayContaining([REVIEW_KEY, PLACE_KEY]));
  });

  it("rejects with TOO_MANY_REQUESTS when the per-REVIEW window is exhausted, before the write", async () => {
    const { repos, setFlagged, auditLog } = buildFlagRepos();
    const { caller } = createCaller(
      { attendeeReviews: attendeeReviewsRouter },
      {
        repos,
        rateLimit: denyingRateLimit([REVIEW_KEY]),
        actorHumanId: OWNER_HUMAN_ID,
      },
    );

    await expect(
      caller.attendeeReviews.flagPlaceFeedback({
        placeId: PLACE_ID,
        reviewId: REVIEW_ID,
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    } satisfies Partial<TRPCError>);
    // Middleware short-circuits: nothing reaches the moderation queue.
    expect(setFlagged).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("a FRESH reviewId does not escape the per-PLACE ceiling", async () => {
    // The spam shape the place bucket exists for: one member walking every
    // review at the venue, each one a brand-new per-review window.
    const { repos, setFlagged } = buildFlagRepos();
    const { caller } = createCaller(
      { attendeeReviews: attendeeReviewsRouter },
      {
        repos,
        rateLimit: denyingRateLimit([PLACE_KEY]),
        actorHumanId: OWNER_HUMAN_ID,
      },
    );

    await expect(
      caller.attendeeReviews.flagPlaceFeedback({
        placeId: PLACE_ID,
        reviewId: OTHER_REVIEW_ID,
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    } satisfies Partial<TRPCError>);
    expect(setFlagged).not.toHaveBeenCalled();
  });
});
