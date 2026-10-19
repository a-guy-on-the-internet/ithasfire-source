# Decision Record: ABSORB is removed

**Status:** accepted (2026-10-01, owner ruling: "The absorb policy should be
gone.")

Follows `fee-mode-switch-dropped.md`, which stopped new events from entering
`ABSORB` but left existing rows, the checkout cold path and the legacy
read-only UI in place. This record closes those. Where the two disagree, this
one wins; that record's sections on legacy ABSORB events, the "Not yet
guarded" cold path, the builder badge and the seed fixture describe the state
before 2026-10-01.

## Decision

- Every `PayoutTerms` and `FeePolicy` row that said `ABSORB` now says
  `PASS_THROUGH` (three migrations, below).
- No new sale is priced `ABSORB`, whatever a terms or policy row says.
  Buyers on a converted event pay the platform fee and the processing fee on
  top of the ticket price, like every other event.
- Tickets already sold keep exactly what they were charged. Orders carry their
  own amounts and their own record of the mode they were sold under; nothing
  re-derives a past order from a live terms or policy row.

## What changes for an organiser whose event converts

> Superseded 2026-10-11 by `platform-fee-charged-once.md`: organisers are now
> credited the full ticket price. This section describes sales between
> 2026-10-01 and that change.

Their credit per ticket does not change. Settlement credits
`computeAgreementBasis` = `amountGrossCents − feesPlatformCents` in both modes
(see `absorb-refund-returns-platform-fee.md`): a $10.00 ticket with a 33¢
platform fee credits the organiser $9.67 before and after. What changes is the
buyer's charge, which now adds the platform fee and a grossed-up processing fee
on top of face, and who pays Stripe: under `ABSORB` the processing fee was a
platform cost, now the buyer funds it.

So "organisers now receive the full ticket price" is not what happens, and no
copy says it. The help center says buyers pay fees on top and the payout line
is unchanged.

## Where the guarantee lives

`SALE_FEE_MODE` (= `PASS_THROUGH`) in
`packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts`. Every
pricing-time reader takes its mode from that constant and never from
`terms.feeMode ?? policy.feeMode`:

| Consumer | Before | Now |
| --- | --- | --- |
| `computeTicketPriceForAgreement` (the per-ticket kernel) | `agreement.feeMode ?? policy.feeMode` | `SALE_FEE_MODE` |
| `computeOrderAmounts` (`checkout-helpers.ts`): createCheckout (both passes), the routing probe, `updateOrderItems` cart holds, `claimFreeTickets`, the embed guest checkout, the seed | same precedence, for the cap, waiver and gross-up | `SALE_FEE_MODE` |
| `buildFeePolicySnapshot` (the `feePolicySnapshot.feeMode` stamped on each new order) | same precedence | `SALE_FEE_MODE`, so the order page reads back the mode the sale was priced under |
| `estimateBuyerTicketPricingForEvent`: event page, card badges, `ticketTiersForCard`, JSON-LD, embeds, the SEARCH INDEX buyer total, `getCheckoutFeeRates`, `estimateCheckoutTax` | same precedence | `SALE_FEE_MODE` when a policy resolves; `null` (no policy anywhere) is unchanged |
| `getEventFeePreview` (builder fee line) | same precedence | `SALE_FEE_MODE` |
| `createResaleCheckout` (`meta.effectiveFeeMode` on the resale item) | terms ?? policy | `SALE_FEE_MODE` (the resale charge itself never depended on it) |

That also closes the checkout cold path. `loadPayoutTermsContext` still walks
EVENT → ORG → GLOBAL for unpinned terms and may return a legacy row, but only
its rates are used.

## Historical reads, kept

These read a PAST order's own record and still handle `ABSORB`:

- `computeBuyerChargeBreakdown`: mode from `feePolicySnapshot.feeMode`, then
  item `meta.effectiveFeeMode`, then what was charged. Feeds `getMyOrder`,
  `listMyOrders`, `listPlatformOrders` (web `OrderDetail`, `OrderCard`,
  `OrderDetailPanel` with its "absorbed by organizer" label, mobile
  `OrderDetailScreen`, `TicketOrdersList`).
- Refunds (`quote-full-refund`, `quote-item-refund`, `refund-full-order`,
  `refund-order-items`, `cancel-event`, `reconcile-stripe-full-refund`): read
  order columns and item meta, uniform across modes.
- Settlement and the ledger: `computeAgreementBasis(order)`, order columns.
- Net-kept and platform revenue (`get-platform-revenue.ts`,
  `adapters/db/prisma/analytics.ts`): `feePolicySnapshot->>'feeMode'`.
- Dispute evidence: `computeExpectedPaymentAmount(order)`, order columns.
- Held carts priced before deploy (`pending-cart-fees.ts`,
  `get-active-cart-holds`): the pending order's own item meta.

## Removed

- Publish's refusal to pin an `ABSORB` policy (`FEE_POLICY_NOT_ACTIVE` +
  `meta.reason: fee_mode_absorb`) and its free-event unpinned branch. A
  resolved policy is pinned whatever its mode.
