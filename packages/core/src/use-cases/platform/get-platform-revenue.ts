import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// getPlatformRevenue — what the platform CHARGED, per currency, and what it
// KEPT over the orders where every input to that question is known.
//
// The settlements page can say what the platform owes and what it has paid.
// This says what the platform itself earned — on a SUBSET, stated as a
// subset. Read the net's coverage before reading the net.
//
// WHAT IS RECORDED (per currency, integer cents, never summed across
// currencies):
//
//   * ticketVolumeCents        Σ Order.amountGrossCents — money that MOVED
//                              through the platform. Mostly owed to
//                              organisers. Not income in any sense.
//   * platformFeesChargedCents Σ Order.feesPlatformCents — the fee RECORDED
//                              at checkout. What it means depends on the
//                              order's fee mode; see below. Split by mode in
//                              `platformFeesByMode`.
//   * taxCollectedCents        Σ Order.taxAmountCents — A LIABILITY. See
//                              below.
//   * connectAccountFeeCents   Σ PayoutItem.connectAccountFeeCents on
//                              transferred items — Stripe's monthly
//                              active-account fee, recovered from payees. A
//                              recovered COST, reported as its own line.
//   * feesReturnedCents        Σ OrderItem.refundedPlatformFeeCents over
//                              refunded ticket items — the platform fee
//                              actually RETURNED to buyers. Reported WITH
//                              coverage: stamped at refund execution since
//                              0fe80aa2, so older refunds are NULL.
//   * processorCostCents       Σ Order.processorFeeCents — what Stripe
//                              actually charged, over the orders the sweep
//                              has read. Reported WITH coverage, including
//                              how many unmeasured orders the sweep has
//                              PARKED (will not fill without a hand reset).
//   * netKeptCents             WHAT THE PLATFORM KEPT on the ELIGIBLE
//                              orders. Reported WITH coverage, by the same
//                              three-state rule as the two cost lines.
//
// Over the status set `SUCCEEDED, PART_REFUNDED, REFUNDED, DISPUTED`: every
// status in which money was captured. `SUCCEEDED` alone — the old
// `getPlatformStats` filter — dropped an entire order's platform fee the
// moment one ticket on it was refunded.
//
// THE MEASURED LINES, AND THEIR THREE STATES. The two cost lines fill one
// row at a time — one by a sweep, one by each refund — so both are PARTIAL
// until proven otherwise, and a partial cost is the dangerous state: it looks
// exactly like a complete one, and understating a cost OVERSTATES what the
// platform kept. The net has the same problem for the same reason, so all
// three ride with `{ measured, total }` and ONE rule decides what is
// returned:
//
//   measured === 0, total === 0 → cents 0,     reason "nothing_to_report"
//   measured === 0 <  total     → cents null,  reason "unread"
//   0 < measured < total        → cents,       reason "partial_coverage"
//   measured === total > 0      → cents,       reason null
//
// AN EMPTY POPULATION IS A CONFIDENT ZERO, NOT A NULL. The sum of an empty
// set is exactly 0 — not an estimate, not a default, not a backfill. Zero
// refunded ticket items means exactly zero platform fee returned; zero
// payment-intent-bearing orders means exactly zero processor cost; zero
// counted orders means exactly zero net. That is a DIFFERENT claim from
// `unread`, which is a real population nobody has measured yet, and the two
// used to be collapsed into one: a platform with no refunds at all rendered
// "Fees returned on refunds — not read yet", which an operator correctly
// reads as an unfinished feature rather than as the finished answer it is.
// This does not weaken the house rule below — unknown still never renders as
// 0. An empty population is not unknown.
//
// Nothing here is estimated, defaulted or backfilled. NULL in any of these
// columns means "not attributed", never zero.
//
// ── THE NET ────────────────────────────────────────────────────────────────
//
// `netKeptCents` is computed per ORDER and summed over the ELIGIBLE orders
// only, in integer cents, never across currencies:
//
//   + LEAST(feesPlatformCents, amountGrossCents)   basis-side unit, capped;
//                                                  UNSTAMPED orders only
//   + feesPlatformCents                            buyer-side unit, PASS_THROUGH only
//   − processorFeeCents                            ABSORB only
//   − LEAST(Σ refundedPlatformFeeCents,
//           LEAST(feesPlatformCents, amountGrossCents))
//                                                  basis-side give-back, capped;
//                                                  UNSTAMPED orders only
//   − Σ refundedPlatformFeeCents                   buyer-side give-back,
//                                                  PASS_THROUGH only, uncapped
//   − Σ live UserCreditRedemption.amountCents
//
// TWO CREDIT RULES, READ OFF THE ORDER. `feePolicySnapshot.organiserCredit`
// records the rule an order was sold under, and `computeAgreementBasis` is
// the one place it is decided:
//
//   * STAMPED `FULL_PRICE` — every sale since the 2026-10-11 change. The
//     organiser is credited the full ticket price, so nothing came out of the
//     basis: both basis-side terms are 0 and a PASS_THROUGH order nets
//     `fee − Σ returned − credit`. The fee is kept ONCE.
//   * UNSTAMPED — sold before that change (missing snapshot, missing key, any
//     other value). The organiser was credited `max(gross − fee, 0)`, so the
//     basis-side terms apply as written and a PASS_THROUGH order kept the fee
//     TWICE. These orders keep the amounts they were credited; whether to make
//     those organisers whole is an open owner question, not this read's.
//
// Everything below that speaks of a basis-side unit, a basis cap or "both
// units" is describing an UNSTAMPED order.
//
// ELIGIBILITY — an order counts only if ALL ELEVEN hold:
//
//   1. `feePolicySnapshot->>'feeMode'` is exactly 'PASS_THROUGH' or
//      'ABSORB'. Without a recorded mode the buyer-side unit is unknowable
//      and so is whether the processor fee was ours.
//   2. `disputeStatus IS NULL` AND `status <> 'DISPUTED'`. Disputed orders
//      are EXCLUDED, not modelled: a lost dispute returns principal, an open
//      one may, and on ticketing the platform bears Stripe's dispute fee
//      (`disputes/shared.ts`, feeBorneBy PLATFORM); this read sees none of
//      it. `markDisputeStatus` writes `disputeStatus` and never `status`
//      (`orders/_shared/dispute-list-filter.ts`), so `disputeStatus` is the
//      test that bites; the status test stays for any row that has it. ANY
//      non-null value excludes, WON and the WARNING_* inquiry states
//      included: the order row does not say whether a dispute fee was
//      charged or kept, and excluding costs coverage where a guess could
//      overstate.
//   3. Under ABSORB, `processorFeeCents IS NOT NULL` OR
//      `stripePaymentIntentId IS NULL` — the fee is stamped, or there was no
//      charge to stamp one from. Under PASS_THROUGH the buyer funded the
//      processor fee through the checkout gross-up, so it is not a platform
//      cost and an unstamped fee does not disqualify the order.
//   4. Every refunded TICKET item on the order carries its stamp: no
//      `refundedAt IS NOT NULL AND kind = 'ticket' AND
//      refundedPlatformFeeCents IS NULL`. An unstamped refund is money that
//      went back with no record of how much of the fee went with it.
//   5. NO refunded ticket item on an ABSORB order — see "THE RECOVERED
//      PROCESSOR FEE" below.
//   6. NOT (a refunded ticket item AND a live credit redemption) — see
//      "THE CREDIT A REFUND GAVE BACK" below.
//   7. `source <> 'RESALE'` — see "THE RESALE ZERO" below.
//   8. NOT (UNSTAMPED AND `feesPlatformCents > amountGrossCents` AND
//      refunded ticket items > 0 AND < all ticket items) — a PARTIAL refund
//      on an order where the basis cap bites. See "THE PARTIAL REFUND UNDER
//      A CAP". A `FULL_PRICE` order has no basis-side term, so no cap, and is
//      never excluded by this one.
//   9. NOT (STAMPED `FULL_PRICE` AND refunded ticket items > 0 AND < all
//      ticket items AND NOT EXACT) — a PARTIAL refund on a full-price order
//      is kept only when it has NO `discount` line, its `OrderSplit` rows sum
//      to the ticket faces, and every payee's share of every ticket is whole
//      (split × face divisible by Σ face for every pair). See "THE PARTIAL
//      REFUND ON A FULL-PRICE ORDER". An UNSTAMPED order is never excluded by
//      this one.
//  10. NOT (UNSTAMPED AND refunded ticket items > 0 AND < all ticket items
//      AND the tickets are not LIKE) — a PARTIAL refund on an unstamped
//      order whose tickets differ. LIKE is: one face and one recorded
//      per-ticket fee on every ticket item, per-ticket fees summing to
//      `feesPlatformCents`, no `discount` line, and `OrderSplit` rows that
//      sum to the faces less the fee with every payee's split divisible by
//      the ticket count. See "THE PARTIAL REFUND ON AN UNSTAMPED ORDER OF
//      UNLIKE TICKETS". A `FULL_PRICE` order is never excluded by this one.
//  11. NOT (an `AuditLog` row `stripe_partial_refund_reconciled` on the order
//      AND no refunded ticket item) — a partial refund made on Stripe's side
//      that moved money without refunding an item. See "THE STRIPE-SIDE
//      PARTIAL REFUND".
//
// Conditions 1 to 7 and 11 are about the fee mode, disputes, the processor
// fee, the refund stamp, credit, resale and refunds made on Stripe's side —
// none of them about the basis-side unit — and apply to a `FULL_PRICE` order
// unchanged. Conditions 8, 9 and 10 are the two credit rules' own
// partial-refund exclusions: 8 and 10 for an unstamped order, 9 for a
// full-price one.
//
// Conditions 5, 6, 8, 9 and 10 mean the only REFUNDED orders that stay
// eligible are PASS_THROUGH, fully stamped, credit-free, and one of: refunded
// in full; unstamped, uncapped, of like tickets, with no discount, with
// splits summing to the faces less the fee and every payee's split divisible
// by the ticket count; or credited the full price, with no discount, with
// splits summing to the faces and every payee's share of every ticket whole.
// The exclusions show up as coverage rather than as a wrong number. (What is
// still admitted and can be off is listed under "KNOWN AND NOT YET EXCLUDED"
// below.)
//
// WHY EACH TERM IS WHAT IT IS:
//
//   * `LEAST(fee, gross)` is the basis-side unit WITH THE CAP FOLDED IN. An
//     UNSTAMPED order's basis is `max(gross − feesPlatformCents, 0)`, so what
//     the fee actually took out of it is `min(fee, gross)`. PER ORDER, never per
//     item: the floor applies once at order level, and a per-item variant
//     would wrongly clip tickets whose siblings' gross funded the fee.
//   * THE GIVE-BACK IS TWO TERMS, UNDER TWO DIFFERENT CAPS. The stamp is the
//     item's share of `feesPlatformCents` and is UNCAPPED by construction,
//     so it cannot simply be doubled. The BASIS-SIDE give-back is capped by
//     the same `min(fee, gross)` that capped the take — only what came out
//     of the basis can go back into it, because the organiser is docked
//     exactly what they were credited (the decision record's invariant).
//     The BUYER-SIDE give-back is correctly UNCAPPED: under PASS_THROUGH the
//     buyer paid the full fee on top of the ticket whatever the promo, and
//     gets all of it back. Where `fee <= gross` the pair is arithmetically
//     identical to `stamp × (PASS_THROUGH ? 2 : 1)`, which is the decision
//     record's worked table; the cap only bites on a deep discount, where an
//     uncapped doubling invented a loss (gross 10, fee 33, stamp 33,
//     PASS_THROUGH: truly 0, but `10 + 33 − 66` = −23). The cap clamps the
//     AGGREGATE, not each ticket's share, so it is exact on a FULL refund
//     and only approximate on a partial one — which is why condition 8
//     excludes that combination rather than pro-rating it.
//   * LIVE CREDIT ONLY. A `UserCreditRedemption` is a platform-funded
//     discount: it reduces the buyer's charge and NEVER `amountGrossCents`
//     (`create-checkout.ts`), so the organiser is paid in full and the
//     platform is out the money — a real cost, invisible to every other
//     figure here. "Live" means `releasedAt IS NULL AND refundedAt IS NULL`.
//     READ THAT FILTER CAREFULLY: `releasedAt` is stamped by
//     `credits.releaseForOrder`, which is CANCEL PATHS ONLY (the order died
//     unpaid and the cents went back to the balance), and `refundedAt` HAS
//     NO WRITER ANYWHERE IN THE REPO — `ports/src/repos/credits.ts` states
//     outright that restoring a credit on refund is refund policy and is not
//     implemented, and `credit.prisma`'s comment describing it is
//     aspirational. So the filter is justified by the CANCEL path, never by
//     refund behaviour; a refunded order that spent credit is handled by
//     condition 6 instead. The `refundedAt` clause is kept so this read is
//     already correct the day a writer lands.
//   * THE CONNECT ACCOUNT FEE IS NOT IN THE NET. It is per PayoutItem, not
//     per order, so it cannot be attributed to an order without inventing
//     an allocation. It stays its own line. Do not fold it in.
//   * TAX IS EXCLUDED ENTIRELY. See below.
//
// ── THE REFUND SIDE IS WHERE THIS GETS SUBTLE ──────────────────────────────
//
// THE RECOVERED PROCESSOR FEE (condition 5). Every refund path withholds the
// ACTUAL Stripe fee from the buyer — `quote-full-refund.ts` says it outright
// ("the sole non-refundable component, uniform across ABSORB and
// PASS_THROUGH"), and `refund-full-order.ts`, `refund-order-items.ts` and
// `cancel-event.ts` all pay from the same allocation. So on a refund the
// platform RECOVERS the processor fee it paid. Subtracting
// `processorFeeCents` in full on a refunded ABSORB order therefore charges it
// twice: face 1000, fee 33, Stripe 59, fully refunded is cash in 941 against
// cash out 941 and a ledger of +967 / −967, so the truth is ZERO — while
// `33 − 59 − 33` reads −59. A cancelled event refunds every order and stamps
// every share, so a cancelled $10,000 event would have booked roughly −$300
// of net that never happened. The recovered share is stored NOWHERE, so it
// cannot be added back, and the order is excluded instead.
//
//   THE DURABLE FIX, deliberately NOT in this change: an
//   `OrderItem.refundedProcessorFeeCents` sibling to
//   `refundedPlatformFeeCents`, stamped at the three refund sites from the
//   same `stripeFeeShareCents` allocation they already compute. With that
//   column the term becomes `− (processorFeeCents − Σ recovered)` and
//   condition 5 can be dropped. Until then, coverage is the honest answer.
//
// THE CREDIT A REFUND GAVE BACK (condition 6). The refund pays the buyer NET
// of credit, while the organiser is debited their FULL basis — so the refund
// recovers what the credit cost the platform. Nothing stamps the redemption
// (see `refundedAt` above), so the credit term would go on subtracting a cost
// that came back: ABSORB gross 1000, fee 33, credit 400, Stripe 47, fully
// refunded is truly 0 and read −447. Excluded rather than guessed.
//
// THE RESALE ZERO (condition 7). This is the worst failure mode this read
// can have, because it is not a null — it is a confident, fully-covered
// wrong number. `create-resale-checkout.ts` records `feesPlatformCents: 0`:
// the platform takes no resale cut (the event side's share is an
// `OrderSplit` line out of the basis, plus `processingPassThroughCents`),
// so the fee column is 0 for a reason that has nothing to do with a free
// order. But the same file's `buildPersistedFeePolicySnapshot` hardcodes
// `feeMode: "PASS_THROUGH"`. So a resale order records a mode, is not
// disputed, is moot on condition 3, needs no stamp if unrefunded and has no
// credit — fully eligible — and nets `LEAST(0, gross) + 0 − 0 − 0 − 0` = 0
// with `measured === total`, so the reason is null and a resale-only
// currency renders "Net kept $0.00" as a COMPLETE answer for sales this
// measure never covered.
//
//   DO NOT "SIMPLIFY" THIS TO A `feesPlatformCents = 0` GUARD. A genuine
//   free event or fee-waived ticketing order records 0 as well, and for
//   those 0 is the TRUE net; excluding them would throw away real coverage.
//   The discriminator is the SOURCE, not the amount. The worked example of
//   a true 0 is `claim-free-tickets`, which DOES record a `feeMode` and so
//   stays eligible at a measured 0. COMP is NOT that example: it writes an
//   empty `feePolicySnapshot`, so condition 1 excludes it before this one is
//   reached (verified on dev: 4 COMP orders, none with a mode). Nothing is
//   lost either way — their gross and fee are both 0.
//   Excluded by source: a resale's 0 is not a measured net of a fee-bearing
//   sale, so it must not read as one.
//
// THE PARTIAL REFUND UNDER A CAP (condition 8, UNSTAMPED orders only; a
// `FULL_PRICE` order has no basis-side unit and no cap, so condition 8 does
// not apply to it, and condition 9 is its own partial-refund rule). The
// basis-side give-back is
// capped at `min(fee, gross)` in the AGGREGATE rather than pro-rated per
// ticket. That is exact on a full refund and too LARGE on a partial one
// whenever the cap bites: two tickets at fee 50 (so `fee` = 100) with a
// promo taking gross to 80, PASS_THROUGH, ONE ticket refunded with a stamp
// of 50 — truly 90 kept (the buyer paid 180 and got back 40 of face plus
// their 50 fee unit), but `80 + 100 − LEAST(50, 80) − 50` = 80.
//
//   "Everything was refunded" is COUNTED, as in (9): refunded ticket items
//   equal to all ticket items. So condition 8 drops ONLY the inexact case and
//   leaves the full refund — which the cap handles to the cent — eligible.
//   It used to read `Σ stamped = feesPlatformCents`, which a held fee-waived
//   ticket fools: it has a face and a fee of 0, so refunding every OTHER
//   ticket reaches the order fee while it is still held.
//
//   THE PRO-RATED ALTERNATIVE WAS CONSIDERED AND REJECTED. Pro-rating the
//   cap by refunded face would need integer division, and integer division
//   TRUNCATES: on a SUBTRACTED term, truncating subtracts LESS and therefore
//   OVERSTATES the net. That is the unsafe direction, and the house rule at
//   the bottom of this header forbids it. An exclusion loses coverage and
//   admits it; a pro-rate quietly keeps profit that was not kept.
//
// THE PARTIAL REFUND ON A FULL-PRICE ORDER (condition 9, STAMPED orders
// only). A `FULL_PRICE` order nets `fee − Σ stamped`. Three allocators decide
// what a refund of one ticket actually moves, over the same tickets with
// three different weights:
//
//   * the buyer's refund base, by what the buyer paid for each ticket
//     (`lib/orders/refund-item-base.ts`);
//   * the organiser's REFUND_DEBIT, by face, ONCE PER PAYEE
//     (`attributeCreditToItems` in `settlements/create-credits-from-order.ts`);
//   * the stamp, the ticket's own fee
//     (`orders/_shared/refund-platform-fee-share.ts`).
//
// Refunding ticket i costs the platform `base_i − debit_i`. Before rounding,
// for a discount of D on the order, that is
//
//   fee_i − D × (paid_i / Σ paid − face_i / Σ face)
//
// A partial refund is kept only when all three of these hold:
//
//   * NO DISCOUNT LINE. With a discount the term above is not 0: tickets
//     face 1000 / fee 33 and face 2000 / fee 50 with 1500 off the order;
//     refunding the second pays the buyer 1053, docks the organiser 1000 and
//     costs the platform 53 against a stamp of 50, so `fee − Σ stamped` reads
//     33 kept where 30 was.
//   * THE SPLITS SUM TO THE FACES. Ticket i's debits add up to
//     `face_i × Σ split / Σ face`: above the faces docks more than the face
//     (and the platform credited cents it never took, an overstatement),
//     below docks less. No split rows means no credit and no debit.
//   * EVERY PAYEE'S SHARE OF EVERY TICKET IS WHOLE: `split × face_i`
//     divisible by `Σ face` for every payee and ticket. Each payee's split is
//     attributed on its own, `Math.round` on every ticket but the last, so
//     two payees can round the same ticket the same way: two at face 1999 /
//     fee 33 split 1999 : 1999 are debited 2000 and 1998, and refunding the
//     second costs 34 where `fee − Σ stamped` gives back 33. One payee
//     holding the whole credit always passes (its split is the face sum).
//     The test is sufficient, not necessary: rounded cents can cancel, and
//     such an order is excluded although exact.
//
// With all three, the debit is the face and the base is the ticket's own
// buyer total, so the refund costs that total less the face: the ticket's
// platform fee, which the stamp copies when the per-ticket fees are recorded
// and sum to the order fee (how checkout writes them), plus its processing-fee
// share (see KNOWN below). Refunded in FULL any such order is exact: every
// base and every debit comes back and the net is 0 (the discounted example
// above: 30 + 53 = 83). All of this is pinned against the real allocators in
// `orders/_shared/__tests__/refund-platform-fee-exactness.test.ts`, including
// a sweep that checks the SQL's whole-share test against them.
//
//   THE SIGNAL IS THE DISCOUNT LINE. A promo code or membership benefit is
//   written as a negative `OrderItem` of kind `discount` (`checkout-promos.ts`
//   is the one writer), and `amountGrossCents` is the ticket lines minus
//   those lines. It is the same row the refund base reads, so it cannot
//   disagree with the money. `platform_credit` is NOT a discount here: it
//   never changes `amountGrossCents`, and condition 6 already excludes a
//   refund on an order that spent it.
//
//   ANY DISCOUNT EXCLUDES, not only one over unlike tickets. Identical
//   tickets are exact when the discount divides evenly (two at face 1000 /
//   fee 33 with 500 off: 33 and 33) and off by a cent when it does not (three
//   with 101 off: 34, 33, 32, because the two allocators hand their leftover
//   cent to different tickets). Telling the two apart in SQL would mean
//   re-running both allocators there. The exclusion gives up coverage on
//   orders that happen to be exact. On a marked order that carries a
//   discount line, (9) admits only a refund of EVERY ticket item.
//
//   "PARTIAL" IN (9) IS COUNTED: refunded ticket items fewer than all ticket
//   items on the order. Checkout writes one item per ticket (qty 1) and an
//   item refunds whole or not at all, so the count cannot call a partial
//   refund full. The stamp sum is NOT used: a fee-waived ticket held beside
//   refunded fee-bearing ones makes the stamps reach the order fee, and an
//   order fee of 0 makes any refund look full.
//
// THE PARTIAL REFUND ON AN UNSTAMPED ORDER OF UNLIKE TICKETS (condition 10,
// UNSTAMPED orders only). An unstamped PASS_THROUGH order gives back two
// stamps per refunded ticket. The basis-side unit came out of the organiser's
// credit by FACE (`attributeCreditToItems` splits `gross − fee` by face),
// while the stamp is the ticket's own per-ticket-capped fee. Face 1000 / fee
// 33 and face 2000 / fee 50, no discount, organiser credited 2917 as 972 +
// 1945: refunding the second costs 105 and the net gives back 2 × 50 = 100;
// refunding the first costs 61 against 66. This predates the full-price
// credit and applies to no order sold since.
//
//   WHAT "LIKE" MUST MEAN. A partial refund is exact only when all five hold:
//   one face on every ticket item; one per-ticket fee
//   (`meta.platformFeePerTicketCents`) on every ticket item, recorded on
//   every one, so attribution by face gives each ticket an equal share of
//   each payee's credit; the order's `OrderSplit` rows summing to n × (face −
//   fee) with EVERY payee's split divisible by n, because
//   `createCreditsFromOrder` attributes each payee's credit on its own and
//   puts that payee's leftover cent on the last ticket, so each ticket is
//   debited exactly face − fee per payee only when that payee's amount
//   divides by the ticket count (two at face 1000 / fee 33 split 50/50:
//   967 each, attributed 484 : 483, so refunding the second costs 67
//   against 66; one payee at 100% always divides, an order with no splits
//   never passes); per-ticket
//   fees summing to `feesPlatformCents`, so the stamp is that fee copied and
//   not re-allocated by buyer-paid weight; and no `discount` line, because a
//   discount is spread over the buyer's base and the organiser's credit by
//   two allocators that place their leftover cents on different tickets
//   (three at face 1000 / fee 33 with 101 off cost 67, 66 and 65 against 66
//   each). A fee-waived ticket beside a fee-bearing one is unlike by fee.
//   Each case is pinned in the exactness test file.
//
//   A FULL REFUND STAYS ELIGIBLE whatever the tickets: the differences sum to
//   both units. "Partial" is COUNTED, as in (8) and (9). An unrefunded order
//   is never touched.
//
// THE STRIPE-SIDE PARTIAL REFUND (condition 11). A partial refund made on
// Stripe's side (the dashboard) reaches `reconcileExternalPartialRefund`
// (`orders/reconcile-stripe-full-refund.ts`). Unless the refund named items,
// it flips no item and stamps nothing; it debits the payees a share in
// proportion to the amount (REFUND_DEBITs with `metadata.amountBasis`). The
// order then reads as unrefunded while the buyer has money back, and the net
// would keep the whole fee: an overstatement. Every reconciled pass writes an
// `AuditLog` row (entity `order`, action `stripe_partial_refund_reconciled`)
// in the same transaction, whether or not any payee was debited, so that row
// is the signal. Stripe fires the same event for the app's own refunds, which
// reach the same arm and leave the same row; those have refunded ticket items,
// so condition 11 excludes only an order with the row and NO refunded ticket
// item. The REFUND_DEBIT alone was rejected as the signal: an order with no
// credited payee, or whose proportional target came to 0, gets a refund and
// no debit.
//
// KNOWN AND NOT YET EXCLUDED. What is still admitted and can be off.
//
//   * THE PROCESSING-FEE SHARE on a partial refund can differ by a cent from
//     what the net assumes. Direction not measured.
//   * A STRIPE-SIDE PARTIAL REFUND ON AN ORDER THAT ALSO HAS AN IN-APP ONE.
//     Condition 11 cannot tell its audit row from the in-app refund's, so the
//     order is judged on its refunded items and the dashboard amount is
//     unseen: the net OVERSTATES by roughly what that refund cost the
//     platform. A Stripe-side partial refund event with no resolvable refund
//     id is reported and skipped without an audit row, and one reconciled
//     before the partial arm existed left none; both read as unrefunded and
//     OVERSTATE the same way.
//   * `OrderSplit` IS A PROXY FOR THE SETTLEMENT_CREDIT. Conditions 9 and 10
//     read the splits; the refund debits what `createCreditsFromOrder`
//     actually credited. They agree whenever the credit was minted from those
//     splits. Where no credit was minted (the order's splits exist but
//     `createCreditsFromOrder` failed or never ran), the refund debits nobody
//     and the platform still holds the uncredited basis: the net UNDERSTATES
//     while that holds, and OVERSTATES if the credit is minted later at the
//     full split after the refund. A credit written before the ledger used
//     the same per-payee attribution (the `attributeCreditToItems` docblock),
//     which was not re-checked here.
//   * A FULL-PRICE PARTIAL REFUND WHOSE PER-TICKET FEES ARE MISSING OR DO NOT
//     SUM TO THE ORDER FEE. The stamp is then allocated by buyer-paid weight
//     instead of copied (`refund-platform-fee-share.ts`). Where no ticket
//     records a buyer total either, the refund base and the stamp come out of
//     the same allocator over the same weights and agree; the mixed case is
//     not pinned. Direction not measured.
//
// THE STRUCTURAL OVERSTATEMENT: PASS_THROUGH PROCESSOR COST. The net treats
// the processor fee as exactly buyer-funded under PASS_THROUGH, because the
// checkout gross-up solves for it. But the gross-up prices off a STATIC US
// rate card (`packages/core/src/lib/pricing/processing-cost-schedule.ts`),
// so an international card, a currency conversion or an Amex surcharge costs
// MORE than the buyer was charged for, and the platform quietly eats the
// difference. `netKeptCents` does not see it, so on those orders the figure
// is too HIGH by exactly that difference. It is the one overstatement that
// is built into the formula rather than a population the read cannot see;
// the KNOWN section above lists those, and the rest of what is still
// admitted. The
// follow-up is to subtract `max(0, stamped processorFeeCents − the
// grossed-up estimate)` on PASS_THROUGH orders once the estimate is recorded
// per order rather than recomputed.
//
// THE NET IS OVER A SUBSET. It is never all-time platform profit and must
// never be labelled as one. `netKeptCoverage` is `{ measured, total }` =
// `{ eligible orders, orderCount }`; below full coverage the figure covers
// only part of the currency and the reason says `partial_coverage`. The
// populations the old version of this comment listed as OPEN QUESTIONS —
// unknown fee mode, unstamped processor fee, unstamped refunds, disputed
// orders — are now COUNTS: whatever is excluded shows up as the gap between
// `measured` and `total`, not as a refusal to answer.
//
// IT IS SIGNED. `netKeptCents` can legitimately be NEGATIVE: on a currency
// whose eligible orders were largely refunded, or largely paid with
// platform-funded credit, the give-backs exceed the fee. A plain signed
// integer, floored at nothing. Do not clamp it to zero — a negative net is
// the answer, and clamping would hide the one case worth seeing.
//
// THE BASIS EXPRESSION HAS NO FEE-MODE BRANCH; IT HAS A CREDIT-RULE BRANCH.
// `computeAgreementBasis` returns `max(gross, 0)` for an order stamped
// `organiserCredit: "FULL_PRICE"` and `max(gross − feesPlatformCents, 0)` for
// an unstamped one, in BOTH fee modes: the modes differ only in what the
// BUYER was charged (`docs/decisions/absorb-refund-returns-platform-fee.md`,
// accepted 2026-09-15, and the 2026-06-29 PASS_THROUGH gross-up design). An
// earlier version of this comment called the missing mode branch an OPEN
// policy question and withheld the net on those grounds. It is not one, and
// that framing is retracted.
//
// THE TWO-UNIT TAKE WAS NOT INTENDED, AND IS OVER. On an UNSTAMPED
// PASS_THROUGH sale the platform received the fee twice — once from the buyer
// on top of the ticket, once out of the basis. OBSERVED, not inferred: dev
// order gross 7500, fee 50, PASS_THROUGH, SETTLEMENT_CREDIT 7450, so 100
// retained against a recorded 50; the decision record's worked table
// tabulates the same two units. The owner ruled on 2026-10-11 that the fee is
// taken once (`docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml`),
// and every sale since is stamped `FULL_PRICE`: the same order credits 7500
// and retains 50. `netKeptCents` COUNTS both units on an unstamped order
// because both were received, and one on a stamped order because one was. It
// reports what was kept under each order's own rule; it does not restate old
// orders under the new one. Do not read the net as a blessing of the amount
// kept on unstamped orders.
//
// THE CAP BITES IN BOTH MODES ON AN UNSTAMPED ORDER, so
// `platformFeesChargedCents` is NEITHER A TOTAL NOR A BOUND (and on a stamped
// order sold ABSORB nothing of it was kept at all: the buyer paid the price
// alone and the organiser was credited all of it). The fee is computed on
// FULL FACE per ticket
// (`checkout-helpers.ts` → `computeTicketPriceForAgreement`) while
// `Order.amountGrossCents` is POST-DISCOUNT, and the basis floors at zero. A
// $10.00 ticket with a $9.90 promo records gross 10 and fee 33, so the basis
// is `max(10 − 33, 0)` = 0, the organiser is credited nothing, and the
// platform retained the 43 the buyer paid under PASS_THROUGH — not the 66 the
// two buckets sum to. Sold ABSORB the same ticket charges the buyer 10,
// credits the organiser 0, and leaves the platform 10 against a recorded 33.
// So the recorded charge can exceed what was kept — and even what anyone paid
// — in EITHER mode. `LEAST(fee, gross)` in the net above is exactly this cap,
// measured rather than ignored. A stamped order has no cap: the same ticket
// sold PASS_THROUGH credits the organiser 10 and leaves the platform the 33
// the buyer paid on top.
//
// PROCESSOR COST IS A PLATFORM COST ONLY UNDER ABSORB. Under PASS_THROUGH the
// buyer funded it through the checkout gross-up, which is why the net
// subtracts it in one mode and not the other, and why an unstamped fee
// disqualifies an ABSORB order but not a pass-through one. Dispute fees are
// separate balance transactions on the dispute, not on the charge, and are
// NOT in `processorCostCents` — another reason disputed orders are out of the
// net (condition 2).
//
// UNKNOWN NEVER RENDERS AS 0. This is the house rule stated at the top of
// `PayoutsOwedSection.tsx`: degradation must fail in the SAFE direction. An
// unmeasured line is null with a reason, and an order missing an input is
// excluded from the net rather than defaulted into it.
//
// TAX IS A LIABILITY, NOT REVENUE. The platform is merchant of record and
// remits it; it is excluded from the settlement basis entirely, counted as a
// liability by `check-platform-solvency.ts`, and absent from the net. The
// field is named `taxCollectedHeldForRemittanceCents` so no consumer can
// fold it into a revenue total by accident.
//
// Roles: ADMIN | SUPPORT — the same STAFF_ONLY read set as the sibling payout
// views, enforced HERE; the transport checks only that an actor exists.
// ─────────────────────────────────────────────────────────────────────────────

