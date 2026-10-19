/**
 * Shared machinery for giving a cart's seat holds back.
 *
 * Every caller that releases seats from an order's `meta.seatIds` is working
 * from a list that is stale by construction, so they all need the same two
 * things: a lenient way to read the ids out of `meta`, and an ownership fence
 * to decide whether those seats are still this cart's to give away.
 */

/**
 * How long a cart's `meta.holdExpiresAt` runs from the instant it was stamped.
 *
 * Duplicated as a local constant in `create-checkout.ts` and
 * `update-order-items.ts` until this module existed; both now import it,
 * because `resolveSeatHoldFence` INVERTS it (`holdExpiresAt − TTL` recovers
 * the instant the hold was taken) and a drift between writer and reader would
 * silently move the fence.
 */
export const ORDER_HOLD_TTL_SECONDS = 900;

/**
 * Slack added to a cart's own hold instant when fencing its seat release.
 *
 * The fence must sit at or after THIS cart's seat stamp and strictly before
 * any other buyer's. The two stamps this module reasons from — `Order.
 * occurredAt` and the instant recovered from `meta.holdExpiresAt` — are both
 * written in the same transaction as the seat's `updatedAt`, but not by the
 * same clock: `occurredAt` is `@default(now())` (Postgres, evaluated at
 * transaction start) while `Seat.updatedAt` is written from the application
 * clock. Either can land a little ahead of the other. Two bounds keep the gap
 * small:
 *
 *  - `repos.tx` is capped at 30 seconds, so a seat stamped inside the same
 *    transaction cannot be more than 30s past its order's `occurredAt`.
 *  - App and database clocks are NTP-disciplined; a skew anywhere near this
 *    slack would already have broken every TTL in the system.
 *
 * 60s is two transaction budgets. Everything it buys is margin against an
 * under-release (a leak the seat reaper mops up); the theft it must not reach
 * is at least 900s out — `holdSeatsForCheckout` only takes AVAILABLE seats, so
 * another buyer's hold cannot be stamped until the seat-hold TTL has freed
 * ours. That leaves ~840s of headroom.
 *
 * Kept identical to (and now the single source of) the constant the
 * expired-cart reaper fences with.
 */
export const SEAT_FENCE_SLACK_SECONDS = 60;

/**
 * Deliberately lenient twin of `extractSeatIdsFromMeta`
 * (`../checkout-helpers.ts`).
 *
 * That one THROWS `SEAT_IDS_INVALID` / `SEAT_IDS_DUPLICATE` on malformed
 * `meta.seatIds`, which is right at checkout — the buyer sees an error and
 * retries. On a RELEASE path it would abort the transaction, roll back a
 * cancel that was otherwise fine, and leave a cart that can NEVER be retired.
 * So a malformed entry is skipped and every well-formed one is still
 * released. Same filter as the strict version (non-empty strings, deduped),
 * different verdict on the leftovers.
 */
export function collectSeatIds(items: readonly { meta?: unknown }[]): string[] {
  const seatIds = new Set<string>();

  for (const item of items) {
    const meta = item.meta;
    if (!meta || typeof meta !== "object") continue;

    const candidates = (meta as { seatIds?: unknown }).seatIds;
    if (!Array.isArray(candidates)) continue;

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        seatIds.add(candidate);
      }
    }
  }

  return [...seatIds];
}

/** The shape `resolveSeatHoldFence` reads. Loose on purpose — the reaper hands
 * it a projection, the checkout paths hand it a full `OrderRecord`. */
export type SeatHoldFenceSubject = {
  occurredAt?: unknown;
  items: readonly { meta?: unknown }[];
};

/**
 * The `heldBefore` ownership fence for releasing THIS cart's seats.
 *
 * ── Why a time fence at all ────────────────────────────────────────────────
 * `Seat` has no holder column — only `status` and `updatedAt` — so "release
 * the seats this order holds" cannot be expressed as an ownership predicate.
 * `status = "HELD"` is not one either: it proves somebody holds the seat, not
 * that the caller does. And the caller is provably NOT always the holder,
 * because the seat-hold TTL (900s, `tickets/release-expired-holds`) is shorter
 * than the cart TTL (1200s) and shorter than the lifetime of a PENDING cart
 * the buyer is still editing. Once the seat reaper has freed a seat, another
 * buyer can hold and pay for it while the first cart still lists it in
 * `meta.seatIds`. An unfenced release hands that seat back to the pool while
 * its new owner's PaymentIntent is live: sell it twice, mint it once.
 *
 * ── Why the fence is the cart's LAST hold, not its `occurredAt` ────────────
 * `create-checkout` stamps the seats HELD and inserts the order in one
 * transaction, so an untouched cart's seats sit within a transaction's width
 * of `occurredAt`. But `update-order-items` RE-HOLDS on every edit without
 * ever rewriting `occurredAt`, so an edited cart's seats are stamped
 * arbitrarily later. Fencing such a cart at `occurredAt + slack` is not merely
 * a leak: the very next edit re-requests the same seats, the release is
 * declined, they are still HELD, and `holdSeatsForCheckout` refuses the
 * buyer's own cart with `seat_unavailable`. Editing a seated cart twice inside
 * fifteen minutes is an ordinary thing to do.
 *
 * So the fence is the cart's own last hold instant. Both writers stamp
 * `meta.holdExpiresAt = now + ORDER_HOLD_TTL_SECONDS` on every ticket item in
 * the SAME transaction and from the SAME `now` they pass to
 * `holdSeatsForCheckout`, so subtracting the TTL recovers that instant
 * exactly. The maximum across items is taken (`occurredAt` as the floor) so a
 * partially-stamped order still fences on its freshest hold.
 *
 * KEEP THE TWO IN STEP: if `meta.holdExpiresAt` ever stops being written from
 * the same `now` as the seat hold, or the TTL used to write it diverges from
 * `ORDER_HOLD_TTL_SECONDS`, this inversion moves the fence. A LONGER writer
 * TTL is safe (the recovered instant lands early → under-release); a shorter
 * one pushes the fence late, and stays safe only while the writer's TTL
 * exceeds `SEAT_FENCE_SLACK_SECONDS`.
 *
 * ── Why a competing hold is provably outside it ────────────────────────────
 * `holdSeatsForCheckout` only takes AVAILABLE seats, so another buyer's hold
 * on one of our seats cannot be stamped until ours has been released — at
 * least 900s after ours. The fence sits 60s after ours.
 *
 * @returns the `heldBefore` instant, or `null` when the subject carries
 * nothing usable to fence on. Callers MUST treat `null` as "release nothing
 * and report": an ownership-blind release is the double-sell this exists to
 * prevent, and the seat reaper frees the seats anyway.
 */
export function resolveSeatHoldFence(
  subject: SeatHoldFenceSubject,
): Date | null {
  let heldAt: number | null =
    subject.occurredAt instanceof Date &&
    Number.isFinite(subject.occurredAt.getTime())
      ? subject.occurredAt.getTime()
      : null;

  for (const item of subject.items) {
    const meta = item.meta;
    if (!meta || typeof meta !== "object") continue;

    const raw = (meta as { holdExpiresAt?: unknown }).holdExpiresAt;
    if (typeof raw !== "string") continue;

    const expiresAt = Date.parse(raw);
    if (!Number.isFinite(expiresAt)) continue;

    const stampedAt = expiresAt - ORDER_HOLD_TTL_SECONDS * 1000;
    if (heldAt === null || stampedAt > heldAt) heldAt = stampedAt;
  }

  if (heldAt === null) return null;

  return new Date(heldAt + SEAT_FENCE_SLACK_SECONDS * 1000);
}
