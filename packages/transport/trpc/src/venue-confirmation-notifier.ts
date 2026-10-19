import {
  dispatchVenueConfirmationIntents,
  type VenueConfirmationNotificationIntent,
} from "@th/core/use-cases/events";
import { describeError } from "@th/core/lib/io";

import type { Ctx } from "./context";

// ─────────────────────────────────────────────────────────────────────────────
// Post-commit hook for the venue-confirmation notification INTENTS
// (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27
// "Confirmation lives on the Event").
//
// `confirmVenueEvent` / `withdrawVenueConfirmation` return the notification
// they owe as data. This turns it into a `dispatchVenueConfirmationIntents`
// call the same way `booking-hold-notifier.ts` composes the hold dispatcher:
// built from ctx (deps assembly only), fired AFTER the use case has returned
// (the transaction is committed), and swallowed — a notify outage must never
// fail a committed confirmation transition. Failures are logged and reported
// through `reportError` (ReporterPort convention); a throwing reporter is
// itself guarded.
//
// The intents are SERVER-SIDE ONLY. The router returns core's
// `*WireOutputSchema.parse(result)`, which strips them.
// ─────────────────────────────────────────────────────────────────────────────

export type VenueConfirmationIntentsCarrier = {
  notificationIntents: readonly VenueConfirmationNotificationIntent[];
};

export type NotifyVenueConfirmationIntentsArgs = {
  /** The use-case output, read from the LIVE return. */
  output: VenueConfirmationIntentsCarrier;
  /** The event the mutation acted on (dispatcher logging only). */
  eventId: string;
};

export type VenueConfirmationIntentsNotifier = (
  args: NotifyVenueConfirmationIntentsArgs,
) => Promise<void>;

export function makeVenueConfirmationIntentsNotifier(
  ctx: Pick<
    Ctx,
    "repos" | "notify" | "notifyWithEmail" | "logger" | "reportError" | "publicAppUrl"
  >,
): VenueConfirmationIntentsNotifier {
  return async ({ output, eventId }) => {
    const intents = output.notificationIntents;
    if (intents.length === 0) return;
    try {
      await dispatchVenueConfirmationIntents(
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
      ctx.logger.error("venue_confirmation.notify_failed", {
        eventId,
        intentCount: intents.length,
        error: describeError(err),
      });
      try {
        ctx.reportError?.(err, {
          tags: { area: "venue_confirmation", step: "notify_intents" },
          extra: {
            eventId,
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
