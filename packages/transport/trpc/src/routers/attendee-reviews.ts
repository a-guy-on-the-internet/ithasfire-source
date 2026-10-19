import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  flagEventFeedback,
  flagEventFeedbackInputSchema,
  flagEventFeedbackOutputSchema,
  flagPlaceReviewFeedback,
  flagPlaceReviewFeedbackInputSchema,
  flagPlaceReviewFeedbackOutputSchema,
  getAttendeeReviewEligibility,
  getAttendeeReviewEligibilityInputSchema,
  getAttendeeReviewEligibilityOutputSchema,
  getPlaceAttendeeFeedback,
  getPlaceAttendeeFeedbackInputSchema,
  getPlaceAttendeeFeedbackOutputSchema,
  getPlaceAttendeeReviewOptions,
  getPlaceAttendeeReviewOptionsInputSchema,
  getPlaceAttendeeReviewOptionsOutputSchema,
  getReviewAggregate,
  getReviewAggregateInputSchema,
  getReviewAggregateOutputSchema,
  hideAttendeeReview,
  hideAttendeeReviewInputSchema,
  hideAttendeeReviewOutputSchema,
  listEventFeedback,
  listEventFeedbackInputSchema,
  listEventFeedbackOutputSchema,
  resolveAttendeeReviewIdentity,
  resolveAttendeeReviewIdentityInputSchema,
  resolveAttendeeReviewIdentityOutputSchema,
  submitAttendeeReview,
  submitAttendeeReviewInputSchema,
  submitAttendeeReviewOutputSchema,
  submitCommunityVenueReview,
  submitCommunityVenueReviewBaseSchema,
  submitCommunityVenueReviewOutputSchema,
} from "@th/core";

import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  verifiedEmailProcedure,
  rateLimit,
} from "../init";
import { toTrpcError } from "../utils";

// ---------------------------------------------------------------------------
// Transport-level input schemas (strip actorHumanId — injected from session)
// ---------------------------------------------------------------------------

const submitInput = submitAttendeeReviewInputSchema.omit({
  actorHumanId: true,
});
const eligibilityInput = getAttendeeReviewEligibilityInputSchema.omit({
  actorHumanId: true,
});
const listFeedbackInput = listEventFeedbackInputSchema.omit({
  actorHumanId: true,
});
const flagFeedbackInput = flagEventFeedbackInputSchema.omit({
  actorHumanId: true,
});
const flagPlaceFeedbackInput = flagPlaceReviewFeedbackInputSchema.omit({
  actorHumanId: true,
});
const hideInput = hideAttendeeReviewInputSchema.omit({ actorHumanId: true });
const resolveIdentityInput = resolveAttendeeReviewIdentityInputSchema.omit({
  actorHumanId: true,
});
// humanId is server-injected from the session (absent for guests); the
// guest-name/email requirement is enforced inside the use case where the
// injected humanId is visible.
const communitySubmitInput = submitCommunityVenueReviewBaseSchema.omit({
  humanId: true,
});
const placeReviewOptionsInput = getPlaceAttendeeReviewOptionsInputSchema.omit({
  viewerHumanId: true,
});
const placeOwnerFeedbackInput = getPlaceAttendeeFeedbackInputSchema.omit({
  actorHumanId: true,
});

// ---------------------------------------------------------------------------
// Router — attendee reviews (attendee-reviews spec).
//   submit / getEligibility  → authed, verified-attendance (FR-001)
//   getAggregate             → PUBLIC, snapshot-only aggregates (FR-005) —
//                              never a per-review rating, text, or identity.
//   listEventFeedback        → owner-scoped private feedback (FR-007)
//   flagFeedback             → owner report action (FR-007/FR-009)
//   staffHide / staffResolveIdentity → platform-staff moderation (FR-009)
// ---------------------------------------------------------------------------

