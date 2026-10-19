# Decision Record: No per-event Fee Handling switch

**Status:** accepted (2026-09-29, owner ruling; confirmed 2026-09-30).
Followed on 2026-10-01 by `absorb-removed.md`: ABSORB is removed. Existing
ABSORB terms and fee policies were converted to PASS_THROUGH by migration, no
sale is priced ABSORB whatever a row says (`SALE_FEE_MODE`), and the publish
refusal, the paid-ticket gate's ABSORB arm, the builder badge and the seed
fixture described below are gone. Sections marked *(superseded)* record the
state before that.

## Context

Each event's PRIMARY payout terms carry a `feeMode`. In `PASS_THROUGH` the
buyer pays face + platform fee + a grossed-up processing fee + tax. In
`ABSORB` the buyer pays face + tax. The organiser absorbs the platform fee:
it comes out of their settlement basis (`computeAgreementBasis` =
`amountGrossCents − feesPlatformCents`). Stripe's processing fee under
`ABSORB` is the PLATFORM's cost, not the organiser's: charges are separate
charges and transfers, so Stripe takes its fee from the platform balance,
and the net-kept read books it as a platform cost (`get-platform-revenue.ts`).

A null `feeMode` on the terms inherits the mode of the FeePolicy row the
terms are pinned to, or, if they carry no pin, the row resolved
EVENT → ORG → GLOBAL (`resolveScopedFeePolicy`). The GLOBAL row is kept in
sync with `PLATFORM_FEE_POLICY` (`PASS_THROUGH`,
`packages/core/src/lib/pricing/platform-fee-policy.ts`) by the reconciler
(`reconcile-platform-fee-policy.ts`). EVENT and ORG rows have no writer in the
product; any that exist are legacy.

Until now the builder's **Tickets** section had a **Fee Handling** toggle
(`setEventFeeMode`) that let the event owner flip between the two. The
pricing redesign takes one stance instead: fees are always itemised and added
on top, so the buyer sees exactly what they pay.

## Decision

No event can be put into `ABSORB` any more. Every new event resolves to
`PASS_THROUGH`, provided ops query 1 below is empty (no ACTIVE ABSORB fee
policy); see "Not yet guarded" for the resolver that does not check.

- **Removed:** the `setEventFeeMode` use case, its tRPC procedure
  (`events.setEventFeeMode`), and the builder toggle with its owner-only
  read-only variant.
- **Closed at the port:** `CreatePayoutTermsDraftInput` and
  `UpdatePayoutTermsDraftInput` no longer accept `feeMode`, and the Prisma
  adapter writes `null` on every new draft. A future writer has to change the
  port to set a mode, which puts the change in front of a reviewer.
- **Snapshots reset the mode.** `PayoutTerms.clone` takes a required
  `resetFeeMode`. Every caller today copies a DEFAULT, and every one passes
  `true`, so the copy is written with `feeMode: null`, and a pin to an
  ABSORB FeePolicy is dropped too (a null mode would inherit it):
  - event creation snapshotting the org/place/human default PRIMARY and
    RESALE terms (`events.upsertDraft` → `clonePayoutTermsRow`);
  - booking acceptance snapshotting the place default
    (`booking-requests/_shared/accept-agreement.ts`);
  - `updatePayoutSchedule`, which clones the org/human DEFAULT (default to
    default, with the new schedule) and re-points the entity at the copy;
  - the e2e and dev-seed snapshot helpers, which mirror event creation.

  `resetFeeMode: false` keeps the source's mode and pin. It exists only for
  copy-on-write of an event's OWN row, where a legacy ABSORB event must keep
  its math; no caller needs it today.
- *(superseded 2026-10-01: removed; publish pins whatever resolves)*
  **Publish refuses to pin an ABSORB FeePolicy onto modeless terms.** When
  the terms carry no pin and no mode, `publishEvent` resolves a policy and
  pins it. If that policy is ABSORB (only a legacy EVENT or ORG row can be):
  - a PAID event (any ever-paid tier, door price included) fails with
    `FEE_POLICY_NOT_ACTIVE`, `meta.reason: fee_mode_absorb`. The web shows
    "Publishing is blocked by a platform setup issue on our side. Support has
    been notified." (`errors.publishBlockedPlatformSetup`, via
    `resolveMetaReasonCopy` in `@th/errors/meta-reason-copy`, keyed on code
    + reason), not the code's "isn't active"
    copy;
  - a FREE event publishes UNPINNED, as it would with no policy at all;
  - both are reported (`reportError` + `logger.error`); only ops can retire
    the row.

  Terms that already say `PASS_THROUGH` or `ABSORB`, and terms that already
  carry a pin, are left alone. The dev seed applies the same rule when it
  pins a policy for a seeded paid event.
