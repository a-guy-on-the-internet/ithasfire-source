import { eventEndedAt, type EventTimes } from "./event-ended";

/**
 * Owner ruling 2026-10-07: an org member who may refund a cash sale
 * (`ORG_CASH_REFUND_ROLES`) can until the event ends + 7 days.
 */
export const ORG_CASH_REFUND_WINDOW_DAYS = 7;

const WINDOW_MS = ORG_CASH_REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The org cash refund window: an org member in `ORG_CASH_REFUND_ROLES`
 * (Owner, Admin, Editor, Finance) can refund a door cash sale
 * (`orgRefundCashSale`) until ORG_CASH_REFUND_WINDOW_DAYS after the event
 * ends (`eventEndedAt`: `endsAt ?? startsAt`). The window is closed at
 * the end: at this instant the refund still goes through; after it,
 * CASH_REFUND_WINDOW_CLOSED. Platform staff are not bound by it.
 *
 * One definition shared by every place that must agree on it:
 *  - `orgRefundCashSale` refuses refunds after the close;
 *  - `getOrgOrder` shows the close as `cashRefundableUntil`, so the order
 *    panel offers the refund exactly when the server would accept it.
 */
export function cashRefundWindowClosesAt(event: EventTimes): Date {
  return new Date(eventEndedAt(event).getTime() + WINDOW_MS);
}
