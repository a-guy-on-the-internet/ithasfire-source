# Decision Record: createCheckout calls Stripe outside its transactions

**Status:** accepted (2026-10-03); extended to `createResaleCheckout`
(2026-10-04, see "Resale checkout" below) and to `claimFreeTickets`
(2026-10-04, see "Free claims")

## Context

`createCheckout` used to create the buyer's PaymentIntent, and settle a
superseded cart's PaymentIntent, inside its main `repos.tx`. The Stripe client
is `timeout: 60_000, maxNetworkRetries: 1`, so one call can take 120 s and a
settle (cancel + retrieve) 240 s. The transaction budget is 30 s
(`DEFAULT_TX_TIMEOUT_MS`) and the pool holds 10 connections. A slow Stripe
response held row locks and a pooled connection for the whole call. When the
transaction then timed out, it rolled back the order while the PaymentIntent
it had just created stayed live.

## Decision

The paid path runs Stripe with no transaction open. The steps are:

1. **Settle before the transaction.** First re-check the event-level
   refusals (on sale, buyer has access, waiver accepted) without a
   transaction, so a checkout that will be refused never cancels the other
   tab's live PaymentIntent. Then settle the superseded cart's PaymentIntent
   (`settleCarriedOverCartPaymentIntent`). The main transaction retires
   that cart only with a CAS on the PaymentIntent id it saw. If another tab
   linked a new PaymentIntent in the meantime, the transaction throws, rolls
   back and settles again (two attempts).
2. **Main transaction.** Holds seats, credit, fee waivers and promos and
   writes the PENDING order with no PaymentIntent. It returns the
   PaymentIntent request.
3. **Create the PaymentIntent** outside any transaction, keyed
   `pi:<checkoutKey>:<orderId>`. Stripe idempotency keys are bound to the
   request parameters. The order id is in the key, so a retry that writes a
   new order gets a new key instead of an `idempotency_error`.
4. **Link transaction.** `linkPaymentIntentIfPending` is a CAS on
   `PENDING ∧ (PI IS NULL ∨ PI = p)`. The `pending_created` and `order.terms_accepted`
   audits are written in the same transaction. The client secret goes back to
   the buyer only after the link wins.
5. **Unwind on failure.** If PaymentIntent creation or the link fails, cancel
   the PaymentIntent, then run one transaction that cancels the order (CAS) and
   releases its holds. It writes `pending_abandoned` with reason
   `payment_intent_not_linked` or `link_lost`.

This departs from "Mutations run exactly one `repos.tx()`"
(`docs/engineering-standards.md` §4.2). That rule protects atomicity. Here the
network call has to sit between two writes, and one transaction can only keep
them together by holding locks across the call. The order is still created and
the PaymentIntent still linked atomically, each in its own transaction. Each
audit row is written in the transaction that makes the change it records.

## What keeps the gap safe

Between step 2 and step 4, other code can see a PENDING order with no
PaymentIntent.

- Cancellers (cart retire, `releaseCartHold`, the expired-cart reaper, the
  `payment_failed` webhook) cancel with `expectedPaymentIntentId`, the
  PaymentIntent they settled. A link that lands first makes their CAS match
  nothing, and a cancel that lands first makes the link match nothing. The
  real-Postgres test is
  `packages/adapters/src/db/prisma/__tests__/orders-link-cancel-cas.integration.test.ts`.
- Linkers that work from metadata (finalize, the `payment_intent.processing`
  webhook, the client confirm) use the same CAS. `markSucceededIfOpen` and
  `markProcessingIfPending` guard their status changes. If a CAS loses, the
  code re-reads the order:
  - Another path for the SAME payment already advanced it (SUCCEEDED, or
    PROCESSING for the processing step, linked to this PaymentIntent). That
    is an idempotent replay. The client confirm and the succeeded webhook use
    different idempotency keys, so two finalizers can race; the loser mints
    nothing and does not throw.
  - Anything else (CANCELLED, or a different PaymentIntent) throws. The
    webhook sends it to the DLQ; the client confirm returns the error. A
    cancelled order is never brought back.

  The buyer has no client secret until step 4 wins, so this guard is a second
  line of defence. Finalize checks for an already-SUCCEEDED order before the
  link CAS, so a re-delivered event for a SUCCEEDED order with no linked
  PaymentIntent replays instead of losing the CAS.
