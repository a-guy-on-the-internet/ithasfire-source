import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { HumanRole } from "@th/ports/authz";

import {
  submitPlaceReview,
  submitPlaceReviewInputSchema,
  submitPlaceReviewOutputSchema,
  recalculatePlaceStats,
  recalculatePlaceStatsInputSchema,
  getPlacePublicStats,
  getPlacePublicStatsInputSchema,
  getPlacePublicStatsOutputSchema,
  listPlatformReviews,
  listPlatformReviewsInputSchema,
  listPlatformReviewsOutputSchema,
  respondToPlaceReview,
  respondToPlaceReviewInputSchema,
  respondToPlaceReviewOutputSchema,
  flagPlaceReview,
  flagPlaceReviewInputSchema,
  flagPlaceReviewOutputSchema,
  hidePlaceReview,
  hidePlaceReviewInputSchema,
  hidePlaceReviewOutputSchema,
  unhidePlaceReview,
  unhidePlaceReviewInputSchema,
  unhidePlaceReviewOutputSchema,
  listPlacesForDirectory,
  listPlacesForDirectoryInputSchema,
  listPlacesForDirectoryOutputSchema,
  togglePlaceDirectoryListing,
  togglePlaceDirectoryListingInputSchema,
  togglePlaceDirectoryListingOutputSchema,
  getReviewGlobalStats,
  getReviewGlobalStatsOutputSchema,
  reassignReviewPlace,
  reassignReviewPlaceInputSchema,
  reassignReviewPlaceOutputSchema,
  patchReviewEmail,
  patchReviewEmailInputSchema,
  patchReviewEmailOutputSchema,
  createReviewSession,
  createReviewSessionInputSchema,
  createReviewSessionOutputSchema,
  updateReviewSessionStep,
  updateReviewSessionStepInputSchema,
  updateReviewSessionStepOutputSchema,
  completeReviewSession,
  completeReviewSessionInputSchema,
  completeReviewSessionOutputSchema,
  getTrustedVenuesNearPlace,
  getTrustedVenuesNearPlaceInputSchema,
  getTrustedVenuesNearPlaceOutputSchema,
} from "@th/core";

