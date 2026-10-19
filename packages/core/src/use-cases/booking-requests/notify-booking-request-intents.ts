import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../lib/io";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import type {
  BookingRequestNotificationIntent,
  RequestReceivedIntent,
} from "./_shared/booking-request-intents";
import { notifyBookingRequestReceived } from "./notify-booking-request-received";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request notification dispatcher (venue-confirmation-and-booking-
// intents spec, docs/specs/2026-08-27). Mirrors
// `events/notify-venue-confirmation-intents.ts`: the use cases return the
// notifications they OWE as data; this turns them into sends post-commit,
// composed at the transport layer and fired inside a swallow.
//
//   · `request.received` re-enters `notifyBookingRequestReceived` (FR-008)
//     with the request + place re-read here: the event-first create owes the
//     claimed venue exactly the notice a pitch owes it, and that notifier
//     already keys per recipient on the request id. No new copy, no new key.
//
// The venue claim invite (`booking.venue-claim-invite`, mailer-direct) and the
// unparked notice (`booking.requests-unparked`) went with parking (amendment
// 2026-09-25). Neither can be queued anywhere: the invite was rendered and
// mailed in-process here, and notify() renders at call time and stores the
// rendered rows, so nothing re-renders either variant later.
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type DispatchBookingRequestIntentsDeps = {
  repos: Pick<
    Repos,
    "places" | "organizations" | "humans" | "entityPages" | "bookingRequests"
  >;
  notify: NotifyFn;
  logger?: LoggerPort;
  /** Per-send swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
  /** Base web URL for the notifier's deep links. */
  publicAppUrl?: string | null;
};

export type DispatchBookingRequestIntentsArgs = {
  intents: readonly BookingRequestNotificationIntent[];
};

/**
 * Caller-facing hook the transport composes and fires post-commit inside a
 * swallow, once per mutation that returned intents.
 */
export type NotifyBookingRequestIntentsFn = (
  args: DispatchBookingRequestIntentsArgs,
) => Promise<void>;

export async function dispatchBookingRequestIntents(
  deps: DispatchBookingRequestIntentsDeps,
  args: DispatchBookingRequestIntentsArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "dispatchBookingRequestIntents",
  });
  if (args.intents.length === 0) return;

  for (const intent of args.intents) {
    // One kind today. A second kind in the union stops this compiling (the
    // send takes a `RequestReceivedIntent`), so it cannot be dropped silently.
    await sendRequestReceived(deps, logger, intent);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// request.received — the claimed venue's FR-008 notice, through the
// existing notifier
// ─────────────────────────────────────────────────────────────────────────────

async function sendRequestReceived(
  deps: DispatchBookingRequestIntentsDeps,
  logger: LoggerPort | undefined,
  intent: RequestReceivedIntent,
): Promise<void> {
  const context = {
    bookingRequestId: intent.bookingRequestId,
    placeId: intent.placeId,
  };
  try {
    const [bookingRequest, place] = await Promise.all([
      deps.repos.bookingRequests.getById(intent.bookingRequestId),
      deps.repos.places.getById(intent.placeId),
    ]);
    if (!bookingRequest || !place) {
      // The rows committed with the save; a miss here is a deletion between
      // commit and dispatch. Deliberate swallow: error + report, never warn.
      logger?.error("booking_requests.received.row_missing", {
        ...context,
        reason: !bookingRequest ? "request_not_found" : "place_not_found",
      });
      report(deps, new Error("booking_request_received_row_missing"), {
        ...context,
        reason: !bookingRequest ? "request_not_found" : "place_not_found",
      });
      return;
    }
    // Same swallow posture as the pitch's post-commit call: the notifier
    // isolates per-recipient failures itself and reports through the same
    // reporter; only a whole-step failure (no base URL) lands in the catch.
    await notifyBookingRequestReceived(
      {
        repos: deps.repos,
        notify: deps.notify,
        logger: deps.logger,
        reportError: deps.reportError,
        publicAppUrl: deps.publicAppUrl,
      },
      { bookingRequest, place },
    );
  } catch (error) {
    logger?.error("booking_requests.received.send_failed", {
      ...context,
      err: error,
      error: describeError(error),
    });
    report(deps, error, context);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function report(
  deps: DispatchBookingRequestIntentsDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "dispatchBookingRequestIntents" },
      extra,
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never turn a
    // swallowed notify failure into a thrown one.
  }
}