export const attendeeReviewsRouter = {
  /**
   * Submit a verified attendee review. Eligibility (scanned ticket, event
   * ended, 30-day window, no existing review) is fully enforced inside the
   * use case (NFR-002). Rate limit mirrors placeReviews.submit.
   */
  // B2: the scanned ticket that makes someone eligible may have been attached
  // to an unverified account by email, so only a verified account reviews.
  submit: verifiedEmailProcedure
    .input(submitInput)
    .use(
      rateLimit<z.infer<typeof submitInput>>({
        // Bucket per actor per event; requireAuth has already resolved
        // ctx.actorHumanId, so an attacker can't rotate the key.
        key: (ctx, input) =>
          `attendee-reviews:submit:${input.eventId}:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "submitting attendee reviews",
      }),
    )
    .output(submitAttendeeReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await submitAttendeeReview(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PUBLIC, UNVERIFIED, venue-direct COMMUNITY review (FR-009). Fully open —
   * no scanned ticket, no event. The ONLY throttle is the two independent rate
   * limits below (FR-013): a scripted flood is bounded, a single honest review
   * never blocked. humanId is injected from the session when signed in (else
   * guest name/email, enforced in the use case).
   */
  submitCommunityVenueReview: optionalProcedure
    .input(communitySubmitInput)
    .use(
      // (1) Per-place, per-identity limit — mirrors placeReviews.submit. Keyed
      // on the most-identifying field (email → actor → anon), and deliberately
      // WITHOUT the client IP: folding a rotatable, attacker-controlled email
      // into the key would make each new email a fresh bucket, so this limit
      // alone can't bound a scripted flood. The per-IP ceiling below does.
      rateLimit<z.infer<typeof communitySubmitInput>>({
        key: (ctx, input) =>
          `attendee-reviews:community:${input.placeId}:${input.anonymousEmail ?? ctx.actorHumanId ?? "anon"}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "submitting community reviews",
      }),
    )
    .use(
      // (2) Strict per-IP ceiling, independent of any client-supplied field, so
      // one IP rotating emails is still bounded (FR-013). Generous enough that a
      // venue's real attendees sharing an IP each leave a review unblocked, but
      // a script is capped.
      rateLimit<z.infer<typeof communitySubmitInput>>({
        key: (ctx) => `attendee-reviews:community:ip:${ctx.clientIp ?? "noip"}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "submitting community reviews",
      }),
    )
    .output(submitCommunityVenueReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitCommunityVenueReview(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          // Inject humanId only when signed in; guests submit without one.
          ctx.actorHumanId
            ? { ...input, humanId: ctx.actorHumanId }
            : { ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ATTENDEE fork of the rate_venue modal (FR-003): for a signed-in viewer,
   * the events at this place they can leave a VERIFIED review for (the upsell
   * above the always-available community floor). Never errors on an empty list.
   */
  getPlaceReviewOptions: authedProcedure
    .input(placeReviewOptionsInput)
    .output(getPlaceAttendeeReviewOptionsOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await getPlaceAttendeeReviewOptions(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, viewerHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * OWNER-scoped private attendee feedback for a PLACE (FR-006): the exact
   * verified/community aggregate split PLUS the raw unattributed text, source-
   * labelled. Place ownership is enforced inside the use case.
   */
  getPlaceOwnerFeedback: authedProcedure
    .input(placeOwnerFeedbackInput)
    .output(getPlaceAttendeeFeedbackOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await getPlaceAttendeeFeedback(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Structured eligibility for the my-tickets "Rate this show" CTA and the
   * review-form gate. Returns reasons instead of erroring so list surfaces
   * can render per-event states cheaply.
   */
  // B2: same gate as `submit` (my-tickets is gated with it).
  getEligibility: verifiedEmailProcedure
    .input(eligibilityInput)
    .output(getAttendeeReviewEligibilityOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await getAttendeeReviewEligibility(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PUBLIC snapshot-only aggregate for a subject (EVENT | PLACE | OWNER |
   * SERIES). Serves the coarsened, suppression-gated ReviewAggregate snapshot
   * VERBATIM — never a per-review rating, text, or reviewer identity (FR-002),
   * and never live review rows. Fail-closed: null when below threshold /
   * unpublished / corrupt.
   */
  getAggregate: publicProcedure
    .input(getReviewAggregateInputSchema)
    .output(getReviewAggregateOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getReviewAggregate(
          {
            repos: ctx.repos,
            logger: ctx.logger,
            ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * OWNER-scoped private feedback read (admin event "Attendee feedback" tab):
   * the organizer's OWN exact aggregate plus the UNATTRIBUTED comment list.
   * Authz is the event owner's EDIT roles, enforced in the use case (FR-007).
   */
  listEventFeedback: authedProcedure
    .input(listFeedbackInput)
    .output(listEventFeedbackOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await listEventFeedback(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Owner "report abuse" action on a comment — flags the review to the staff
   * moderation queue. Owner-scoped (same gate as listEventFeedback).
   */
  flagFeedback: authedProcedure
    .input(flagFeedbackInput)
    .output(flagEventFeedbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await flagEventFeedback(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLACE-owner "report abuse" action on a community/attendee review (FR-014):
   * flags a review sitting on the owner's venue to the staff moderation queue.
   * Place ownership + same-place enforcement live inside the use case. This is
   * the venue-scoped sibling of `flagFeedback` (which is EVENT-owner-scoped and
   * rejects the null-event COMMUNITY rows).
   *
   * THE ROLE BAR IS DELIBERATELY BROAD — any member of an owning org may
   * report, VIEWER and SCANNER included, because flagging REQUESTS moderation
   * rather than publishing a state and the person who spots an abusive review
   * is often the one on the door. The risk that buys is queue spam, and the
   * control for queue spam is the two rate limits below, not a narrower role.
   *
   * READ THOSE LIMITS AS BEST-EFFORT, NOT AS A GUARANTEE.
   * `consumeRateLimitOrAllow` (`../guard.ts`) FAILS OPEN: if Redis is
   * unreachable it logs, reports, and ALLOWS. That is the right house default
   * — a limiter outage must not take reporting down with it — but it means
   * that while Redis is down this procedure is back to "any org member, as
   * often as they like". Fine for a report button whose worst case is a noisy
   * staff queue; worth knowing before anything with a harder consequence is
   * put behind throughput alone.
   */
  flagPlaceFeedback: authedProcedure
    .input(flagPlaceFeedbackInput)
    .use(
      // (1) Per (actor, review). Flagging is idempotent — the second report of
      // the SAME review writes the same row — so a human needs one click and a
      // retry, never more. 3/min leaves room for a double-submit and a genuine
      // "did that go through?" retry while making a per-review hammer pointless.
      rateLimit<z.infer<typeof flagPlaceFeedbackInput>>({
        key: (ctx, input) =>
          `attendee-reviews:flagPlace:review:${input.reviewId}:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 3,
        windowSeconds: 60,
        message: "reporting reviews",
      }),
    )
    .use(
      // (2) Per (actor, place), over an HOUR — the limit that actually bounds
      // the moderation queue. Limit (1) alone is escapable by walking a fresh
      // reviewId each time, which is exactly the spam shape: one member
      // reporting every review on the venue. 20/hour is far above an honest
      // clean-up sweep after a brigading wave and far below anything that
      // floods staff; a member who hits it can keep going next hour.
      rateLimit<z.infer<typeof flagPlaceFeedbackInput>>({
        key: (ctx, input) =>
          `attendee-reviews:flagPlace:place:${input.placeId}:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "reporting reviews",
      }),
    )
    .output(flagPlaceReviewFeedbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await flagPlaceReviewFeedback(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Hide an attendee review (platform staff only, FR-009). */
  staffHide: authedProcedure
    .input(hideInput)
    .output(hideAttendeeReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await hideAttendeeReview(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Resolve a review's reviewer identity for abuse handling (platform staff
   * only, always audit-logged, FR-002/FR-009).
   */
  staffResolveIdentity: authedProcedure
    .input(resolveIdentityInput)
    .output(resolveAttendeeReviewIdentityOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await resolveAttendeeReviewIdentity(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