- The paid-ticket gate's `ABSORB` arm (`PAID_TICKETING_REQUIRES_FEE_POLICY` +
  `fee_mode_absorb`). The gate refuses only when no policy resolves.
- `@th/errors/meta-reason-copy` (`resolveMetaReasonCopy`) and the catalog keys
  `errors.publishBlockedPlatformSetup` / `errors.paidTicketsBlockedPlatformSetup`.
  Both mappings were for those two refusals, and nothing else used the
  mechanism.
- The builder's "Platform fee absorbed by organizer" badge and the ABSORB
  variant of the per-ticket fee line ("Platform fee (your cost)", "You get"),
  with the keys `ttFeePlatformFeeYourCost` and `ttFeeYouGet`. `ttFeeModeAbsorb`
  stays: the staff order panel uses it for past orders.
- The seed's LEGACY ABSORB fixture (`LEGACY_ABSORB_FIXTURE_SLUG`,
  `assertSeedLegacyAbsorbFixture`) and its ABSORB-pin refusal. The seed creates
  no `ABSORB` anywhere. A dev DB that already holds the fixture's terms is
  converted by the migration. Orders seeded under the old fixture keep their
  `ABSORB` snapshot until the next re-seed; the historical read paths are
  covered by unit tests either way (`buyer-charge-breakdown`,
  `get-my-order-charges`, the refund suites, `get-platform-revenue`).

## The `PaymentFeeType` enum keeps `ABSORB`

Dropping it is not safe:

- Past orders carry `'ABSORB'` in `Order.feePolicySnapshot` and item
  `meta.effectiveFeeMode`. Those are JSON, not enum columns, but the shared TS
  `FeeMode` type describes them and the read paths above switch on it.
- Postgres has no `ALTER TYPE … DROP VALUE`. Removing a label means creating a
  new type and rewriting `FeePolicy` and `PayoutTerms` under an exclusive lock,
  for no behavioural gain once pricing ignores the stored mode.

Nothing writes `ABSORB` any more: the terms port closed `feeMode` in
2026-09-29, and no product path writes `FeePolicy.feeMode` other than the GLOBAL
reconciler, which writes `PASS_THROUGH`.

## The migrations

One statement each, idempotent, one-way (no down: afterwards nothing records
which rows said `ABSORB`, and restoring them would reopen the mode).

1. `20261001230000_absorb_removed_mark_search_reindex`: inserts a
   `SearchReindexPending` row (`entity_type = 'event'`) for every event whose
   PRIMARY terms say `ABSORB`, are pinned to an `ABSORB` policy, or sit under
   an ACTIVE `ABSORB` policy at EVENT, ORG or GLOBAL scope. Runs first,
   because the next two erase the evidence.
2. `20261001230001_absorb_removed_payout_terms`: `PayoutTerms.feeMode`
   `ABSORB` → `PASS_THROUGH`. Explicit rather than `NULL`: a null mode
   inherits the pinned or resolved policy's mode, which would leave the row one
   policy away from `ABSORB`.