- `update-order-items` treats an order as in checkout once
  `termsAcceptedAt` is set, not only once a PaymentIntent is set.
- The idempotency lock TTL is 900 s. That covers the worst case: two settles,
  three transactions, PaymentIntent creation, the link and the unwind. The
  arithmetic is in `create-checkout.ts`. A failed attempt releases its claim
  with an owner-checked `release` (`abandonClaim`), not `idempotency.fail`:
  both adapters keep a `failed` record for 15 minutes that refuses `begin`,
  which would lock the buyer's retry out. `fail` is kept only for
  deterministic `invalid_input` rejections, whose registered code makes the
  client rotate. A request that dies mid-flight (SIGTERM or OOM during a
  Stripe call), or whose result cannot be stored, leaves the lock for the
  full 900 s. The web checkout and the embed keep the client key
  after a failure with no server code and after `IDEMPOTENCY_LOCK_IN_PROGRESS`,
  and rotate it after any other server refusal
  (`apps/web/src/lib/checkout-client-key.ts`). Keeping it means a lost
  response is recovered by replaying the stored result; a fresh key would
  price a second order that collides with the first one's seat, credit and
  capacity holds until the reaper frees them. Mobile does not call
  `createCheckout` yet.

## Residual windows

- The event-level re-check in step 1 runs before the settle, and the main
  transaction checks again after it. If sales close or the event is
  unpublished during the settle itself (up to 240 s on a slow Stripe), the
  other tab's PaymentIntent is cancelled and this checkout is still refused.
  Before this change the check and the retire ran in one transaction.
  Per-ticket-type sales windows and capacity are checked by the shared-prep
  transaction and again inside the main one, not in the step-1 re-check.
- A request that dies mid-flight (SIGTERM, OOM) never releases its lock, so
  the buyer's retries under the kept key answer `IDEMPOTENCY_LOCK_IN_PROGRESS`
  for up to 900 s unless they reload (a reload mints a new key).
- Legacy SUCCEEDED orders with no linked PaymentIntent (only possible from the
  old unconditional link swallowing a P2002) are no longer backfilled by a
  redelivered `payment_intent.succeeded`; finalize replays them as they are.

## Resale checkout

`createResaleCheckout` follows the same steps, with these differences.

- **No settle step.** A resale checkout does not carry over a cart.
- **Main transaction.** Takes the listing hold (`ListingHold` row, listing
  HELD) and writes the PENDING order with no PaymentIntent, as before.
- **PaymentIntent key** `pi:<checkoutKey>:<orderId>` (`checkoutKey` is
  `resale-checkout:<actor>:<clientKey>`). It used to be
  per client key, so a retry that wrote a new order got `idempotency_error`.
- **Link transaction.** `linkPaymentIntentIfPending`, then
  `resaleListings.lockHold(listing, { buyerHumanId, heldUntil })`: the
  ticket row lock (`FOR NO KEY UPDATE`), a HELD-conditional UPDATE that takes
  the listing row lock, then a check that the hold is still this attempt's.
  Under those locks it re-reads the ticket and the seller's original item
  and refuses a pass that is no longer LISTED (`lostTo: ticket_not_listed`)
  or an item that is refunded (`lostTo: original_item_refunded`), the two
  facts finalize guards: the checkout transaction read both with no lock,
  so a refund can land between that read and the link. `cancelEvent`'s
  `cancelOpenForEvent` can cancel the listing and drop its hold in the same
  gap. If any check fails, the transaction throws, so the link rolls back,
  the checkout fails `ORDER_NOT_PENDING` as for any lost link, and the
  unwind's `releaseHold` closes a refunded pass's listing CANCELLED. Lock
  order: order row, ticket row, listing row, the order finalize and every
  PENDING canceller take them in. `cancelOpenForEvent` (tickets, listings),
  the refund reconcile (ticket, item, listing) and the stale-hold sweep
  (ticket, listing) take no row of the buyer's order, so each blocks
  against the link and never deadlocks with it. The reconcile's
  full-refund arm flips only the seller's item and never touches a LISTED
  ticket: the link sees it only if it committed before the item read;
  otherwise it lands after the link and is the "refund after the secret is
  out" window below. The `resale_checkout_created` and
  `order.terms_accepted` audits are written here.