export const PLATFORM_REVENUE_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

export type GetPlatformRevenueDeps = {
  repos: Pick<Repos, "analytics" | "payoutItems">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
  /** Reports the best-effort recovered-cost lookup failure. */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: GetPlatformRevenueDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: PLATFORM_REVENUE_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

export const getPlatformRevenueInputSchema = z
  .object({ actorHumanId: z.string().min(1) })
  .strict();

export type GetPlatformRevenueInput = z.infer<
  typeof getPlatformRevenueInputSchema
>;

/**
 * Why a measured line is not a plain, complete number. MACHINE-READABLE so
 * the UI can render a specific explanation instead of a blank — and so a
 * reviewer can tell "we did not measure it" from "there was nothing to
 * measure" from "it is zero".
 */
export const platformRevenueUnavailableReasonSchema = z.enum([
  /**
   * The line's population is EMPTY (`total === 0`), so there was nothing to
   * measure — and the cents are a CONFIDENT ZERO, not a missing figure. The
   * sum of an empty set is exactly 0: no refunded ticket item means exactly
   * 0 of platform fee returned, no payment-intent-bearing order means
   * exactly 0 of processor cost, no counted order means exactly 0 net. The
   * 0 MAY BE READ AS FINAL and must not be rendered as a dash or as "not
   * read yet". Distinct from `unread` (a real population, none of it
   * measured) and from `null` (a real population, all of it measured).
   */
  "nothing_to_report",
  /**
   * The column exists, there IS something to measure, and none of it has
   * been (`measured === 0 < total`). The cents are null — "no cost recorded"
   * and "a cost of zero" are different claims, and only the second is a
   * number. 0 of 0 is NOT this state; it is `nothing_to_report`.
   */
  "unread",
  /**
   * The column is PARTLY filled (`0 < measured < total`). The cents are
   * returned — with this reason — because a partial figure is the more
   * dangerous state: it looks like an answer. Consumers must read the
   * coverage before using the number.
   */
  "partial_coverage",
]);

export type PlatformRevenueUnavailableReason = z.infer<
  typeof platformRevenueUnavailableReasonSchema
>;

/** `{ measured, total }` for a cost line that fills one row at a time. */
const coverageSchema = z.object({
  measured: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const platformRevenueCurrencyRowSchema = z
  .object({
    /** Lowercase ISO-4217. Rows are never summed across currencies. */
    currency: z.string(),
    /**
     * Σ `Order.amountGrossCents` over the captured-money status set. Money
     * that MOVED through the platform — mostly owed to organisers. Not
     * income.
     */
    ticketVolumeCents: z.number().int(),
    /**
     * Σ `Order.feesPlatformCents` over the same set — the fee RECORDED at
     * checkout.
     *
     * NEITHER A TOTAL NOR A BOUND on what the platform kept, in either
     * direction. Under ABSORB the organiser bore it, up to the basis cap
     * below. Under PASS_THROUGH the buyer paid it on top, and what happened
     * to the organiser's basis depends on the order's credit rule
     * (`feePolicySnapshot.organiserCredit`, read by `computeAgreementBasis`):
     * an order stamped `FULL_PRICE` (every sale since the 2026-10-11 change)
     * credited the full price, so the platform kept this figure ONCE; an
     * unstamped order (sold before it) also had its basis reduced by the fee,
     * so the platform retained UP TO twice this figure — less wherever the
     * basis, computed on post-discount gross and floored at zero, capped the
     * fee. See the file header. Label it "charged", never "earned".
     */
    platformFeesChargedCents: z.number().int(),
    /**
     * `platformFeesChargedCents` split by the order's recorded
     * `feePolicySnapshot.feeMode`. The three sum to the total exactly.
     * `unknownCents` is orders with no recognisable mode (missing key,
     * legacy snapshot) — reported, never folded into a real mode.
     */
    platformFeesByMode: z.object({
      passThroughCents: z.number().int(),
      absorbCents: z.number().int(),
      unknownCents: z.number().int(),
    }),
    /**
     * Σ `Order.taxAmountCents` — HELD FOR REMITTANCE, not revenue. The
     * platform is merchant of record and remits this to the jurisdiction;
     * `check-platform-solvency` counts it as a LIABILITY. Never add it into
     * a revenue total.
     */
    taxCollectedHeldForRemittanceCents: z.number().int(),
    /** Orders behind the figures above. */
    orderCount: z.number().int().nonnegative(),
    /**
     * Σ `PayoutItem.connectAccountFeeCents` on TRANSFERRED items — Stripe's
     * monthly active-account fee, incurred by the platform and recovered out
     * of payees' transfers. A recovered COST, reported on its own line and
     * deliberately NOT folded into `platformFeesChargedCents`.
     *
     * NULL when the payout-item read failed — unknown, not zero. Zero is a
     * real and common answer (no transfers in that currency yet), so the two
     * must stay distinguishable.
     */
    connectAccountFeesRecoveredCents: z.number().int().nullable(),
    /** Transferred payout items behind the recovered-cost line; null if unread. */
    payoutItemCount: z.number().int().nonnegative().nullable(),
    /**
     * PLATFORM FEE RETURNED TO BUYERS ON REFUNDS — Σ
     * `OrderItem.refundedPlatformFeeCents` over refunded ticket items, as
     * stamped at refund execution (`_shared/refund-platform-fee-share.ts`).
     * The policy refunds the platform fee in full (`quote-full-refund.ts`
     * withholds only the processing fee), so this is a real subtraction from
     * what was charged.
     *
     * `null` iff this currency HAS refunded ticket items and none of them
     * is stamped (`unread`). With NO refunded ticket items at all the figure
     * is a confident 0 with reason `nothing_to_report`: nothing was
     * refunded, so exactly nothing was returned. NON-NULL DOES NOT MEAN
     * COMPLETE: refunds issued before the column existed and
     * the bulk paths that cannot attribute per item are NULL on the row, so
     * read `feesReturnedCoverage` before using the number. Never coerce to
     * 0 — it only subtracts, so a 0 here overstates platform earnings.
     */
    feesReturnedCents: z.number().int().nullable(),
    feesReturnedUnavailableReason:
      platformRevenueUnavailableReasonSchema.nullable(),
    /**
     * Refunded TICKET items: `measured` have a stamped fee share, `total`
     * is all of them. Non-ticket lines are never stamped and are not
     * counted. 0 of 0 means no refunds in this currency — reported as
     * `nothing_to_report` with a confident 0, never as `unread`: there was
     * nothing to read.
     *
     * Deliberately `{ measured, total }` with NO `parked`: there is no
     * sweep behind this line. A NULL stamp is a refund that pre-dates the
     * column or went through a bulk path, and nothing will ever fill it —
     * the gap is permanent by construction, not a retry state.
     */
    feesReturnedCoverage: coverageSchema,
    /**
     * PROCESSOR COST — what Stripe actually charged, summed over the orders
     * the sweep has already read (`Order.processorFeeCents`).
     *
     * NON-NULL DOES NOT MEAN COMPLETE. It is the sum over the STAMPED orders
     * only, so it is a partial cost until `processorCostCoverage` reports
     * every order measured. A partial cost understates cost and therefore
     * OVERSTATES what the platform kept.
     *
     * `null` means orders exist to read and none has been read yet — never
     * "no cost". A currency with NO payment-intent-bearing orders reports a
     * confident 0 with reason `nothing_to_report` instead; there, 0 IS the
     * cost. `OrderItem.meta.processorFeeShareCents` remains deliberately
     * unread: the real charged share is stamped only in PASS_THROUGH, so in
     * ABSORB — the mode where the cost is actually ours — it holds a stale
     * pre-tax ESTIMATE. Dispute fees are separate balance transactions and
     * are NOT in this line.
     */
    processorCostCents: z.number().int().nullable(),
    processorCostUnavailableReason:
      platformRevenueUnavailableReasonSchema.nullable(),
    /**
     * How much of this currency's cost is actually measured. `measured` is
     * orders with a stamped fee; `total` is orders in the counted statuses
     * that COULD carry one (i.e. that have a payment intent). Equal means the
     * figure is complete — and still NOT that a net follows: processor cost
     * is a platform cost only under ABSORB; under PASS_THROUGH the buyer
     * funded it via the gross-up, so the line would have to be attributed
     * by mode before it could be netted.
     *
     * `parked` is how many of the unmeasured orders the sweep has GIVEN UP
     * ON (`processorFeeReadFailures` reached the cap). They still count as
     * unmeasured — the line stays `partial_coverage`, honestly — but they
     * will NEVER be read on their own: the recovery path is a manual reset
     * of `Order.processorFeeReadFailures` to 0, after which the next sweep
     * claims them again. Always `<= total − measured`. A caption can use
     * it to stop saying "not read yet" about rows that will not be.
     */
    processorCostCoverage: coverageSchema.extend({
      parked: z.number().int().nonnegative(),
    }),
    /**
     * WHAT THE PLATFORM KEPT, on the ELIGIBLE orders of this currency only.
     *
     * Per eligible order: the capped basis-side fee unit, plus the
     * buyer-side unit under PASS_THROUGH, less the processor fee under
     * ABSORB, less the platform fee returned on refunds (as TWO terms — the
     * basis-side give-back capped by the same cap that limited the take, the
     * buyer-side give-back uncapped), less live platform-funded credit. Both
     * basis-side terms are 0 on an order stamped `organiserCredit:
     * "FULL_PRICE"`: it credited the organiser the full price, so a
     * PASS_THROUGH one nets the fee once where an unstamped one nets it
     * twice. The
     * Connect account fee is a separate line (it is per PayoutItem, not per
     * order) and tax is excluded entirely.
     *
     * READ THE FILE HEADER BEFORE CHANGING ANY TERM. Three separate
     * refund-side errors here all understated profit, and none of them is
     * obvious from the expression alone: the processor fee a refund
     * RECOVERS, an uncapped give-back on a deep discount, and a credit whose
     * cost the refund gave back. A fourth — a RESALE order, which records no
     * platform fee — rendered a confident, fully-covered $0.00. A fifth is a
     * partial refund on an order credited the full price where the stamp is
     * not what the platform lost (a discount, splits that do not sum to the
     * faces, or a payee's share that rounds); a sixth is a partial refund on
     * an order sold before that credit whose tickets differ; a seventh is a
     * refund made on Stripe's side that refunded no ticket item. Seven of
     * the eleven conditions exist to exclude cases whose inputs this read
     * does not have; see the header before relaxing any of them.
     *
     * A PLAIN SIGNED INTEGER — it may legitimately be NEGATIVE, because
     * refunds and credits can exceed the fee on a currency's eligible set.
     * Do not clamp it: a negative net is the answer.
     *
     * `null` iff `netKeptCoverage.measured === 0` AND its `total > 0`. With
     * no counted orders at all it is a confident 0 (`nothing_to_report`):
     * nothing was sold, so exactly nothing was kept. NON-NULL DOES NOT MEAN
     * COMPLETE: read `netKeptCoverage` first. This is NEVER all-time
     * platform profit — it is a real figure over a subset, and a consumer
     * that renders it without its coverage is misreporting it.
     */
    netKeptCents: z.number().int().nullable(),
    /**
     * `nothing_to_report` | `unread` | `partial_coverage` | null, by the
     * same rule as the cost lines.
     */
    netKeptUnavailableReason:
      platformRevenueUnavailableReasonSchema.nullable(),
    /**
     * `measured` is orders that met ALL ELEVEN eligibility conditions (a
     * recorded fee mode; never disputed, read off `disputeStatus`; an ABSORB
     * processor fee stamped or no payment intent; no unstamped refunded
     * ticket item; no refund on an ABSORB order; no refund on an order that
     * spent live credit; not a RESALE order, which records no platform fee
     * at all; not a PARTIAL refund on an order where the basis cap bites, a
     * condition that applies only to orders WITHOUT the full-price marker;
     * not a PARTIAL refund on an order WITH the marker that carries a
     * discount line, whose payee splits do not sum to the ticket faces, or
     * whose payees' shares of the tickets are not all whole cents; not a
     * PARTIAL refund on an order WITHOUT the marker whose tickets are not
     * all alike in face and fee, that carries a discount line, or whose
     * payee splits do not each divide by the ticket count; and not an order
     * a Stripe-side partial refund paid back without refunding a ticket
     * item); `total` is `orderCount`. The gap is the excluded population —
     * reported as a count rather than as an open question.
     *
     * EXPECT REFUNDED ORDERS TO BE A BIG PART OF THE GAP. Only a
     * PASS_THROUGH, fully stamped, credit-free refund stays eligible, and a
     * partial one only when the order has no discount and its payee splits
     * attribute to the tickets without a rounded cent (on an order without
     * the full-price marker, its tickets must also be all alike);
     * the rest are excluded because what the refund cost the platform is not
     * recorded anywhere this read can see (see the header). A cancelled
     * event will visibly push this currency's coverage down, and that is the
     * correct behaviour rather than a regression.
     *
     * No `parked`: unlike the processor-cost line there is no sweep behind
     * this. Some gaps close when a refund path stamps a fee, others
     * (a legacy order with no fee mode, a dispute) never will.
     */
    netKeptCoverage: coverageSchema,
  })
  .strict()
  .superRefine((row, ctx) => {
    // THE CENTS AND THE REASON ARE ONE FACT, STATED TWICE — so the schema
    // pins them together rather than trusting the only current writer.
    // `coverageLine` is that writer today and it cannot break this, but the
    // router runs this as its `.output()`, which makes the pairing a
    // contract a FUTURE writer has to keep rather than a convention it can
    // quietly drop.
    //
    // THE INVARIANT IS AN IFF: `cents === null` exactly when the reason is
    // `unread`, and never otherwise.
    //
    //   unread            → null   (a real population, none of it measured)
    //   nothing_to_report → number (an EMPTY population: exactly 0)
    //   partial_coverage  → number (a real but incomplete figure)
    //   null              → number (complete)
    //
    // The state this exists to make unrepresentable is
    // `{ cents: null, reason: "nothing_to_report" }`: the UI would render a
    // dash AND the "nothing to report" caption AND no badge — the worst of
    // both states, claiming the answer is both missing and finished.
    const lines = [
      ["feesReturnedCents", row.feesReturnedCents, row.feesReturnedUnavailableReason],
      ["processorCostCents", row.processorCostCents, row.processorCostUnavailableReason],
      ["netKeptCents", row.netKeptCents, row.netKeptUnavailableReason],
    ] as const;
    for (const [field, cents, reason] of lines) {
      if (reason === "unread" && cents !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be null when its reason is "unread" — an unmeasured line has no figure`,
        });
      }
      if (reason !== "unread" && cents === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be a number when its reason is ${JSON.stringify(reason)} — only "unread" has no figure, and "nothing_to_report" is a confident 0`,
        });
      }
    }
  });

export type PlatformRevenueCurrencyRow = z.infer<
  typeof platformRevenueCurrencyRowSchema
>;

export const getPlatformRevenueOutputSchema = z
  .object({
    /** One row per currency, ascending. Never summed together. */
    rows: z.array(platformRevenueCurrencyRowSchema),
    /**
     * The order statuses the figures were computed over, returned so the UI
     * can NAME the basis instead of asserting one.
     */
    statuses: z.array(z.string()),
    /**
     * False when the recovered-cost (payout-item) read failed, so every
     * `connectAccountFeesRecoveredCents` is null. The fee/volume/tax figures
     * are unaffected — a recovered-cost outage must not blank the panel.
     */
    recoveredCostsResolved: z.boolean(),
    // NO TOP-LEVEL NET FLAGS. `netKeptUnavailable: true` and
    // `netKeptUnavailableReason: "inputs_incomplete"` used to live here as a
    // contract that no net was derivable from this payload. A net now
    // exists, so both are gone: the state is PER CURRENCY (an order set can
    // be fully covered in one currency and barely covered in another), and
    // `netKeptUnavailableReason` on the row carries it. Do not reintroduce a
    // payload-wide flag — it would have to lie about at least one row.
  })
  .strict();

export type GetPlatformRevenueOutput = z.infer<
  typeof getPlatformRevenueOutputSchema
>;

/**
 * The captured-money status set, surfaced so the UI can say which orders the
 * figures cover. Mirrors the adapter's filter — `CANCELLED`, `PENDING` and
 * `PROCESSING` are excluded because none of them represents captured money.
 */
export const PLATFORM_REVENUE_STATUSES = [
  "SUCCEEDED",
  "PART_REFUNDED",
  "REFUNDED",
  "DISPUTED",
] as const;

/**
 * The one rule for a measured line that fills one row at a time — see the
 * three-state table in the file header. Shared by the two cost lines AND the
 * net so the three cannot drift apart.
 */
function coverageLine(
  cents: number,
  measured: number,
  total: number,
): {
  cents: number | null;
  reason: PlatformRevenueUnavailableReason | null;
  coverage: { measured: number; total: number };
} {
  if (measured === 0) {
    // AN EMPTY POPULATION IS A CONFIDENT ZERO. The sum of an empty set is
    // exactly 0 — nothing is estimated, defaulted or guessed to get there.
    // Zero refunded ticket items means exactly zero fee returned; zero
    // payment-intent-bearing orders means exactly zero processor cost; zero
    // counted orders means exactly zero net. Folding this into `unread`
    // made the UI say "not read yet" about a line that was fully and
    // correctly answered.
    if (total === 0) {
      return {
        cents: 0,
        reason: "nothing_to_report",
        coverage: { measured, total },
      };
    }
    // Nothing measured OUT OF SOMETHING is `null`, not 0 — "no cost
    // recorded" and "cost of zero" are different claims.
    return { cents: null, reason: "unread", coverage: { measured, total } };
  }
  return {
    cents,
    reason: measured < total ? "partial_coverage" : null,
    coverage: { measured, total },
  };
}

export async function getPlatformRevenue(
  deps: GetPlatformRevenueDeps,
  rawInput: unknown,
): Promise<GetPlatformRevenueOutput> {
  const input = parseInput(getPlatformRevenueInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  // The revenue aggregate is REQUIRED — it is the panel. The recovered-cost
  // read is BEST-EFFORT: a payout-item outage must not blank figures that
  // came back fine, and it degrades HONESTLY to null (unknown), never to 0,
  // because 0 is a real answer meaning "no transfers yet".
  const [revenue, connectFeesResult] = await Promise.all([
    deps.repos.analytics.sumPlatformRevenueByCurrency(),
    deps.repos.payoutItems.sumConnectAccountFeesByCurrency().then(
      (totals) => ({ ok: true as const, totals }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ]);

  const recoveredCostsResolved = connectFeesResult.ok;
  if (!connectFeesResult.ok) {
    deps.logger?.error("platform_revenue_connect_fee_lookup_failed", {
      err: connectFeesResult.err,
    });
    // GUARDED: a MISSING or THROWING reporter must never change behaviour
    // (ReporterPort convention, CLAUDE.md).
    try {
      deps.reportError?.(connectFeesResult.err, {
        tags: {
          useCase: "getPlatformRevenue",
          step: "sumConnectAccountFees",
        },
      });
    } catch {
      // Reporting is fire-and-forget.
    }
  }

  const connectByCurrency = new Map(
    connectFeesResult.ok
      ? connectFeesResult.totals.map((t) => [t.currency, t])
      : [],
  );

  // Currencies that exist ONLY on the payout side still deserve a row: a
  // recovered cost with no matching order revenue is exactly the anomaly a
  // staff reader needs to see, and dropping it would hide money.
  const currencies = [
    ...new Set([
      ...revenue.map((r) => r.currency),
      ...connectByCurrency.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const revenueByCurrency = new Map(revenue.map((r) => [r.currency, r]));

  const rows: PlatformRevenueCurrencyRow[] = currencies.map((currency) => {
    const money = revenueByCurrency.get(currency);
    const connect = connectByCurrency.get(currency);
    // Both cost lines go through the same rule. A payout-only currency has
    // 0 of 0 on each, which reads as `nothing_to_report` with a confident 0
    // — there is no cost, rather than a cost nobody has read.
    const processor = coverageLine(
      money?.processorFeeCents ?? 0,
      money?.processorFeeMeasuredCount ?? 0,
      money?.processorFeeEligibleCount ?? 0,
    );
    const returned = coverageLine(
      money?.feesReturnedCents ?? 0,
      money?.feesReturnedMeasuredCount ?? 0,
      money?.feesReturnedEligibleCount ?? 0,
    );
    // THE NET, through the SAME rule. `measured` is the eligible orders,
    // `total` is every counted order — so a currency with orders where none
    // is eligible reads `unread` (null, NOT a zero net) and one where only
    // some are reads `partial_coverage` with a real figure. A payout-only
    // currency has no orders at all, so it is 0 of 0 and reports a confident
    // 0: nothing was sold, so exactly nothing was kept. The Connect fee is
    // deliberately not in the net, so that 0 is not contradicted by it.
    const net = coverageLine(
      money?.netKeptCents ?? 0,
      money?.netKeptEligibleCount ?? 0,
      money?.orderCount ?? 0,
    );
    return {
      currency,
      ticketVolumeCents: money?.ticketVolumeCents ?? 0,
      platformFeesChargedCents: money?.platformFeesChargedCents ?? 0,
      platformFeesByMode: {
        passThroughCents: money?.platformFeesPassThroughCents ?? 0,
        absorbCents: money?.platformFeesAbsorbCents ?? 0,
        unknownCents: money?.platformFeesUnknownModeCents ?? 0,
      },
      taxCollectedHeldForRemittanceCents: money?.taxCollectedCents ?? 0,
      orderCount: money?.orderCount ?? 0,
      // Resolved-but-absent is a genuine 0 (no transfers in that currency).
      // UNRESOLVED is null. The two must never collapse into one another.
      connectAccountFeesRecoveredCents: recoveredCostsResolved
        ? (connect?.connectAccountFeeCents ?? 0)
        : null,
      payoutItemCount: recoveredCostsResolved ? (connect?.itemCount ?? 0) : null,
      feesReturnedCents: returned.cents,
      feesReturnedUnavailableReason: returned.reason,
      feesReturnedCoverage: returned.coverage,
      processorCostCents: processor.cents,
      processorCostUnavailableReason: processor.reason,
      processorCostCoverage: {
        ...processor.coverage,
        // Parked rows are still unmeasured (the reason rule above already
        // counted them); this only says how many of the gap is permanent
        // without a hand reset.
        parked: money?.processorFeeParkedCount ?? 0,
      },
      netKeptCents: net.cents,
      netKeptUnavailableReason: net.reason,
      netKeptCoverage: net.coverage,
    };
  });

  return {
    rows,
    statuses: [...PLATFORM_REVENUE_STATUSES],
    recoveredCostsResolved,
  };
}
