import { RESALE_CLAIM_WINDOW_DAYS } from "@th/types/repos/resale-listings";

/**
 * The resale claim window: a resale buyer can file a claim (`create-claim`)
 * until RESALE_CLAIM_WINDOW_DAYS after the event ends (`endsAt ?? startsAt`).
 * The window is half-open: claims are accepted while `now < close`, and a
 * RESALE credit becomes payable at `asOf >= close`, so no instant is both.
 *
 * One definition shared by every place that must agree on it:
 *  - `create-claim` refuses claims at or after the close;
 *  - `computeResaleSchedule` never snapshots a payout release earlier than
 *    the close;
 *  - `createCreditsFromOrder` never matures a RESALE order's credits (the
 *    seller's included) before the close;
 *  - the payee-ledger adapter's payable SQL re-checks the close against the
 *    event's CURRENT end time (the constant lives in `@th/types` so the
 *    adapter imports the same number).
 *
 * If these drift, the seller can be paid before the buyer can complain, and an
 * approved claim then needs a Stripe transfer reversal instead of a plain
 * ledger debit.
 */
export { RESALE_CLAIM_WINDOW_DAYS };

const DAY_MS = 24 * 60 * 60 * 1000;

export function resaleClaimWindowClosesAt(event: {
  startsAt: Date;
  endsAt?: Date | null;
}): Date {
  const eventEnd = event.endsAt ?? event.startsAt;
  return new Date(eventEnd.getTime() + RESALE_CLAIM_WINDOW_DAYS * DAY_MS);
}
