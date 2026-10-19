import type { IdempotencyPort } from "@th/ports/idempotency";

import {
  tryAcquireOwnedMutex,
  type HeldOrderRefundMutex,
  type OrderRefundMutexDeps,
} from "../../orders/_shared/refund-mutex";

/**
 * Event-level "a cancellation is refunding this event" mutex (owner ruling
 * 2026-10-05: while a refund is in process nothing can happen to the
 * ticket).
 *
 * `cancelEvent` refunds its orders one at a time, releasing each order's
 * `refund-op:` mutex after that order's Stripe calls, and marks them all in
 * ONE transaction at the end. Between an order's release and that commit a
 * ticket move could take the free order mutex and commit. This key closes
 * that window: cancel holds it from before its first order's refund until
 * the marking transaction has committed, and the ticket-move wrapper
 * (`_helpers/with-ticket-refund-lock.ts`) refuses while it is held.
 *
 * Only MOVES consult it. No refund path checks it, so a held (or stranded)
 * key can delay a gift, never a refund.
 *
 * ## Key namespace
 *
 * `cancel-op:${eventId}`. Distinct from cancel's own use-case claim
 * (`event:cancel:${actorHumanId}:${clientKey}`, and the booking entries'
 * keys passed in as `idempotencyKey`) and from `refund-op:${orderId}`; no
 * other key starts with `cancel-op:`. Same composition-root namespace caveat
 * as `refund-op:` (both live in the `api` idempotency namespace).
 *
 * ## TTL: {@link EVENT_CANCEL_MUTEX_TTL_SECONDS} = 3600 s
 *
 * The hold is the whole refund phase plus the marking transaction, which
 * grows with the event's order count (sequential Stripe calls per order: a
 * fee read with up to two backoff waits, any transfer reversals, the
 * refund). Cancel's own claim TTL (300 s) is NOT a bound on it: that claim
 * already outlives nothing on a large event. 3600 s covers roughly
 * 1800–3600 orders at 1–2 s each.
 *
 * What each failure costs:
 *   - A cancel that outruns 3600 s loses the key; moves on its event reopen
 *     for the remainder (the pre-ruling behaviour), and the release reports
 *     `event_cancel_mutex_lock_lost`.
 *   - A crashed cancel leaves the key until it lapses: gifts, invites and
 *     listings on that event are refused for up to an hour. Refunds are
 *     unaffected. A same-key retry can start after the 300 s claim lapses;
 *     it cannot acquire the stale key and proceeds without it (see
 *     `cancelEvent`), while the stale key keeps refusing moves.
 */
export const EVENT_CANCEL_MUTEX_TTL_SECONDS = 3600;

export function buildEventCancelMutexKey(eventId: string): string {
  return `cancel-op:${eventId}`;
}

/** Null when another cancellation of the same event holds the key. */
export function tryAcquireEventCancelMutex(
  deps: OrderRefundMutexDeps,
  eventId: string,
): Promise<HeldOrderRefundMutex | null> {
  return tryAcquireOwnedMutex(
    deps,
    buildEventCancelMutexKey(eventId),
    EVENT_CANCEL_MUTEX_TTL_SECONDS,
    {
      releaseFailed: "event_cancel_mutex_release_failed",
      lockLost: "event_cancel_mutex_lock_lost",
      useCase: "cancelEvent.eventMutex",
      extra: { eventId },
    },
  );
}

/**
 * Read-only: is a cancellation refunding this event right now? Uses
 * `IdempotencyPort.status`, which never claims. Both real adapters
 * implement it (Prisma: a live-row read; Redis: GET). A port without it
 * (test fakes only) reads as "not held".
 */
export async function isEventCancelInProgress(
  idempotency: Pick<IdempotencyPort, "status">,
  eventId: string,
): Promise<boolean> {
  if (!idempotency.status) {
    return false;
  }
  return (
    (await idempotency.status(buildEventCancelMutexKey(eventId))) ===
    "in_progress"
  );
}
