import { TRPCError } from "@trpc/server";

import {
  decideInvitePause,
  decideInvitePauseInputSchema,
  decideInvitePauseOutputSchema,
  getInvitePauseStatus,
  getInvitePauseStatusInputSchema,
  invitePauseStatusOutputSchema,
  listInvitePauses,
  listInvitePausesInputSchema,
  listInvitePausesOutputSchema,
  requestInvitePauseReview,
  requestInvitePauseReviewInputSchema,
} from "@th/core/use-cases/events/invites/invite-complaint-pause";

import { rateLimit } from "../guard";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

/**
 * Invite complaint auto-pause (W4), transport side. Thin: parse, call the use
 * case, map the error. Authz lives in the use cases (event edit rights for
 * the organiser; platform staff roles for the queue and decisions).
 *
 * Two routers, mounted in router.ts:
 *  - `invitePauses.*` (this one): the organiser's status + review request,
 *    resolved from one of their events.
 *  - `platform.invitePauses.*` ({@link invitePausesStaffRouter}): mounted
 *    UNDER `platform.*` so it inherits the wholesale staff second-factor
 *    gate (guard.ts), like `platform.ticketPacks.*`.
 */

function requireActor(ctx: { actorHumanId?: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return ctx.actorHumanId;
}

const statusInput = getInvitePauseStatusInputSchema.omit({ actorHumanId: true });
const requestReviewInput = requestInvitePauseReviewInputSchema.omit({
  actorHumanId: true,
});
const listInput = listInvitePausesInputSchema.omit({ actorHumanId: true });
const decideInput = decideInvitePauseInputSchema.omit({ actorHumanId: true });

export const invitePausesRouter = {
  /**
   * Is this event's organiser paused, why, and can they ask for a review?
   * Same bar as sending invites (event edit rights). Never which addresses
   * complained.
   */
  status: authedProcedure
    .input(statusInput)
    .output(invitePauseStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        return await getInvitePauseStatus(
          { repos: ctx.repos },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** "Ask for a review": one waiting request per pause, optional note. */
  requestReview: authedProcedure
    .input(requestReviewInput)
    .use(
      rateLimit({
        key: (ctx) =>
          `invitePauses:requestReview:actor:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 10,
        windowSeconds: 3600,
        message: "asking for an invite review",
      }),
    )
    .output(invitePauseStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        return await requestInvitePauseReview(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export const invitePausesStaffRouter = {
  /** The queue (ADMIN / REVIEWER / SUPPORT). Default: awaiting review. */
  list: authedProcedure
    .input(listInput)
    .output(listInvitePausesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        return await listInvitePauses(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** LIFTED or KEPT (ADMIN / REVIEWER). KEPT needs a note. */
  decide: authedProcedure
    .input(decideInput)
    .output(decideInvitePauseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        return await decideInvitePause(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
