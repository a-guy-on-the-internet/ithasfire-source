import {
  dispatchBookingHoldIntents,
  resolveStaffRecipientOrgId,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "@th/core/use-cases/booking-holds";
import { describeError } from "@th/core/lib/io";

import type { Ctx } from "./context";

// ─────────────────────────────────────────────────────────────────────────────
// Post-commit hook for the booking-hold notification INTENTS
// (booking-holds spec FR-002..FR-010, FR-016).
//
// Every hold transition returns the notifications it owes as data. This turns
// them into `dispatchBookingHoldIntents` calls the same way
// `bookingRequests.respond` composes its notifier: built from ctx (deps
// assembly only), fired AFTER the use case has returned (the transaction is
// committed), and swallowed — a notify outage must never fail a committed
// hold transition. Failures are logged and reported through `reportError`
// (ReporterPort convention); a throwing reporter is itself guarded.
//
// The intents and the routing hint are SERVER-SIDE ONLY. Every router that
// fires this hook returns core's `*WireOutputSchema.parse(result)` — an act
// must never learn who else is in a line (FR-013).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a use-case output may carry: the hold use cases return
 * `notificationIntents` + `staffRecipientHint`; the request-closure paths
 * (withdraw / decline, FR-009) return `holdNotificationIntents` and no hint.
 */
export type HoldIntentsCarrier = {
  notificationIntents?: readonly BookingHoldNotificationIntent[];
  holdNotificationIntents?: readonly BookingHoldNotificationIntent[];
  /** Null on the event paths when nothing was owed (see `makeEventHoldIntentsNotifier`). */
  staffRecipientHint?: BookingHoldStaffRecipientHint | null;
};

export type NotifyHoldIntentsArgs = {
  /** The use-case output, read from the LIVE return — never an idempotency replay. */
  output: HoldIntentsCarrier;
  /**
   * The request the mutation acted on (fallback hint source + dispatcher
   * logging). Null when it acted on a request-less hold
   * (holds-without-a-request): there is no request to resolve a hint from,
   * so the output's own `staffRecipientHint` is the only source, and the
   * dispatcher logs under the first intent's request (every intent names
   * its own).
   */
  bookingRequestId: string | null;
  /** The caller; nominal `placedByHumanId` when a hint has to be resolved. */
  actorHumanId: string;
};

export type BookingHoldIntentsNotifier = (args: NotifyHoldIntentsArgs) => Promise<void>;

function intentsOf(output: HoldIntentsCarrier): readonly BookingHoldNotificationIntent[] {
  return output.notificationIntents ?? output.holdNotificationIntents ?? [];
}

/**
 * FR-016 routing hint for outputs that carry none (withdraw / decline /
 * settle — core returns no hint on those yet): the request's assignee + the
 * venue's owning org, resolved by core's `resolveStaffRecipientOrgId` (the
 * org the ACTOR's access came through, else the first owning org, else null
 * for a human-owned venue). Pure read + projection, so the hook stays
 * deps-assembly only. `placedByHumanId` is nominal — the dispatcher routes
 * STAFF intents from each intent's own `staff` block and never consults the
 * hint's placer.
 */
async function resolveHint(
  repos: Pick<Ctx["repos"], "bookingRequests" | "places" | "authz">,
  bookingRequestId: string | null,
  actorHumanId: string,
): Promise<BookingHoldStaffRecipientHint | null> {
  if (bookingRequestId === null) return null;
  const request = await repos.bookingRequests.getById(bookingRequestId);
  if (!request || request.direction !== "TO_VENUE") return null;
  const place = await repos.places.getById(request.placeId);
  if (!place) return null;
  return {
    assigneeHumanId: request.assigneeHumanId,
    placedByHumanId: actorHumanId,
    orgId: await resolveStaffRecipientOrgId(repos.authz, place, actorHumanId),
    placeId: place.id,
  };
}

export function makeBookingHoldIntentsNotifier(
  ctx: Pick<
    Ctx,
    "repos" | "notify" | "notifyWithEmail" | "logger" | "reportError" | "publicAppUrl"
  >,
): BookingHoldIntentsNotifier {
  return async ({ output, bookingRequestId, actorHumanId }) => {
    const intents = intentsOf(output);
    if (intents.length === 0) return;
    try {
      const hint =
        output.staffRecipientHint ??
        (await resolveHint(ctx.repos, bookingRequestId, actorHumanId));
      if (!hint) {
        throw new Error("booking_hold_notify_hint_unresolvable");
      }
      // `intents` is non-empty (checked above) and every intent names its
      // request, so this is never undefined.
      const logRequestId = bookingRequestId ?? intents[0]!.bookingRequestId;
      await dispatchBookingHoldIntents(
        {
          repos: ctx.repos,
          // `notifyWithEmail` binds the mailer so the act's email leg sends
          // inline; plain `notify` (email skips) is the fallback for
          // composition roots that haven't bound it.
          notify: ctx.notifyWithEmail ?? ctx.notify,
          logger: ctx.logger,
          reportError: ctx.reportError ?? undefined,
          publicAppUrl: ctx.publicAppUrl ?? null,
        },
        { intents, hint, bookingRequestId: logRequestId },
      );
    } catch (err) {
      ctx.logger.error("booking_holds.notify_failed", {
        bookingRequestId,
        intentCount: intents.length,
        error: describeError(err),
      });
      try {
        ctx.reportError?.(err, {
          tags: { area: "booking_holds", step: "notify_intents" },
          extra: {
            bookingRequestId,
            intentCount: intents.length,
            kinds: intents.map((i) => i.kind),
          },
        });
      } catch {
        // A throwing reporter must never turn a swallowed notify failure
        // into a failed mutation.
      }
    }
  };
}

/**
 * Post-commit hook for the EVENT paths that take held dates (FR-018:
 * publish, a published event moved, a published listing gaining dates). The
 * intents there may span several booking requests — one per act in the line
 * — so the request id handed to the dispatcher is the first intent's (used
 * for logging and the hint fallback only; every intent carries its own).
 * Core always supplies the routing hint when it owes anything, so the
 * fallback never runs for these. A no-op when the output carries no intents.
 */
export function makeEventHoldIntentsNotifier(
  ctx: Parameters<typeof makeBookingHoldIntentsNotifier>[0],
): (args: { output: HoldIntentsCarrier; actorHumanId: string }) => Promise<void> {
  const notify = makeBookingHoldIntentsNotifier(ctx);
  return async ({ output, actorHumanId }) => {
    const first = intentsOf(output)[0];
    if (!first) return;
    await notify({ output, bookingRequestId: first.bookingRequestId, actorHumanId });
  };
}
