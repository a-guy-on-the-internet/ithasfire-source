import { TRPCError } from "@trpc/server";

import {
  createBookingTag,
  createBookingTagInputSchema,
  createBookingTagOutputSchema,
  deleteBookingTag,
  deleteBookingTagInputSchema,
  deleteBookingTagOutputSchema,
  listBookingTags,
  listBookingTagsInputSchema,
  listBookingTagsOutputSchema,
  setBookingRequestTags,
  setBookingRequestTagsInputSchema,
  setBookingRequestTagsOutputSchema,
  updateBookingTag,
  updateBookingTagInputSchema,
  updateBookingTagOutputSchema,
} from "@th/core/use-cases/booking-tags";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// bookingTags.* (booking-holds spec FR-017): org-scoped venue-internal labels
// on booking requests. Org settings → Booking manages them; the request's
// inline type-to-create uses `create` + `setForRequest`. Authz (ORG_EDIT_ROLES
// for writes, membership-any for `list`, the request → place → owning-org
// relation for `setForRequest`) lives in the use cases. `actorHumanId` is
// omitted from every client input and taken from ctx.
// ─────────────────────────────────────────────────────────────────────────────

const listInput = listBookingTagsInputSchema.omit({ actorHumanId: true });
const createInput = createBookingTagInputSchema.omit({ actorHumanId: true });
const updateInput = updateBookingTagInputSchema.omit({ actorHumanId: true });
const deleteInput = deleteBookingTagInputSchema.omit({ actorHumanId: true });
const setForRequestInput = setBookingRequestTagsInputSchema.omit({
  actorHumanId: true,
});

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

export const bookingTagsRouter = {
  list: authedProcedure
    .input(listInput)
    .output(listBookingTagsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listBookingTags>[0];

      try {
        return await listBookingTags(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  create: authedProcedure
    .input(createInput)
    .output(createBookingTagOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof createBookingTag>[0];

      try {
        return await createBookingTag(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  update: authedProcedure
    .input(updateInput)
    .output(updateBookingTagOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updateBookingTag>[0];

      try {
        return await updateBookingTag(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Delete detaches from every request (join rows cascade). Idempotent. */
  delete: authedProcedure
    .input(deleteInput)
    .output(deleteBookingTagOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof deleteBookingTag>[0];

      try {
        return await deleteBookingTag(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Replace-all attach on a TO_VENUE request (never visible to the act). */
  setForRequest: authedProcedure
    .input(setForRequestInput)
    .output(setBookingRequestTagsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof setBookingRequestTags>[0];

      try {
        return await setBookingRequestTags(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type BookingTagsRouter = typeof bookingTagsRouter;