- **Dead write endpoints deleted, not patched.** `agreements.upsertForOrg`,
  `agreements.upsertForHuman`, `agreements.upsertForEvent` and
  `agreements.setDefaultPayoutTerms` had no caller in any app, script or e2e
  spec, only the tRPC router and their own tests. They were deleted (use
  cases, exports, router entries, tests), together with the shared helpers
  only they used (`finalizeAgreementUpsert`, `ensureFeePolicy`,
  `getExistingLines`). That removes three things at once:
  - the agreement-upsert FeePolicy pin (a caller could pin any ACTIVE GLOBAL
    or own-ORG policy, including a legacy ABSORB one);
  - a cross-tenant write: the upserts looked up the existing terms row by id
    without checking it belonged to the authorised org, human or event, so
    one tenant could rewrite another's PENDING draft lines given its UUID;
  - a cross-tenant pointer: `setDefaultPayoutTerms` checked only that the
    terms row existed, so an admin could point their default at another
    tenant's row, or at a legacy ABSORB one.

  Because both are gone, "create terms with `upsertForOrg`, then make them the
  default with `setDefaultPayoutTerms`" is no longer a flow. Entity defaults
  are still provisioned by `ensureEntityDefaultPrimaryTerms` (first publish,
  payout settings) and re-versioned by `updatePayoutSchedule`.

  Still live and not changed here: `upsertAgreementLine` (exported, but not
  wired to any router), which checks access through
  `events.findByPayoutTermsId`.