import { authedProcedure, publicProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

// ---------------------------------------------------------------------------
// Transport-level input schemas (strip actorHumanId — injected from session)
// ---------------------------------------------------------------------------

const respondInput = respondToPlaceReviewInputSchema.omit({
  actorHumanId: true,
});
const flagInput = flagPlaceReviewInputSchema.omit({ actorHumanId: true });
const hideInput = hidePlaceReviewInputSchema.omit({ actorHumanId: true });
const unhideInput = unhidePlaceReviewInputSchema.omit({ actorHumanId: true });
const toggleListingInput = togglePlaceDirectoryListingInputSchema.omit({
  actorHumanId: true,
});
const listPlatformInput = listPlatformReviewsInputSchema.omit({
  actorHumanId: true,
});
const reassignInput = reassignReviewPlaceInputSchema.omit({
  actorHumanId: true,
});

/**
 * Who may trigger a stats recompute by hand. ADMIN only, matching the
 * procedure's "platform admin / cron" contract and the other platform-admin
 * mutations in this router (`hide` / `unhide` / `toggleDirectoryListing`).
 */
const RECALCULATE_STATS_ROLES: HumanRole[] = ["ADMIN"];

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const placeReviewsRouter = {
  // ── Public procedures ───────────────────────────────────────────────

  /** Submit a review (public — no auth required during seed phase). */
  submit: publicProcedure
    .input(submitPlaceReviewInputSchema)
    .use(
      rateLimit<z.infer<typeof submitPlaceReviewInputSchema>>({
        // Bucket on the most identifying field available on the input. Even if
        // an attacker rotates one identifier, the others still bound them.
        key: (_ctx, input) =>
          `place-reviews:submit:${input.placeId ?? input.placeName ?? "?"}:${input.anonymousEmail ?? input.humanId ?? "anon"}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "submitting place reviews",
      }),
    )
    .output(submitPlaceReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await submitPlaceReview(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          input,
        );
        const venueName = input.placeName
          ? `${input.placeName}${input.placeCity ? `, ${input.placeCity}` : ""}`
          : `placeId: ${input.placeId ?? "?"}`;
        void ctx.discordAlert?.({
          title: "📝 New place review submitted",
          colour: "info",
          fields: [
            { name: "Place", value: `\`${venueName}\``, inline: true },
            {
              name: "Would play again?",
              value: `\`${input.wouldPlayAgain}\``,
              inline: true,
            },
            {
              name: "Review ID",
              value: `\`${result.reviewId}\``,
              inline: false,
            },
            ...(result.createdStubPlace
              ? [
                  {
                    name: "Note",
                    value: "New stub place created",
                    inline: false,
                  },
                ]
              : []),
          ],
        });
        if (result.createdStubPlace) {
          const baseUrl = ctx.publicAppUrl ?? "https://ithasfire.com";
          const platformUrl = `${baseUrl}/platform/places?filter=unverified`;
          void ctx.discordAlert?.({
            title: "🏟️ New place submitted — needs review",
            colour: "warning",
            description:
              "A new place was created from a review submission and needs verification.",
            fields: [
              { name: "Place", value: `\`${venueName}\``, inline: true },
              {
                name: "Place ID",
                value: `\`${result.placeId}\``,
                inline: true,
              },
              {
                name: "Review",
                value: `[Open platform places](${platformUrl})`,
                inline: true,
              },
            ],
          });
        }
        return result;
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Get the anonymized public snapshot for a place (snapshot-only, never live). */
  getPublicStats: publicProcedure
    .input(getPlacePublicStatsInputSchema)
    .output(getPlacePublicStatsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getPlacePublicStats(
          {
            repos: ctx.repos,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // NOTE: the former public `list` procedure (individual reviews incl.
  // anonymousName, exact payoutCents, free-text details) was removed per the
  // place-review-anonymization spec's acceptance criterion — no procedure
  // outside the staff path may return anonymousName. Zero consumers existed
  // at removal time (2026-07-14); staff moderation uses `listPlatform`.

  /** List places for the venue autocomplete (public, Meilisearch-backed). */
  listDirectory: publicProcedure
    .input(listPlacesForDirectoryInputSchema)
    .output(listPlacesForDirectoryOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.multiSearch) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Search service not available",
        });
      }
      try {
        return await listPlacesForDirectory(
          {
            search: ctx.multiSearch,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Aggregate stats for the Coming Soon page (public). */
  globalStats: publicProcedure
    .output(getReviewGlobalStatsOutputSchema)
    .query(async ({ ctx }) => {
      try {
        return await getReviewGlobalStats({
          repos: ctx.repos,
          logger: ctx.logger,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Patch the email on an already-submitted review.
   *
   * Auth model: the `reviewId` itself acts as the bearer token. This works
   * because the input schema requires `reviewId` to be a UUID (122 bits of
   * randomness in v4, unguessable in practice) and the ID is shown to the
   * submitter on the post-submit confirmation page. The rate-limit below
   * caps brute-force attempts at the reviewId space; combined with UUIDv4
   * entropy this is the same threat model as a magic link or unsubscribe
   * token.
   */
  patchEmail: publicProcedure
    .input(patchReviewEmailInputSchema)
    .use(
      rateLimit<z.infer<typeof patchReviewEmailInputSchema>>({
        key: (_ctx, input) => `place-reviews:patchEmail:${input.reviewId}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "updating review email",
      }),
    )
    .output(patchReviewEmailOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await patchReviewEmail({ repos: ctx.repos }, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Authed procedures ───────────────────────────────────────────────

  /** Venue owner responds to a review. */
  respond: authedProcedure
    .input(respondInput)
    .output(respondToPlaceReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      try {
        return await respondToPlaceReview(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Flag a review for platform review (any authed user). */
  flag: authedProcedure
    .input(flagInput)
    .output(flagPlaceReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      try {
        return await flagPlaceReview(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Hide a review (platform admin only). */
  hide: authedProcedure
    .input(hideInput)
    .output(hidePlaceReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      try {
        return await hidePlaceReview(
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

  /** Unhide a previously hidden review (platform admin only). */
  unhide: authedProcedure
    .input(unhideInput)
    .output(unhidePlaceReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      try {
        return await unhidePlaceReview(
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

  /** Toggle place directory listing (platform admin only). */
  toggleDirectoryListing: authedProcedure
    .input(toggleListingInput)
    .output(togglePlaceDirectoryListingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      // Reindex is now performed in-process inside the use case via
      // reindexAfterMutation — no HTTP hop to the jobs service required.
      try {
        return await togglePlaceDirectoryListing(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            search: ctx.multiSearch ?? undefined,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Admin / Job procedures ──────────────────────────────────────────

  /** List reviews for platform moderation (staff only). */
  listPlatform: authedProcedure
    .input(listPlatformInput)
    .output(listPlatformReviewsOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      try {
        return await listPlatformReviews(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Reassign a review to a different place (platform staff). */
  reassignPlace: authedProcedure
    .input(reassignInput)
    .output(reassignReviewPlaceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      try {
        return await reassignReviewPlace(
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
   * Trigger stats recalculation (platform admin / cron). The cron path calls
   * the use case directly (`apps/jobs`), with no actor, so the role gate
   * lives HERE rather than in the use case. Without it any signed-in account
   * could force up to 500 place recomputes (each O(events) queries) per call.
   * Same in-transport `hasStaffRole` → FORBIDDEN shape as `platform.ts`.
   */
  recalculateStats: authedProcedure
    .input(recalculatePlaceStatsInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
      }
      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId: ctx.actorHumanId,
        requiredRoles: RECALCULATE_STATS_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }
      try {
        return await recalculatePlaceStats(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Review session tracking ─────────────────────────────────────────────

  createSession: publicProcedure
    .input(createReviewSessionInputSchema)
    .output(createReviewSessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createReviewSession(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateSessionStep: publicProcedure
    .input(updateReviewSessionStepInputSchema)
    .output(updateReviewSessionStepOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateReviewSessionStep(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  completeSession: publicProcedure
    .input(completeReviewSessionInputSchema)
    .output(completeReviewSessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await completeReviewSession(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getTrustedVenuesNearPlace: publicProcedure
    .input(getTrustedVenuesNearPlaceInputSchema)
    .output(getTrustedVenuesNearPlaceOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getTrustedVenuesNearPlace(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