- **Unwind.** Cancel the PaymentIntent; on "already terminal", read it
  back. It counts as dead only on a confirmed cancel or a `canceled` status.
  Then one transaction:
  - PI dead (or never created): cancel the order with
    `expectedPaymentIntentId` set to our PI, or to null (the two states this
    attempt can have left it in).
  - PI not confirmed dead: cancel only with `expectedPaymentIntentId: null`.
    An order that carries the live PI (the link committed but its response
    was lost) stays PENDING with its hold, for the expired-cart reaper, and
    the case is reported (`unwind_pi_cancel_unconfirmed`).
  - Release the hold with the fenced `resaleListings.releaseHold` (deletes
    the hold only if buyer and `heldUntil` still match, then HELD → ACTIVE),
    but only when the order is CANCELLED (by this cancel, or by someone else,
    read back) and the PI is dead or the order carries none. Every other
    canceller releases the hold in its own cancel transaction (below), so
    after someone else's cancel this release normally finds nothing; it is
    fenced and idempotent.
  - Write `pending_abandoned`.
  A failed checkout puts the listing straight back on sale, except in the
  left-for-the-reaper case above. When the PI cancel is unconfirmed and the
  order never got the PI, the order is cancelled and the listing released
  while a live, unlinked PI carrying the old order id may still exist. It
  cannot be charged: it was created with no payment method and its client
  secret was never returned, and if it were paid, finalize refuses a
  CANCELLED order (`ORDER_NOT_PROCESSABLE`) and the event goes to the DLQ,
  so no ticket moves. Do not narrow the order cancel to "expect our PI
  only": that leaves every "PI created, link never committed" order PENDING
  with a held listing.
- **Lock TTL** 900 s, the same as createCheckout. The resale worst case is
  about 340 s (arithmetic in `create-resale-checkout.ts`). The claim is
  released with `abandonClaim` on failure; a `commit` that throws keeps it.
- **Hold.** `resaleListings.hold` is a CAS on ACTIVE → HELD taken before
  the hold row is written, so a listing an event cancel just closed is never
  written back to HELD.
- **Client key** is bounded at 128 characters (here and in createCheckout):
  the Stripe key is built from it, and Stripe caps keys at 255.
- **Stranded orders on event cancel.** `settleStrandedResaleOrders` now
  cancels with `expectedPaymentIntentId` (the PI it settled), like the other
  cancellers.
- **Expired hold at the link.** The link transaction also refuses a hold
  whose `heldUntil` has passed (`lostTo: listing_hold_expired`), and unwinds
  like any lost link. The hold is clamped to the sale cutoff, so without
  this a slow Stripe call near the cutoff hands out a payable client secret
  after sales closed. It adds no lock, and it is not what keeps the
  stale-hold sweep off a linking order (that is the live-order check below).

## Free claims

