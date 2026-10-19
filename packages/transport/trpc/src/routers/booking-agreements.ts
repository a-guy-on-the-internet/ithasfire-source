import { TRPCError } from "@trpc/server";

import {
  cancelBookingAgreement,
  cancelBookingAgreementInputSchema,
  cancelBookingAgreementOutputSchema,
  createEventFromAgreement,
  createEventFromAgreementInputSchema,
  createEventFromAgreementWireOutputSchema,
  finalizeBookingAgreement,
  finalizeBookingAgreementInputSchema,
  finalizeBookingAgreementOutputSchema,
  getBookingAgreement,
  getBookingAgreementInputSchema,
  getBookingAgreementOutputSchema,
  listBookingAgreements,
  listBookingAgreementsInputSchema,
  listBookingAgreementsOutputSchema,
  pullBackBookingAgreement,
  pullBackBookingAgreementInputSchema,
  pullBackBookingAgreementOutputSchema,
  removeBookingAgreementLine,
  removeBookingAgreementLineInputSchema,
  removeBookingAgreementLineOutputSchema,
  reopenBookingAgreement,
  reopenBookingAgreementInputSchema,
  reopenBookingAgreementOutputSchema,
  respondToBookingAgreement,
  respondToBookingAgreementBaseSchema,
  respondToBookingAgreementWireOutputSchema,
  sendBookingAgreementForReview,
  sendBookingAgreementForReviewInputSchema,
  sendBookingAgreementForReviewOutputSchema,
  sendBookingTerms,
  sendBookingTermsInputSchema,
  sendBookingTermsOutputSchema,
  updateBookingAgreementHeader,
  updateBookingAgreementHeaderBaseSchema,
  updateBookingAgreementHeaderOutputSchema,
  upsertBookingAgreementLine,
  upsertBookingAgreementLineInputSchema,
  upsertBookingAgreementLineOutputSchema,
} from "@th/core/use-cases/booking-agreements";

import { committedHoldIntentsOf } from "@th/core/use-cases/booking-holds";

import { makeBookingHoldIntentsNotifier } from "../booking-hold-notifier";
import { dealChangeNoticeDeps } from "../deal-change-notice-deps";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

// Per-line payee confirmation already ships as
// `payoutTerms.confirmPayoutLine` (+ `getPayoutLineForAck`) — the editor
// reuses those procedures rather than duplicating them here.

