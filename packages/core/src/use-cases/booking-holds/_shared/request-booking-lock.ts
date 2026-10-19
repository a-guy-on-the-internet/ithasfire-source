import type { TxRepos } from "@th/ports/repos";

import { failBookingCancelled, isBookingCancelled } from "./booking-night";

// ── P3b (asks) ───────────────────────────────────────────────────────────────
// The one hold read a booking-THREAD write needs (venue-booking-standards
// v1.1 FR-009b: an ask on a cancelled booking refuses), kept inside
// booking-holds so the hold read scope (NFR-001, read-scope-guard.test.ts)
// does not widen: callers learn "this request's booking was cancelled", never
// a hold row.

/**
 * Take the request's booking lock (the same transaction advisory lock every
 * request-state writer takes first — decline, withdraw, close, Cancel
 * booking, the takes), then refuse with BOOKING_CANCELLED when the request's
 * booking was cancelled. Run inside the caller's transaction, before its
 * re-read of the request.
 */
export async function lockRequestBookingAndAssertNotCancelled(
  tx: TxRepos,
  bookingRequestId: string,
): Promise<void> {
  const holds = tx.bookingHolds;
  await holds.lockRequestBooking(bookingRequestId);
  if (isBookingCancelled(await holds.listForRequest(bookingRequestId))) {
    failBookingCancelled();
  }
}
