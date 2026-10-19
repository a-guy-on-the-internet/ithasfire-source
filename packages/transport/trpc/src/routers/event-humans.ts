import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  attachEventHuman,
  attachEventHumanInput,
  attachEventHumanOutput,
} from "@th/core/use-cases/event-humans/attach-event-human";
import {
  detachEventHuman,
  detachEventHumanInput,
} from "@th/core/use-cases/event-humans/detach-event-human";
import {
  listEventHumans,
  listEventHumansInput,
  listEventHumansOutput,
} from "@th/core/use-cases/event-humans/list-event-humans";
import {
  listPublicEventHumans,
  listPublicEventHumansInput,
  listPublicEventHumansOutput,
} from "@th/core/use-cases/event-humans/list-public-event-humans";
import {
  reorderEventHumans,
  reorderEventHumansInput,
} from "@th/core/use-cases/event-humans/reorder-event-humans";
import {
  getPerformerShareLinks,
  getPerformerShareLinksInputSchema,
  getPerformerShareLinksOutputSchema,
} from "@th/core/use-cases/event-humans/get-performer-share-links";
import {
  listBookingLineupSuggestions,
  listBookingLineupSuggestionsInputSchema,
  listBookingLineupSuggestionsOutputSchema,
} from "@th/core/use-cases/event-humans/list-booking-lineup-suggestions";

import {
  leaveEventLineup,
  leaveEventLineupInputSchema,
  leaveEventLineupOutputSchema,
} from "@th/core/use-cases/event-humans/leave-event-lineup";
import {
  listMyLineups,
  listMyLineupsInputSchema,
  listMyLineupsOutputSchema,
} from "@th/core/use-cases/event-humans/list-my-lineups";

import { withdrawVolunteerSignup } from "@th/core/use-cases/volunteering";
import {
  declineBookingRequestAct,
  type DeclineBookingRequestActOptions,
} from "@th/core/use-cases/booking-requests/answer-booking-request-act";

import {
  authedProcedure,
  publicProcedure,
  rateLimit,
  verifiedEmailProcedure,
} from "../init";
import { makeLineupNoticeNotifier } from "../lineup-notice-notifier";
import { makeOpenCallNotifier } from "../open-call-notifier";
import { volunteerWithdrawDeps } from "./volunteer";
import { answerActNotices } from "./booking-requests";
import { toTrpcError } from "../utils";

const attachInput = attachEventHumanInput.omit({ actorHumanId: true });
const detachInput = detachEventHumanInput.omit({ actorHumanId: true });
const listInput = listEventHumansInput.omit({ actorHumanId: true });
const reorderInput = reorderEventHumansInput.omit({ actorHumanId: true });
const performerShareLinksInput = getPerformerShareLinksInputSchema.omit({
  actorHumanId: true,
});
const bookingSuggestionsInput = listBookingLineupSuggestionsInputSchema.omit({
  actorHumanId: true,
});

const leaveLineupInput = leaveEventLineupInputSchema.omit({ actorHumanId: true });
// tRPC's useInfiniteQuery injects a top-level `direction`; the use-case
// schema is strict, so allow it here and strip it before forwarding (the
// `community.myRsvps` / `eventSaves.listMine` pattern).
const listMineInput = listMyLineupsInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: z.enum(["forward", "backward"]).optional() });

