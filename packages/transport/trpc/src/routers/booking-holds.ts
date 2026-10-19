import { TRPCError } from "@trpc/server";

import {
  answerBookingHoldChallenge,
  answerBookingHoldChallengeInputSchema,
  answerBookingHoldChallengeWireOutputSchema,
  bookNightWithoutTerms,
  bookNightWithoutTermsInputSchema,
  bookNightWithoutTermsWireOutputSchema,
  challengeBookingHold,
  challengeBookingHoldInputSchema,
  challengeBookingHoldWireOutputSchema,
  committedHoldIntentsOf,
  confirmBookingHold,
  confirmBookingHoldInputSchema,
  confirmBookingHoldWireOutputSchema,
  extendBookingHoldChallenge,
  extendBookingHoldChallengeInputSchema,
  extendBookingHoldChallengeWireOutputSchema,
  listBookingHoldsForRequest,
  listBookingHoldsForRequestInputSchema,
  listBookingHoldsForRequestOutputSchema,
  listMyBookingHolds,
  listMyBookingHoldsInputSchema,
  listMyBookingHoldsOutputSchema,
  placeBookingHold,
  placeBookingHoldInputSchema,
  placeBookingHoldWireOutputSchema,
  placeBookingHolds,
  placeBookingHoldsInputSchema,
  placeBookingHoldsWireOutputSchema,
  releaseBookingHold,
  releaseBookingHoldInputSchema,
  releaseBookingHoldWireOutputSchema,
  reorderBookingHold,
  reorderBookingHoldInputSchema,
  reorderBookingHoldWireOutputSchema,
  settleBookingHolds,
  settleBookingHoldsInputSchema,
  settleBookingHoldsWireOutputSchema,
  toAnswerBookingHoldChallengeWire,
  toChallengeBookingHoldWire,
  toReleaseBookingHoldWire,
} from "@th/core/use-cases/booking-holds";

import { makeBookingHoldIntentsNotifier } from "../booking-hold-notifier";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// bookingHolds.* (docs/specs/2026-08-25/completed/booking-holds.spec.yaml, transport).
//
// Thin per the transport rule: every gate (ORG_EDIT_ROLES on the owning org
// for staff moves, the request's PERFORMER side for the act's answer), the
// line mechanics, lazy expiry and the ledger all live in the use cases.
// This layer does exactly three things:
//   1. injects `actorHumanId` from ctx (omitted from every client input);
//   2. fires the notification INTENTS post-commit through one swallowed hook
//      (`makeBookingHoldIntentsNotifier` — a notify outage never fails a
//      committed transition);
//   3. strips `notificationIntents` / `staffRecipientHint` from the wire —
//      the `.output()` schemas `.omit()` them, so the client never sees who
//      else is in a line (FR-013: acts see their own position only).
// ─────────────────────────────────────────────────────────────────────────────

// Wire shapes are CORE's `*WireOutputSchema`s (each a projection of the
// internal output with the intents + routing hint stripped; `answer` also
// narrows the hold to the ACT projection, FR-013) — never re-derived here.
const placeInput = placeBookingHoldInputSchema.omit({ actorHumanId: true });
const placeManyInput = placeBookingHoldsInputSchema.omit({ actorHumanId: true });
const reorderInput = reorderBookingHoldInputSchema.omit({ actorHumanId: true });
const challengeInput = challengeBookingHoldInputSchema.omit({ actorHumanId: true });
const extendInput = extendBookingHoldChallengeInputSchema.omit({ actorHumanId: true });
const answerInput = answerBookingHoldChallengeInputSchema.omit({ actorHumanId: true });
const releaseInput = releaseBookingHoldInputSchema.omit({ actorHumanId: true });
const confirmInput = confirmBookingHoldInputSchema.omit({ actorHumanId: true });
const bookWithoutTermsInput = bookNightWithoutTermsInputSchema.omit({
  actorHumanId: true,
});
const listForRequestInput = listBookingHoldsForRequestInputSchema.omit({
  actorHumanId: true,
});
const listForRequesterInput = listMyBookingHoldsInputSchema.omit({
  actorHumanId: true,
});
const settleInput = settleBookingHoldsInputSchema.omit({ actorHumanId: true });

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

/**
 * The request a line-shaped output (reorder) acted on, for the dispatcher's
 * logging: the moved hold's request when the line still holds it, else the
 * first intent's, else the first live hold's.
 */
function primaryRequestOf(output: {
  /** Null on a request-less hold (holds-without-a-request). */
  hold?: { bookingRequestId: string | null };
  line?: readonly { bookingRequestId: string | null }[];
  notificationIntents: readonly { bookingRequestId: string }[];
}): string | null {
  return (
    output.hold?.bookingRequestId ??
    output.notificationIntents[0]?.bookingRequestId ??
    output.line?.find((h) => h.bookingRequestId !== null)?.bookingRequestId ??
    null
  );
}

