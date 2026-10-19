import { DateTime } from "luxon";

/**
 * Timezone for all refund calculations: Central Standard Time.
 */
const REFUND_TZ = "America/Chicago";

/**
 * Hours before event start when instant refunds are no longer available.
 * After this cutoff, refunds must be handled by the organizer.
 *
 * Exported so the public event-detail page can render an honest, factual
 * refund-policy disclosure line (calm-honest-ux spec FR-004) without
 * duplicating the cutoff value.
 */
export const INSTANT_REFUND_CUTOFF_HOURS = 4;

/**
 * Result of checking refund eligibility.
 */
export type RefundEligibility =
  | { eligible: true; type: "instant" }
  | { eligible: true; type: "organizer_only" }
  | { eligible: false; reason: "event_started" | "already_paid_out" };

/**
 * Determines whether an order item is eligible for a refund and what type.
 *
 * Refund rules:
 * - Before event: Instant refund available until 4 hours before event start
 * - Within 4 hours of event: Only organizer-initiated refunds allowed
 * - After event starts: No refunds (organizer must handle externally if needed)
 * - After payout: No refunds possible through the platform
 *
 * @param eventStartsAt - When the event starts
 * @param paidOutAt - When the order item was paid out (null if not yet paid)
 * @param now - Current time (defaults to now)
 * @returns RefundEligibility indicating if/how a refund can be processed
 */
export function checkRefundEligibility(
  eventStartsAt: Date,
  paidOutAt: Date | null,
  now: Date = new Date(),
): RefundEligibility {
  // If already paid out, no refunds possible through platform
  if (paidOutAt) {
    return { eligible: false, reason: "already_paid_out" };
  }

  const eventStart = DateTime.fromJSDate(eventStartsAt, { zone: REFUND_TZ });
  const currentTime = DateTime.fromJSDate(now, { zone: REFUND_TZ });
  const cutoffTime = eventStart.minus({ hours: INSTANT_REFUND_CUTOFF_HOURS });

  // After event has started, no refunds
  if (currentTime >= eventStart) {
    return { eligible: false, reason: "event_started" };
  }

  // Within the cutoff window: only organizer can process
  if (currentTime >= cutoffTime) {
    return { eligible: true, type: "organizer_only" };
  }

  // Before cutoff: instant refund available
  return { eligible: true, type: "instant" };
}

/**
 * Returns the instant refund cutoff time for an event.
 * After this time, only organizer-initiated refunds are possible.
 *
 * @param eventStartsAt - When the event starts
 * @returns The cutoff DateTime after which instant refunds are blocked
 */
export function getInstantRefundCutoff(eventStartsAt: Date): Date {
  return DateTime.fromJSDate(eventStartsAt, { zone: REFUND_TZ })
    .minus({ hours: INSTANT_REFUND_CUTOFF_HOURS })
    .toJSDate();
}

/**
 * Checks if instant refunds are currently available for an event.
 *
 * @param eventStartsAt - When the event starts
 * @param now - Current time (defaults to now)
 * @returns true if instant refunds can still be processed
 */
export function isInstantRefundAvailable(
  eventStartsAt: Date,
  now: Date = new Date(),
): boolean {
  const eligibility = checkRefundEligibility(eventStartsAt, null, now);
  return eligibility.eligible && eligibility.type === "instant";
}
