import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  saveEvent,
  saveEventInputSchema,
  saveEventOutputSchema,
  unsaveEvent,
  unsaveEventInputSchema,
  unsaveEventOutputSchema,
  listSavedEvents,
  listSavedEventsInputSchema,
  listSavedEventsOutputSchema,
  getSavedState,
  getSavedStateInputSchema,
  getSavedStateOutputSchema,
} from "@th/core/use-cases/event-saves";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const saveEventInput = saveEventInputSchema.omit({ actorHumanId: true });
const unsaveEventInput = unsaveEventInputSchema.omit({ actorHumanId: true });
// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" | "backward")
// on every request. listSavedEventsInputSchema is `.strict()`, and Zod's `.omit()`
// PRESERVES that strictness, so without allowing `direction` the whole call 400s
// (unrecognized_keys) — breaking the /saved watchlist. Allow it here; the handler
// strips it before the use case (which re-validates with the strict base schema).
const listSavedEventsInput = listSavedEventsInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: z.enum(["forward", "backward"]).optional() });
const getSavedStateInput = getSavedStateInputSchema.omit({
  actorHumanId: true,
});

const addActor = <T extends Record<string, unknown>>(
  input: T,
  actorHumanId: string,
) => ({
  ...input,
  actorHumanId,
});

/**
 * Saved-events watchlist. ALL procedures are authed — saves are private
 * (spec FR-003): no public counts, no visibility of who saved what.
 */
export const eventSavesRouter = {
  save: authedProcedure
    .input(saveEventInput)
    .output(saveEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await saveEvent(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  unsave: authedProcedure
    .input(unsaveEventInput)
    .output(unsaveEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await unsaveEvent(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listMine: authedProcedure
    .input(listSavedEventsInput)
    .output(listSavedEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        // Drop the tRPC-injected `direction` before forwarding: the use case
        // re-validates against the strict listSavedEventsInputSchema, which has
        // no `direction` field and would reject it a second time.
        const { direction: _direction, ...rest } = input;
        return await listSavedEvents(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          addActor(rest, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  savedState: authedProcedure
    .input(getSavedStateInput)
    .output(getSavedStateOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await getSavedState(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