export const bookingHoldsRouter = {
  /** Staff: enter the line for calendar+date at the last position (FR-002). */
  place: authedProcedure
    .input(placeInput)
    .output(placeBookingHoldWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof placeBookingHold>[0];

      let result;
      try {
        result = await placeBookingHold(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return placeBookingHoldWireOutputSchema.parse(result);
    }),

  /**
   * Staff: enter the line for calendar+date on SEVERAL dates in one action
   * (FR-002, batch). One transaction per date, so PARTIAL SUCCESS is a real
   * outcome — `failed` names the dates that got no hold and why, while the
   * rest stand. The act hears about it once: a digest for 2+ holds, the
   * unchanged single-hold copy for exactly one.
   */
  placeMany: authedProcedure
    .input(placeManyInput)
    .output(placeBookingHoldsWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // The batch degrades instead of throwing once a date is committed;
        // that swallow reports through the ReporterPort convention.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof placeBookingHolds>[0];

      let result;
      try {
        result = await placeBookingHolds(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return placeBookingHoldsWireOutputSchema.parse(result);
    }),

  /** Staff: move a hold within its line; movers are renumbered (FR-003). */
  reorder: authedProcedure
    .input(reorderInput)
    .output(reorderBookingHoldWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof reorderBookingHold>[0];

      let result;
      try {
        result = await reorderBookingHold(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      const primary =
        result.line.find((h) => h.id === input.holdId)?.bookingRequestId ??
        primaryRequestOf(result);
      if (primary) {
        await notifyIntents({ output: result, bookingRequestId: primary, actorHumanId });
      }
      return reorderBookingHoldWireOutputSchema.parse(result);
    }),

  /**
   * Staff: challenge the position-1 hold; starts the keep-or-release clock
   * (FR-004). Needs an act behind it ready to book the night (NO_ACT_READY,
   * booking-the-night N20). `sendTermsToFirstHold` also sends the 1st hold's
   * DRAFT terms after the challenge commits; `termsToFirstHold` says how
   * that went (the challenge stands either way).
   */
  challenge: authedProcedure
    .input(challengeInput)
    .output(challengeBookingHoldWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // "Also send terms": the send's ping to the act, and a send that
        // failed after the challenge committed (a reported swallow).
        notify: ctx.notify,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof challengeBookingHold>[0];

      let result;
      try {
        result = await challengeBookingHold(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: result.hold.bookingRequestId,
        actorHumanId,
      });
      // A booker's reply is the booker view of the hold (H17).
      return toChallengeBookingHoldWire(result);
    }),

  /** Staff: push a live challenge's deadline later (FR-005). */
  extend: authedProcedure
    .input(extendInput)
    .output(extendBookingHoldChallengeWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof extendBookingHoldChallenge>[0];

      let result;
      try {
        result = await extendBookingHoldChallenge(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: result.hold.bookingRequestId,
        actorHumanId,
      });
      return extendBookingHoldChallengeWireOutputSchema.parse(result);
    }),

  /**
   * Act: keep or release a challenged hold (FR-006). Performer side only.
   * Keep = commit (booking-the-night N19 / FR-014): on terms already sent for
   * the night, Keep is "Agree & book" and books it (the agree's ports below,
   * the same bag `bookingAgreements.respond` passes); otherwise it asks the
   * venue for terms and sets the act's new deadline.
   */
  answer: authedProcedure
    .input(answerInput)
    .output(answerBookingHoldChallengeWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        agree: {
          notify: ctx.notify,
          idempotency: ctx.idempotency,
          taxRateLookup: ctx.taxRateLookup ?? null,
          publicAppUrl: ctx.publicAppUrl ?? null,
          authz: ctx.authz,
        },
      } satisfies Parameters<typeof answerBookingHoldChallenge>[0];

      let result;
      try {
        result = await answerBookingHoldChallenge(deps, { ...input, actorHumanId });
      } catch (err) {
        // A keep refused AFTER its decide transaction committed the line's
        // settlement (a lapse it released, the movers): those notices still go
        // out (P2d-2 review nit), then the error maps.
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
      await notifyIntents({
        output: result,
        bookingRequestId: result.hold.bookingRequestId,
        actorHumanId,
      });
      return toAnswerBookingHoldChallengeWire(result);
    }),

  /** Staff: manual release; the line moves up (FR-006 staff side). Idempotent. */
  release: authedProcedure
    .input(releaseInput)
    .output(releaseBookingHoldWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof releaseBookingHold>[0];

      let result;
      try {
        result = await releaseBookingHold(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: result.hold.bookingRequestId,
        actorHumanId,
      });
      // A booker's reply is its own hold in the booker view, no line (H17).
      return toReleaseBookingHoldWire(result);
    }),

  /**
   * RETIRED (booking-the-night N4 / FR-005): every hold hangs off a booking
   * request, and a request's night is booked by agreeing terms
   * (`bookingAgreements.respond`) or by `bookNightWithoutTerms` — this
   * refuses with HOLD_CONFIRM_RETIRED after the venue gate. Kept on the
   * router until the thread UI drops its button (P5).
   */
  confirm: authedProcedure
    .input(confirmInput)
    .output(confirmBookingHoldWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        taxRateLookup: ctx.taxRateLookup ?? null,
        reportError: ctx.reportError ?? undefined,
        // Lineup v2 (FR-006): the org sender's page link on the minted lineup.
        publicAppUrl: ctx.publicAppUrl ?? null,
        // W1: passed through to the mint's save internals.
        authz: ctx.authz,
      } satisfies Parameters<typeof confirmBookingHold>[0];

      let result;
      try {
        result = await confirmBookingHold(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: result.hold.bookingRequestId,
        actorHumanId,
      });
      return confirmBookingHoldWireOutputSchema.parse(result);
    }),

  /**
   * Staff: book a night the pitch asked for, with no agreed terms
   * (booking-the-night N3 / FR-004) — accept-if-open + draft Event (money
   * 100% to its organiser until terms are added) + release siblings and
   * everyone behind. Staff only (never a grantee). DATE_NOT_ASKED_FOR
   * off the pitch's nights, NIGHT_TAKEN when another hold is ahead.
   * Idempotent on the hold id. The sender hears through the existing
   * `booking.hold-confirmed` notice, dispatched post-commit here.
   */
  bookNightWithoutTerms: authedProcedure
    .input(bookWithoutTermsInput)
    .output(bookNightWithoutTermsWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        taxRateLookup: ctx.taxRateLookup ?? null,
        reportError: ctx.reportError ?? undefined,
        // Lineup v2 (FR-006): the org sender's page link on the minted lineup.
        publicAppUrl: ctx.publicAppUrl ?? null,
        // W1: passed through to the mint's save internals.
        authz: ctx.authz,
        // ── P3b (asks) ── the mint copies a "use as the event image" answer.
        storage: ctx.fileStorage,
      } satisfies Parameters<typeof bookNightWithoutTerms>[0];

      let result;
      try {
        result = await bookNightWithoutTerms(deps, { ...input, actorHumanId });
      } catch (err) {
        // The night was booked (committed) before the post-commit mint
        // failed: the notices that booking owes still go out (review W6).
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
      await notifyIntents({
        output: result,
        bookingRequestId: result.hold.bookingRequestId,
        actorHumanId,
      });
      return bookNightWithoutTermsWireOutputSchema.parse(result);
    }),

  /**
   * One request's holds, projected per viewer: `staff` gets every column,
   * `act` gets its own date/position/deadline only (FR-012 / FR-013). The
   * use case enforces the matching read gate for the declared viewer, so a
   * performer asking for `viewer: "staff"` is refused, not widened.
   * Read-only: lapses are PROJECTED (`lapsed: true`), not persisted — call
   * `settle` for write-on-read.
   */
  listForRequest: authedProcedure
    .input(listForRequestInput)
    .output(listBookingHoldsForRequestOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listBookingHoldsForRequest>[0];

      try {
        return await listBookingHoldsForRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Requester side (event-calendar-redesign FR-004): every live or confirmed
   * hold placed by the booking requests the given org/human OWNS, across all
   * venues — the dashboard's hold chips. The use case applies the same gate
   * as `bookingRequests.list`'s performer scopes (self for a human, org
   * membership for an org); the owner pair is the SQL scope, so no caller
   * can receive another requester's line position. Read-only: lapsed rows
   * are dropped, never settled.
   */
  listForRequester: authedProcedure
    .input(listForRequesterInput)
    .output(listMyBookingHoldsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listMyBookingHolds>[0];

      try {
        return await listMyBookingHolds(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff write-on-read (FR-007 / FR-010): persist every lapse on the
   * request's lines and fire the expiry notifications. Idempotent — a second
   * call settles nothing and notifies no one. The inbox/thread reads that
   * want lapses persisted (not just projected) call this alongside their
   * query.
   */
  settle: authedProcedure
    .input(settleInput)
    .output(settleBookingHoldsWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeBookingHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof settleBookingHolds>[0];

      let result;
      try {
        result = await settleBookingHolds(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return settleBookingHoldsWireOutputSchema.parse(result);
    }),
};

export type BookingHoldsRouter = typeof bookingHoldsRouter;