3. `20261001230002_absorb_removed_fee_policies`: `FeePolicy.feeMode` `ABSORB`
   → `PASS_THROUGH` for every scope and status. Flipped in place rather than
   archived and re-pointed at GLOBAL, because a pin exists to keep the rates a
   deal was agreed under: an EVENT or ORG policy can carry negotiated rates,
   and re-pointing would change those as well as the mode. Archiving an ACTIVE
   ORG/EVENT row would also move every unpinned event in that scope onto
   GLOBAL rates. Archived rows are flipped too, since a pin to one still
   resolves.

Verified on a scratch database (fixtures for each arm, two controls, a stale
reindex row and a past `ABSORB` order; then re-run to prove idempotency): see
the 2026-10-01 implementation report.

## On deploy

1. **Before migrating prod, capture the affected organisers.** Afterwards the
   database cannot tell you. Read-only:

   ```sql
   SELECT DISTINCT e.id, e.slug, e.status, e."orgId", e."humanId"
   FROM "Event" e
   LEFT JOIN "PayoutTerms" pt ON pt.id = e.payout_terms_id
   LEFT JOIN "FeePolicy" pinned ON pinned.id = pt."feePolicyId"
   WHERE pt."feeMode" = 'ABSORB'
      OR pinned."feeMode" = 'ABSORB'
      OR EXISTS (
        SELECT 1 FROM "FeePolicy" s
        WHERE s."feeMode" = 'ABSORB' AND s.status = 'ACTIVE'
          AND ((s."scopeType" = 'EVENT' AND s."scopeId" = e.id)
            OR (s."scopeType" = 'ORG' AND s."scopeId" = e."orgId")
            OR s."scopeType" = 'GLOBAL'));

   -- Entity DEFAULTS (org / human / place) that say ABSORB: new events were
   -- already reset at snapshot time, so these change nothing for buyers.
   SELECT count(*) FROM "PayoutTerms" WHERE "feeMode" = 'ABSORB' AND "isDefault";
   ```

   Organisers who SOLD under `ABSORB` can still be found afterwards:
   `SELECT DISTINCT "eventId" FROM "Order" WHERE "feePolicySnapshot"->>'feeMode' = 'ABSORB';`

2. **Migrate** through the normal deploy (`migrate_db`).

3. **Verify.** Each must return 0:

   ```sql
   SELECT count(*) FROM "PayoutTerms" WHERE "feeMode" = 'ABSORB';
   SELECT count(*) FROM "FeePolicy"   WHERE "feeMode" = 'ABSORB';
   ```

4. **Run `search.full-reindex` after the migration. This step is REQUIRED.**
   Trigger it from the platform jobs page once the migrations have finished.
   The search document stores a buyer total, and so do other caches: event
   cards, the cart-recovery banner and the home cache all show the old
   (face + tax) price for a converted event until the index is rebuilt.
   Checkout itself already charges and shows the new total, so nobody is
   mischarged, but the cards would disagree with it. The migration only
   marks the affected events in `SearchReindexPending`; there is a narrow
   race where a `search.drain-reindex-pending` run reads a row during the
   deploy, reindexes before the conversion commits, and clears it. The
   nightly `search.full-reindex` (03:00 UTC) is the backstop for that, and
   for anything else the marks miss, but do not wait for it.

5. **Tell the organisers from step 1** that buyers now pay the platform fee
   and the processing fee on top, and that what they are credited per ticket
   does not change.

The local dev DB on 2026-10-01 (read-only check): 1 `PayoutTerms` row in
`ABSORB` (the seed's LEGACY fixture, Brooklyn Warehouse Showcase) and 0
`FeePolicy` rows, so the migration marks 1 event and converts 1 row. Its
orders were re-seeded during the change and already record `PASS_THROUGH`.

## Not done here

- The web checkout and embed components still type `feeMode` as
  `"ABSORB" | "PASS_THROUGH" | null` and keep their ABSORB display branches.
  The server no longer sends `ABSORB` for a new quote, so those branches are
  unreachable except for a cart held across the deploy. They are safe to remove
  in a later cleanup.
- `makePayoutTermsRepo.clone` (`adapters/db/prisma/payout-terms.ts`) still
  drops a pin to an `ABSORB` policy when `resetFeeMode` is set. After the
  migration no such policy exists, so the branch is inert.
