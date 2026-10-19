import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  listModeratorApplications,
  listModeratorApplicationsOutputSchema,
  reviewModeratorApplication,
  reviewModeratorApplicationInputSchema,
  reviewModeratorApplicationOutputSchema,
} from "@th/core/use-cases/community";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const reviewInput = reviewModeratorApplicationInputSchema.omit({
  actorHumanId: true,
});

const listPendingInput = z
  .object({
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    // tRPC's useInfiniteQuery injects a top-level `direction` on every request;
    // `.strict()` would otherwise reject it with BAD_REQUEST (unrecognized_keys)
    // and break the applications queue.
    direction: z.enum(["forward", "backward"]).optional(),
  })
  .strict();

/**
 * Community moderator applications (community-managed-event-listings spec
 * FR-010 — ≈ Wikipedia RfA). Review + queue are platform-ADMIN-only; both
 * use cases enforce ADMIN themselves.
 */
export const moderatorApplicationsRouter = {
  /** ADMIN decision — APPROVE grants COMMUNITY_MODERATOR + audits (in-tx). */
  review: authedProcedure
    .input(reviewInput)
    .output(reviewModeratorApplicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof reviewModeratorApplication>[0];

      try {
        return await reviewModeratorApplication(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PENDING queue for the /moderate/applications admin page; each row carries
   * the applicant's name (or `applicantMissing` for a deleted human).
   */
  list: authedProcedure
    .input(listPendingInput)
    .output(listModeratorApplicationsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listModeratorApplications>[0];

      try {
        return await listModeratorApplications(deps, {
          actorHumanId,
          cursor: input.cursor ?? null,
          limit: input.limit,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