- *(superseded 2026-10-01: the ABSORB arm is removed)*
  **The free→paid flip is guarded at the ticket editor.** A free event
  published under a legacy ABSORB policy is left unpinned, so its first paid
  tier would let checkout resolve ABSORB. `ensureFeePolicyResolvableForPaidTicketing`
  (`upsertTicketType` and `updateTicketType`) now refuses a paid tier when the
  resolved policy is ABSORB and the event's PRIMARY terms have no mode and no
  pin (or don't exist yet). It throws `PAID_TICKETING_REQUIRES_FEE_POLICY`
  with `meta.reason: fee_mode_absorb`, reported like publish's refusal; the
  web shows "Paid tickets are blocked by a platform setup issue on our side.
  Support has been notified." (`errors.paidTicketsBlockedPlatformSetup`).
  Terms that carry their own mode or a pin are left alone.

**Checkout cold path: closed 2026-10-01.** Pricing no longer reads a
terms or policy mode (`SALE_FEE_MODE`, see `absorb-removed.md`), so a policy
resolved here supplies rates only. What follows is the earlier analysis.

*(superseded)* **Not yet guarded: the checkout cold path.** Publish and the ticket editor
are not the only resolvers. `loadPayoutTermsContext` (checkout) re-resolves
EVENT → ORG → GLOBAL for terms that carry no pin, with no ABSORB check. The
free→paid flip is now refused before it gets there; the remaining way
unpinned terms reach checkout on a live event is booking terms finalized
onto an already-published event (`finalize-booking-agreement.ts` links and
activates them without a pin). Those can price a sale ABSORB if an ABSORB
EVENT/ORG policy is ACTIVE. Guarding the cold path itself is a documented
follow-up; until it lands, ops query 1 is the guard.

Rows that are ALREADY unpinned on live events carry the same exposure:
events published free with no policy and flipped to paid before the ticket
editor gate existed, and booking terms finalized onto a live event. Two
consequences follow, and ops query 5 lists the events concerned:

- On such an event the ticket editor now refuses a new paid tier when the
  resolved policy is ABSORB, while the event's existing paid tiers keep
  selling ABSORB through the checkout cold path.
- Retiring an ABSORB policy per query 1 switches those live events to
  `PASS_THROUGH` at their next checkout. Review them with the organiser
  before archiving the policy.

**Ops checks (2026-10-01: now migration verification).** After the
`20261001230001`/`…02` migrations, queries 1–4 must return no rows or 0; query
5 lists unpinned live events, which now sell fees-on-top regardless. The
pre-deploy capture query is in `absorb-removed.md`.

*(superseded)* **Ops checks before relying on this in prod.** The guards above stop NEW
ABSORB through publish and snapshots; they don't change existing rows. Run
these read-only queries against prod:

- Query 1 must return NO rows. Any ACTIVE ABSORB fee policy must be RETIRED
  (archived) before relying on this decision, because the checkout cold path
  above would still resolve it.
- Queries 2–5: a non-zero count means those rows should be reviewed. Run
  query 5 BEFORE retiring any policy found by query 1.

```sql
-- 1. ACTIVE fee policies that absorb fees (any scope).
SELECT id, "scopeType", "scopeId", version FROM "FeePolicy"
WHERE status = 'ACTIVE' AND "feeMode" = 'ABSORB';

-- 2. Entity defaults whose own mode is ABSORB (reset at snapshot time,
--    but the stored default stays ABSORB).
SELECT count(*) FROM "PayoutTerms"
WHERE "feeMode" = 'ABSORB'
  AND id IN (
    SELECT default_primary_payout_terms_id FROM "Organization"
    UNION SELECT default_resale_payout_terms_id FROM "Organization"
    UNION SELECT default_primary_payout_terms_id FROM "Human"
    UNION SELECT default_resale_payout_terms_id FROM "Human"
    UNION SELECT default_primary_payout_terms_id FROM "Place"
    UNION SELECT default_resale_payout_terms_id FROM "Place"
  );

-- 3. Entity defaults PINNED to an ABSORB fee policy (the snapshot drops
--    the pin, but the stored default keeps it).
SELECT count(*) FROM "PayoutTerms" pt
JOIN "FeePolicy" fp ON fp.id = pt."feePolicyId"
WHERE fp."feeMode" = 'ABSORB'
  AND pt.id IN (
    SELECT default_primary_payout_terms_id FROM "Organization"
    UNION SELECT default_resale_payout_terms_id FROM "Organization"
    UNION SELECT default_primary_payout_terms_id FROM "Human"
    UNION SELECT default_resale_payout_terms_id FROM "Human"
    UNION SELECT default_primary_payout_terms_id FROM "Place"
    UNION SELECT default_resale_payout_terms_id FROM "Place"
  );

-- 4. Unpublished (DRAFT) events that will publish as ABSORB: their own
--    PRIMARY terms say ABSORB (set by the old toggle), or their terms have
--    no mode and are pinned to an ABSORB fee policy. They count as LEGACY
--    (left alone by design) and should be reviewed with the organiser.
SELECT e.id, e."orgId", e."humanId", pt."feeMode", fp.id AS "absorbPolicyId"
FROM "Event" e
JOIN "PayoutTerms" pt ON pt.id = e.payout_terms_id
LEFT JOIN "FeePolicy" fp ON fp.id = pt."feePolicyId"
WHERE e.status = 'DRAFT'
  AND (pt."feeMode" = 'ABSORB'
       OR (pt."feeMode" IS NULL AND fp."feeMode" = 'ABSORB'));

-- 5. PUBLISHED events whose PRIMARY terms carry neither a mode nor a pin.
--    Checkout resolves their policy at sale time (the cold path), so an
--    ACTIVE ABSORB policy from query 1 prices them ABSORB today, and
--    retiring that policy switches them to PASS_THROUGH.
SELECT e.id, e."orgId", e."humanId", pt.id AS "payoutTermsId"
FROM "Event" e
JOIN "PayoutTerms" pt ON pt.id = e.payout_terms_id
WHERE e.status = 'PUBLISHED'
  AND pt."feeMode" IS NULL
  AND pt."feePolicyId" IS NULL;
```

The local dev DB on 2026-09-30: query 1 returned no rows (one FeePolicy, the
GLOBAL `PASS_THROUGH` row); query 2 returned 0 of 7 defaults; none of the 7
defaults carries a pin, so query 3 is 0; queries 4 and 5 returned no rows.

## Existing ABSORB events and orders keep their math *(superseded for events)*

2026-10-01: existing ABSORB events were converted to PASS_THROUGH and a new
checkout on one adds fees on top. Past ORDERS still keep their math, through
the read paths listed in `absorb-removed.md`.

No data was migrated. Rows that already say `ABSORB` keep it, and every read
and math path still honours it unchanged: `computeTicketPriceForAgreement`,
`computeOrderAmounts`, `computeAgreementBasis`, the refund quotes and
execution (see `absorb-refund-returns-platform-fee.md`), settlement, the
platform net-kept query, and `estimate-buyer-ticket-pricing.ts`. A new
checkout on a legacy ABSORB event still charges face + tax.

## What an organiser with a legacy ABSORB event sees *(superseded)*

2026-10-01: the badge is removed; no event is ABSORB any more.

The **Tickets** section shows a read-only **Platform fee absorbed by
organizer** badge in place of the old toggle. The per-ticket fee preview
still reflects the event's real mode from the server (`getEventFeePreview`):
no buyer processing line, and a buyer total of face + tax. There is no
control to switch the event to fees-on-top or back. Events in `PASS_THROUGH`
show no fee-mode control or label at all, only the preview.

## Buyer-facing order lines

The order page used to list `Order.feesPlatformCents` as a "Platform Fee" on
every order. Under `ABSORB` that column is the organiser's cost, so an ABSORB
buyer saw a fee they never paid, and the lines did not add up to Total paid.
`getMyOrder` now returns `charges`, built by `computeBuyerChargeBreakdown`
(`packages/core/src/lib/orders/buyer-charge-breakdown.ts`): lines that always
sum to the total, with no platform or processing line under `ABSORB`.

- The fee mode comes from the order's `feePolicySnapshot.feeMode`, then the
  ticket items' `meta.effectiveFeeMode`, then what the buyer was charged.
- Orders whose items carry no `meta.buyerTotalCents`:
  - not paid through Stripe (cash/POS, comp) and recorded ABSORB: the total
    is face + tax − credit;
  - paid through Stripe: finalize only accepts a PaymentIntent whose amount
    equals `computeExpectedPaymentAmount(order)`, so that is the total, and
    any amount above face + tax shows as fees.
- The shared `computeExpectedPaymentAmount` is NOT changed, because finalize,
  the refund quotes and execution, cancel-event, Stripe refund
  reconciliation and dispute evidence all read it.

The same `charges` object feeds:

- the order page (web `OrderDetail.tsx`, mobile `OrderDetailScreen.tsx`);
- the My Tickets list (`listMyOrders` → web `OrderCard.tsx`, mobile
  `TicketOrdersList.tsx`). A row the viewer holds only through a transferred
  ticket gets `charges: null`, and its `amountGrossCents` and
  `feesPlatformCents` are zeroed (zero rather than null, so an old client
  build reads "$0.00" instead of crashing). Current clients show no amount:
  what someone else paid is not theirs to see;
- the staff order panel's Net Charged (`listPlatformOrders`), which for a
  Stripe-paid order is what Stripe captured. Under ABSORB the recorded
  platform fee stays visible to staff, greyed and labelled as absorbed by the
  organiser; no processing line is shown, since that cost is the platform's.
  One exception: on a Stripe-paid order whose items carry no per-item buyer
  totals, any amount captured above face + tax is shown as a platform fee
  CHARGE (not greyed), because the buyer demonstrably paid it.

The cart recovery banner can't show a charge: a held cart persists no tax
and no processing fee. It shows the ticket subtotal followed by "+ fees &
tax" (or "+ tax" where the organiser absorbs the platform fee), the way the
event page does. A $0 cart shows just the $0 subtotal.

## Seed *(superseded)*

2026-10-01: the LEGACY ABSORB fixture and its assert are removed. The seed
creates no ABSORB; a dev DB that already holds the fixture's terms is converted
by the migration, and orders seeded under it keep their ABSORB snapshot until
the next re-seed.

The dev seed keeps ONE event in ABSORB, labelled LEGACY
(`LEGACY_ABSORB_FIXTURE_SLUG` in `apps/api/src/scripts/seed/events.ts`). It
is written straight to the terms row. `assertSeedLegacyAbsorbFixture` checks
the event THIS run wrote, not a DB-wide count, so leftover ABSORB events in an
unreset dev DB don't fail the seed, and a renamed fixture does. Prod still
holds such data, so the read-only badge, the ABSORB order page and net-kept's
by-mode split need to stay exercisable locally.
