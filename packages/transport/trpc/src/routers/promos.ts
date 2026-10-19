import {
  createPromo,
  createPromoInputSchema,
  createPromoOutputSchema,
  listPromos,
  listPromosInputSchema,
  listPromosOutputSchema,
  previewPromos,
  previewPromosInputSchema,
  previewPromosOutputSchema,
  updatePromo,
  updatePromoInputSchema,
  updatePromoOutputSchema,
  revokePromo,
  revokePromoInputSchema,
  revokePromoOutputSchema,
} from "@th/core/use-cases/promos";

import { authedProcedure, optionalProcedure } from "../init";
import { throttledPublicReadReporter } from "../public-read-reporter";
import { toTrpcError } from "../utils";

const createInput = createPromoInputSchema.omit({ actorHumanId: true });
const listInput = listPromosInputSchema.omit({ actorHumanId: true });
const updateInput = updatePromoInputSchema.omit({ actorHumanId: true });
const revokeInput = revokePromoInputSchema.omit({ actorHumanId: true });
// The buyer identity is SESSION-derived — never accepted from the client.
const previewInput = previewPromosInputSchema.omit({ buyerHumanId: true });

export const promosRouter = {
  create: authedProcedure
    .input(createInput)
    .output(createPromoOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createPromo(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  list: authedProcedure
    .input(listInput)
    .output(listPromosOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listPromos(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  update: authedProcedure
    .input(updateInput)
    .output(updatePromoOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updatePromo(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  revoke: authedProcedure
    .input(revokeInput)
    .output(revokePromoOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokePromo(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // Preview — used by the buyer-facing checkout (manual entry + membership
  // benefits), URL-seed auto-apply (source: "url" restricts to isPublic
  // codes) and the POS door quote. Anonymous callers work exactly as before;
  // a signed-in session is threaded through as `buyerHumanId` (optionalAuth)
  // so `includeMemberBenefits` can resolve the buyer's membership discounts.
  // No order created, no holds taken.
  preview: optionalProcedure
    .input(previewInput)
    .output(previewPromosOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await previewPromos(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            // A public read, fired per cart edit: throttled.
            reportError: throttledPublicReadReporter(ctx.reportError),
          },
          { ...input, buyerHumanId: ctx.actorHumanId ?? null },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