`claimFreeTickets` (createCheckout's free route, and an exported use case)
supersedes a carried-over cart the same way step 1 does, through the same
code (`orders/_shared/settle-carried-over-cart-before-tx.ts`, which
createCheckout now uses too).

- **Before the transaction.** Read the cart (buyer + event + PENDING), re-run
  the event-level refusals (on sale, RSVP, access, delegate claiming the
  principal's tier), then settle the PI. createCheckout's free route settles
  nothing itself, so the cart is settled once per attempt.
- **Transaction.** Re-read the cart, and retire it with the cancel CAS on the
  observed PI (`releaseRetiredCartHolds`, so a resale cart's listing hold is
  released with the cancel), only if the settle proved the PI dead. A cart
  that gained a different PI rolls back and is settled again (two attempts;
  the last leaves the cart live and reports
  `carried_over_cart_changed_after_final_settle`). An un-retired cart keeps
  its seats and counts against the capacity gate, as before.
- **Rollback.** A throw in the transaction leaves the cart PENDING with a
  cancelled PI, the state the in-transaction cancel also left. The refusals
  that come after the event-level ones (ORDER_NOT_FREE, promo, sales
  window, capacity, seats) used to run before the cancel for some of them;
  they now run after it. A cancelled PI cannot charge, so this is the safe
  direction; the buyer's other tab, if it was about to pay with that PI, has
  to start a new checkout.
- **Lock TTL.** createCheckout's 900 s covers the free route:
  30 + 2 × (240 + 30) = 570 s.

## Listing holds of cancelled resale orders (G1)

A resale order holds its listing (HELD plus a `ListingHold` row) until
finalize sells it. Two mechanisms give the listing back when the order dies,
and both go through one primitive, `resaleListings.releaseHold`.

- **Where a released listing goes.** `releaseHold` deletes the hold only if
  buyer and `heldUntil` still match, then moves the listing out of HELD to
  the status it can still have, and returns which:
  - ticket no longer LISTED (a refund voided it), or the seller's original
    item refunded → CANCELLED, ticket left as it is, every order item's
    `resaleListingId` pointer cleared (as `cancelOpenForEvent`);
  - event CANCELLED (a listing held before `cancelOpenForEvent` existed) →
    CANCELLED, ticket LISTED → VALID, pointers cleared (as
    `cancelOpenForEvent`);
  - `expiresAt` at or before now → EXPIRED (checkout uses the same
    boundary), ticket LISTED → VALID, the seller item's
    pointer cleared (as `expireStale`), in the release transaction, so no
    buyer can hold an expired listing in an ACTIVE window before the
    hourly expiry;
  - otherwise → ACTIVE.
  Locks: the ticket row first (`FOR NO KEY UPDATE`), then the listing row,
  then the hold row, then order items (the closing branches' pointer
  writes). `commit` and `cancelOpenForEvent` take the ticket before the
  listing too; the refund reconcile's partial arm voids the ticket, then
  flips the seller's item, then closes the listing. All of them take the
  ticket first, so every check above runs with a reconcile or event cancel
  either committed before it or waiting for it. The event row is only read.
  Two writers used to break this and now do not:
  - `expireStale` wrote listings before tickets; it now locks the tickets
    first.
  - The reconcile flipped the item before voiding the ticket (item, ticket,
    listing), a 40P01 cycle against `releaseHold`'s closing branches and
    `expireStale` (ticket, listing, item). It now voids the ticket first.
    The integration test replays the old order and observes the deadlock.
  One cycle remains, needing an already-inconsistent state: a VALID (not
  LISTED) ticket still under an open listing whose seller's item points at
  it. The reconcile's full-refund arm flips that item and then voids the
  VALID ticket (item, ticket), while `expireStale` or `releaseHold`'s
  closing branch hold the ticket and write the item pointer (ticket, item).
  Postgres aborts one side (40P01): a reconcile victim goes to the DLQ for
  operator replay, a sweep victim is retried next hour; no money moves
  wrongly. Fix if it is ever seen: lock the order's tickets (sorted by id)
  before the full-refund arm flips items.
- **The canceller releases it.** `releaseRetiredCartHolds`, which every
  PENDING/PROCESSING canceller that can meet a resale order goes through (the
  cart reaper, `releaseCartHold`, the `payment_failed` webhook, finalize's
  sibling retire, a checkout's carried-over cart, the event cancel's
  stranded-resale settle), reads the order back after its cancel CAS matched
  and calls `releaseResaleListingHoldsForOrder`: `releaseHold` per resale
  item, fenced on the buyer and the item's `meta.holdExpiresAt` (the same
  `Date` the checkout passed to `hold`). Same transaction as the cancel; lock
  order: order row, ticket row, listing row (finalize's order). A lost CAS
  releases nothing. A listing closed instead of put on sale is logged with
  its reason; the checkout's own unwind records it on `pending_abandoned`
  (`listingReleasedTo`, `listingCloseReason`). Finalize's sibling retire
  used to run its cancel and releases as separate autocommits on the root
  repos; it now settles the PI with no transaction open, then opens one
  transaction per sibling.
- **The hourly sweep is the backstop.** `expireResaleListings` first
  releases holds whose `heldUntil` is more than 3600 s past, where every
  order that took THIS hold is CANCELLED: the buyer's orders for the listing
  (item column or `meta` copy) whose item `meta.holdExpiresAt` equals the
  hold's `heldUntil`. An earlier purchase of the same listing by the same
  buyer (refunded, the listing relisted) is not counted; an order with no
  readable `holdExpiresAt` is (the keep direction). Per listing, in one
  transaction: `lockHold` (ticket row, then listing row, hold unchanged
  since the scan), `listOrdersForHold`, `releaseHold`, audit
  `resale_listing_stale_hold_released` with where the listing went. Finalize
  needs both rows to sell, so no order can go live between the read and the
  release, and a CANCELLED order never becomes live again. The sweep never
  cancels an order: a PENDING order past its hold is the reaper's, and its
  cancel releases the listing. A paid order on a HELD listing, a HELD
  listing with no hold row, and a per-listing failure are logged at error
  and reported. The scan pages 200 holds at a time on a durable keyset
  cursor (`jobCursors`, `(heldUntil, listingId)`, wraps after a short page),
  so holds it keeps cannot hide newer ones. The 3600 s grace is the cart TTL
  (1200 s) plus two reaper cycles (900 s each) plus 600 s: the reaper
  reaches any order by its creation + 2100 s, and a hold's `heldUntil` is
  never before its order's creation. Safety does not depend on it.
- **Checkout refuses what cannot be sold.** `createResaleCheckout` refuses,
  as `LISTING_NOT_ACTIVE` (the code the resale page already shows "no longer
  available" for) with `meta.reason`, a listing whose ticket is not LISTED
  (`ticket_not_listed`), whose event is CANCELLED (`event_cancelled`) or
  whose `expiresAt` has passed (`listing_expired`). It still does not refuse
  on the publish state. This covers a refund that commits after a release
  read the ticket.

The real-Postgres test for the link, the fence, `cancelOpenForEvent`, the
release targets, and the real `expireResaleListings` /
`releaseRetiredCartHolds` against finalize, the link and a canceller is
`packages/adapters/src/db/prisma/__tests__/resale-listing-hold-link.integration.test.ts`.

## Not covered

- `claimFreeTickets` no longer calls Stripe inside a transaction (it did,
  through `retireCarriedOverCart`, until 2026-10-04; see "Free claims").
- When `unwindUnlinkedCheckoutOrder` itself fails, createCheckout still
  releases its claim rather than `fail`ing it (considered 2026-10-04, not
  changed). The web client (`keepsCheckoutClientKey`) mints a new key on
  any coded refusal, so the claim's state only matters to a same-key retry
  after a lost response. With `fail`, that retry would get
  `IDEMPOTENCY_LOCK_IN_PROGRESS`, keep its key, and stay refused for up to
  15 minutes. With release, it runs a fresh checkout that succeeds whenever
  capacity allows beside the dead order's holds. Either way the reaper
  frees those holds.
- G1 (a cancelled resale order's listing left HELD for good) is covered by
  the section above. What remains:
  - A listing can sit HELD for up to grace + one sweep period (about two
    hours) after its order died without its canceller releasing it (a
    process killed between the checkout's commit and its unwind, an unwind
    whose release transaction failed). The reaper closes the common case
    sooner, since the release rides its cancel.
  - A HELD listing whose order is PENDING with a PaymentIntent the reaper
    cannot settle (processing, Stripe down, no processor) stays HELD until
    the reaper can; the reaper reports it. The sweep counts it and leaves it.
  - A HELD listing with no hold row, or with a paid order, is reported and
    left for a person.
  - Listings already stranded in production leave HELD on the first sweep
    after deploy: ACTIVE if still sellable, otherwise CANCELLED (voided or
    refunded pass, cancelled event) or EXPIRED (past `expiresAt`; an
    internal listing's `expiresAt` defaults to its sale cutoff). An
    external listing with no `expiresAt` whose event has passed goes ACTIVE
    and checkout refuses it (`SALE_CUTOFF_PASSED`).
  - A refund that lands after the link committed (the client secret is
    out) is not caught at the point of sale. Finalize refuses
    (`RESALE_ORIGINAL_ITEM_REFUNDED`) and the payment goes to the DLQ, as
    before this change. A refund before the link is refused by the link's
    re-check under the ticket lock.
  - A legacy paid order on a HELD listing with no readable
    `meta.holdExpiresAt` counts as taking every hold, so the sweep reports
    it (`kept_paid`) on every hourly run until a person settles it: the
    cursor wraps after a short page and finds it again. A dedupe would
    report only on the first sweep that sees the hold (for example
    `heldUntil` within one sweep period of the grace edge), or record a
    "reported" audit row and skip holds that already have one. Not built.
  - `assertHeldBy` has no production caller since the link moved to
    `lockHold`; it is kept for its fence round-trip tests.
  - ACTIVE listings on events cancelled before `cancelOpenForEvent` existed
    were already buyable before this change; checkout now refuses them.
  - `cancelHold` (frees whatever hold a listing carries) still has no
    caller.