const getInput = getBookingAgreementInputSchema.omit({ actorHumanId: true });
const listInput = listBookingAgreementsInputSchema.omit({
  actorHumanId: true,
});
// Derived from the use cases' pre-refine base objects (`.omit()` can't be
// applied after `.refine()`); the use cases re-validate the refinement rules.
const updateHeaderInput = updateBookingAgreementHeaderBaseSchema.omit({
  actorHumanId: true,
});
const respondInput = respondToBookingAgreementBaseSchema.omit({
  actorHumanId: true,
});
const upsertLineInput = upsertBookingAgreementLineInputSchema.omit({
  actorHumanId: true,
});
const removeLineInput = removeBookingAgreementLineInputSchema.omit({
  actorHumanId: true,
});
const sendForReviewInput = sendBookingAgreementForReviewInputSchema.omit({
  actorHumanId: true,
});
const sendTermsInput = sendBookingTermsInputSchema.omit({
  actorHumanId: true,
});
const pullBackInput = pullBackBookingAgreementInputSchema.omit({
  actorHumanId: true,
});
const reopenInput = reopenBookingAgreementInputSchema.omit({
  actorHumanId: true,
});
const cancelInput = cancelBookingAgreementInputSchema.omit({
  actorHumanId: true,
});
const finalizeInput = finalizeBookingAgreementInputSchema.omit({
  actorHumanId: true,
});
const createEventInput = createEventFromAgreementInputSchema.omit({
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

export const bookingAgreementsRouter = {
  get: authedProcedure
    .input(getInput)
    .output(getBookingAgreementOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        // Context reads (place, payout terms, linked event) are deliberate
        // swallows inside the use case (a degraded field, never a failed
        // read) — reported here.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getBookingAgreement>[0];

      try {
        return await getBookingAgreement(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listMine: authedProcedure
    .input(listInput)
    .output(listBookingAgreementsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listBookingAgreements>[0];

      try {
        return await listBookingAgreements(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateHeader: authedProcedure
    .input(updateHeaderInput)
    .output(updateBookingAgreementHeaderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // A frozen change notifies every payee (freeze-the-deal FR-006).
        ...dealChangeNoticeDeps(ctx),
      } satisfies Parameters<typeof updateBookingAgreementHeader>[0];

      try {
        return await updateBookingAgreementHeader(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  upsertLine: authedProcedure
    .input(upsertLineInput)
    .output(upsertBookingAgreementLineOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // A frozen change notifies every payee (freeze-the-deal FR-006).
        ...dealChangeNoticeDeps(ctx),
      } satisfies Parameters<typeof upsertBookingAgreementLine>[0];

      try {
        return await upsertBookingAgreementLine(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  removeLine: authedProcedure
    .input(removeLineInput)
    .output(removeBookingAgreementLineOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // A frozen change notifies every payee (freeze-the-deal FR-006).
        ...dealChangeNoticeDeps(ctx),
      } satisfies Parameters<typeof removeBookingAgreementLine>[0];

      try {
        return await removeBookingAgreementLine(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  sendForReview: authedProcedure
    .input(sendForReviewInput)
    .output(sendBookingAgreementForReviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        notify: ctx.notify,
        logger: ctx.logger,
        // Swallowed notify failures report through ReporterPort.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof sendBookingAgreementForReview>[0];

      try {
        return await sendBookingAgreementForReview(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The venue's one "Send terms" (booking-the-night FR-003): put the night
   * (and time) on the draft terms and send them, in one call. Composes
   * updateHeader + sendForReview; NIGHT_TAKEN refuses a night another hold
   * is ahead on (venue side — its meta names the hold to challenge).
   */
  sendTerms: authedProcedure
    .input(sendTermsInput)
    .output(sendBookingTermsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        notify: ctx.notify,
        logger: ctx.logger,
        // Swallowed notify / calendar-default reads report through ReporterPort.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof sendBookingTerms>[0];

      try {
        return await sendBookingTerms(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  pullBack: authedProcedure
    .input(pullBackInput)
    .output(pullBackBookingAgreementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof pullBackBookingAgreement>[0];

      try {
        return await pullBackBookingAgreement(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  reopen: authedProcedure
    .input(reopenInput)
    .output(reopenBookingAgreementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        notify: ctx.notify,
        logger: ctx.logger,
        // Swallowed notify failures report through ReporterPort.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof reopenBookingAgreement>[0];

      try {
        return await reopenBookingAgreement(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Accept / decline PROPOSED terms. On request-linked TO_VENUE terms an
   * accept is "Agree & book" (booking-the-night FR-001): it books the night
   * and creates the draft event. The hold notifications that booking owes
   * (lost_date to the acts behind, …) are dispatched here, post-commit and
   * swallowed, and stripped from the wire. NIGHT_NO_LONGER_AVAILABLE carries
   * no meta (`META_FREE_APP_CODES`).
   */
  respond: authedProcedure
    .input(respondInput)
    .output(respondToBookingAgreementWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        notify: ctx.notify,
        logger: ctx.logger,
        // Swallowed notify failures and a failed agree-mint report through
        // ReporterPort.
        reportError: ctx.reportError ?? undefined,
        // The agree-mint runs the standard event save internals.
        idempotency: ctx.idempotency,
        taxRateLookup: ctx.taxRateLookup ?? null,
        publicAppUrl: ctx.publicAppUrl ?? null,
        // W1: a mint by a place manager stamps the venue confirmation.
        authz: ctx.authz,
        // ── P3b (asks) ── the mint copies a "use as the event image" answer.
        storage: ctx.fileStorage,
      } satisfies Parameters<typeof respondToBookingAgreement>[0];

      let result;
      try {
        result = await respondToBookingAgreement(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
      const bookingRequestId = result.notificationIntents[0]?.bookingRequestId;
      if (bookingRequestId) {
        await notifyIntents({ output: result, bookingRequestId, actorHumanId });
      }
      return respondToBookingAgreementWireOutputSchema.parse(result);
    }),

  cancel: authedProcedure
    .input(cancelInput)
    .output(cancelBookingAgreementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        notify: ctx.notify,
        logger: ctx.logger,
        // Swallowed notify failures report through ReporterPort.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof cancelBookingAgreement>[0];

      try {
        return await cancelBookingAgreement(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  finalize: authedProcedure
    .input(finalizeInput)
    .output(finalizeBookingAgreementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Finalizing onto a frozen event is a frozen change (O1): it notifies
        // every payee (freeze-the-deal FR-006).
        ...dealChangeNoticeDeps(ctx),
      } satisfies Parameters<typeof finalizeBookingAgreement>[0];

      try {
        return await finalizeBookingAgreement(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The venue's "Create event". On agreed request-linked terms with no booked
   * night, this BOOKS the night first (booking-the-night NFR-001) — the
   * notices that booking owes are dispatched here, post-commit and
   * swallowed, even when the mint after it fails, and never put on the wire.
   */
  createEventFromAgreement: authedProcedure
    .input(createEventInput)
    .output(createEventFromAgreementWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        taxRateLookup: ctx.taxRateLookup ?? null,
        // Orphan-draft branch reports through the ReporterPort convention.
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
        // Lineup v2 (FR-006): an org sender's SELF row links its public page.
        publicAppUrl: ctx.publicAppUrl ?? null,
        // W1: a mint by a place manager stamps the venue confirmation.
        authz: ctx.authz,
        // ── P3b (asks) ── the mint copies a "use as the event image" answer.
        storage: ctx.fileStorage,
      } satisfies Parameters<typeof createEventFromAgreement>[0];

      let result;
      try {
        result = await createEventFromAgreement(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        const committed = committedHoldIntentsOf(err);
        if (committed) {
          await notifyIntents({
            output: committed,
            bookingRequestId: committed.bookingRequestId,
            actorHumanId,
          });
        }
        throw toTrpcError(err);
      }
      const intents = result.notificationIntents ?? [];
      if (intents.length > 0) {
        await notifyIntents({
          output: {
            notificationIntents: intents,
            staffRecipientHint: result.staffRecipientHint ?? null,
          },
          bookingRequestId: intents[0]!.bookingRequestId,
          actorHumanId,
        });
      }
      return createEventFromAgreementWireOutputSchema.parse(result);
    }),
};
