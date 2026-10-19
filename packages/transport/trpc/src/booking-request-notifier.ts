import {
  dispatchBookingRequestIntents,
  type BookingRequestNotificationIntent,
} from "@th/core/use-cases/booking-requests";
import { describeError } from "@th/core/lib/io";

import type { Ctx } from "./context";

// ─────────────────────────────────────────────────────────────────────────────
// Post-commit hook for the booking-request notification INTENTS
// (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27).
//
// The event save (`createBookingRequestFromEvent`'s `request.received`)
// returns the notifications it owes as data. This turns them into a
// `dispatchBookingRequestIntents` call
// the same way `venue-confirmation-notifier.ts` composes its dispatcher:
// built from ctx (deps assembly only), fired AFTER the use case has returned
// (the transaction is committed), and swallowed — a notify or mail outage
// must never fail a committed save. Failures are logged and
// reported through `reportError` (ReporterPort convention); a throwing
// reporter is itself guarded.
//
// The intents are SERVER-SIDE ONLY. Every router that fires this returns
// core's `*WireOutputSchema.parse(result)`, which strips them.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingRequestIntentsCarrier = {
  notificationIntents: readonly BookingRequestNotificationIntent[];
};

export type NotifyBookingRequestIntentsArgs = {
  /** The use-case output, read from the LIVE return. */
  output: BookingRequestIntentsCarrier;
  /** Logging context: the row the mutation acted on. */
  context: Record<string, string | null>;
};

export type BookingRequestIntentsNotifier = (
  args: NotifyBookingRequestIntentsArgs,
) => Promise<void>;

export function makeBookingRequestIntentsNotifier(
  ctx: Pick<
    Ctx,
    | "repos"
    | "notify"
    | "notifyWithEmail"
    | "logger"
    | "reportError"
    | "publicAppUrl"
  >,
): BookingRequestIntentsNotifier {
  return async ({ output, context }) => {
    const intents = output.notificationIntents;
    if (intents.length === 0) return;
    try {
      await dispatchBookingRequestIntents(
        {
          repos: ctx.repos,
          // `notifyWithEmail` binds the mailer so the owner's email leg sends
          // inline; plain `notify` (email skips) is the fallback for
          // composition roots that haven't bound it.
          notify: ctx.notifyWithEmail ?? ctx.notify,
          logger: ctx.logger,
          reportError: ctx.reportError ?? undefined,
          publicAppUrl: ctx.publicAppUrl ?? null,
        },
        { intents },
      );
    } catch (err) {
      ctx.logger.error("booking_requests.notify_intents_failed", {
        ...context,
        intentCount: intents.length,
        error: describeError(err),
      });
      try {
        ctx.reportError?.(err, {
          tags: { area: "booking_requests", step: "notify_intents" },
          extra: {
            ...context,
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