export const eventHumansRouter = {
  attach: authedProcedure
    .input(attachInput)
    .output(attachEventHumanOutput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        // Community moderators author ownerless listings in the SAME
        // EventBuilder; the use case branches on stewardship to admit them.
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        // Tell a person put on the lineup (now if PUBLISHED, else at publish).
        lineupNotices: makeLineupNoticeNotifier(ctx),
        reportError: ctx.reportError ?? undefined,
        // Per-actor budget on attaching SOMEONE ELSE, charged in the use case
        // so free-text rows and self-attach (which mail nobody) are free.
        rateLimit: ctx.rateLimit,
      } satisfies Parameters<typeof attachEventHuman>[0];

      try {
        return await attachEventHuman(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  detach: authedProcedure
    .input(detachInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        // Community moderators author ownerless listings in the SAME
        // EventBuilder; the use case branches on stewardship to admit them.
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof detachEventHuman>[0];

      try {
        await detachEventHuman(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  list: authedProcedure
    .input(listInput)
    .output(listEventHumansOutput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        // Community moderators author ownerless listings in the SAME
        // EventBuilder; the use case branches on stewardship to admit them.
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventHumans>[0];

      try {
        return await listEventHumans(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * "Suggested from the booking" (lineup-booking-requests v2, FR-006):
   * tagged acts on the originating booking's bill that are not on this
   * event's lineup yet (PENDING or CONFIRMED, never DECLINED). Same editor
   * gate as `attach`; empty for an event with no booking behind it.
   */
  bookingSuggestions: authedProcedure
    .input(bookingSuggestionsInput)
    .output(listBookingLineupSuggestionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        // Community moderators edit ownerless listings' lineups too — the
        // same gate `attach` applies.
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listBookingLineupSuggestions>[0];

      try {
        return await listBookingLineupSuggestions(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  reorder: authedProcedure
    .input(reorderInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        // Community moderators author ownerless listings in the SAME
        // EventBuilder; the use case branches on stewardship to admit them.
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof reorderEventHumans>[0];

      try {
        await reorderEventHumans(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listPublic: publicProcedure
    .input(listPublicEventHumansInput)
    .output(listPublicEventHumansOutput)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPublicEventHumans>[0];

      try {
        return await listPublicEventHumans(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPerformerShareLinks: authedProcedure
    .input(performerShareLinksInput)
    .output(getPerformerShareLinksOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getPerformerShareLinks>[0];

      try {
        return await getPerformerShareLinks(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Self-service: the person on the lineup (owner ruling "option A") ──────

  /**
   * Take YOURSELF off an event's lineup. The input names the event only: the
   * use case finds the caller's own row, so no one can aim this at somebody
   * else's. The event's editors are told. Rate-limited per person on top of
   * the default floor — each call fans out editor notices.
   *
   * Verified email only (B2): a lineup row can be linked BY EMAIL
   * (`events.inviteLineupHumanToRegister`) onto an unverified account someone
   * else opened under that address. It acts on no row until it proves the
   * inbox.
   */
  leave: verifiedEmailProcedure
    .input(leaveLineupInput)
    .output(leaveEventLineupOutputSchema)
    .use(
      rateLimit({
        key: (ctx) => `eventHumans:leave:${ctx.actorHumanId}`,
        maxRequests: 30,
        windowSeconds: 3600,
        message: "leaving lineups",
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        notify: ctx.notifyWithEmail ?? ctx.notify,
        publicAppUrl: ctx.publicAppUrl ?? null,
        reportError: ctx.reportError ?? undefined,
        // A VOLUNTEER row with a signup leaves through the volunteer flow —
        // the SAME deps the `volunteer.signups.withdraw` procedure uses.
        withdrawVolunteerSignup: (withdrawInput: {
          actorHumanId: string;
          signupId: string;
        }) => withdrawVolunteerSignup(volunteerWithdrawDeps(ctx), withdrawInput),
        // A self-leave clears the 7-day re-add cooldown (owner ruling).
        lineupNotices: makeLineupNoticeNotifier(ctx),
        // A tagged act leaving an upcoming booked show's lineup passes on the
        // bill — the SAME deps (sender notice included) as
        // `bookingRequests.passAct`; the use case names who the sender note
        // skips (they get lineup-left instead).
        passBookingRequestAct: (
          passInput: { actorHumanId: string; bookingRequestId: string },
          passOptions: DeclineBookingRequestActOptions,
        ) =>
          declineBookingRequestAct(
            {
              repos: ctx.repos,
              clock: ctx.clock,
              logger: ctx.logger,
              ...answerActNotices(ctx),
            },
            passInput,
            passOptions,
          ),
        // Open calls (FR-017, LAUNCH GATE): leaving the last night of an
        // open-call pick tells the editors ONCE through the dropped-out
        // notice, INSTEAD of lineup-left (owner ruling 2026-10-01).
        notifyOpenCallDroppedOut: makeOpenCallNotifier(ctx).notifyOpenCallDroppedOut,
      } satisfies Parameters<typeof leaveEventLineup>[0];

      try {
        return await leaveEventLineup(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Every lineup the caller is on — drafts included; upcoming, then past.
   * Verified email only (B2, as `leave`): an unverified account sees none of
   * the lineup rows attached to its address.
   */
  listMine: verifiedEmailProcedure
    .input(listMineInput)
    .output(listMyLineupsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listMyLineups>[0];

      try {
        const { direction: _direction, ...rest } = input;
        return await listMyLineups(deps, { ...rest, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type EventHumansRouter = typeof eventHumansRouter;
