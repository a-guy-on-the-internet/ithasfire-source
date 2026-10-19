# The Money Mechanism — what we actually run

**Status:** analysis, 2026-09-06. Derived from the code as it stands in the working tree (including the uncommitted availability-floor and `balance_insufficient` work), Stripe's current docs, and the two existing legal memos. Not legal advice. Every claim below is traceable to a file or a Stripe page; where it is an inference from reading, it says so.

**Extends:** `docs/records/2026-07-08-merchant-of-record-legal-review.md` (which asked the fund-holding question and left it open) and `docs/records/2026-09-02-chargeback-terms-counsel-brief.md`.

---

## 1. One sentence

We run a **custodial ledger on top of a single commingled Stripe balance.** Every dollar a buyer pays — for tickets, memberships, door sales, resale — lands in one pot on our platform account, and our own nightly batch decides who gets what and when. Stripe Connect's built-in disbursement is bypassed for that entire leg; Stripe only pays an organiser after we have transferred to them.

The pattern has a name in Stripe's taxonomy: **separate charges and transfers**. It is the DoorDash model. It is sanctioned, with conditions (§5).

## 2. The pot

At any moment the platform Stripe balance contains, indistinguishably:

| What | How much | Tracked on our side? |
| --- | --- | --- |
| Organiser shares not yet transferred | Σ `SETTLEMENT_CREDIT` − debits − holds, matured and unmatured | **Yes** — `PayeeLedgerEntry`, per payee |
| Platform fee revenue | 3.33% of face, capped 50¢/ticket (`platform-fee-policy.ts`) | No — `Order.feesPlatformCents` column, one staff-page sum |
| Collected sales tax | `Order.taxAmountCents` | No ledger, no remittance machinery, no `remittedAt` |
| Membership rolling reserves | 10% → 5% → 0 over 180 days | Counter only — `reserveBalanceCents`, no Stripe-side object |
| Withheld Connect account fees | $2/month per active payee | No |
| PASS_THROUGH processing gross-up | offsets Stripe's deduction, nets ≈ 0 | No |
| `connect_reserved` | Stripe's own hold against connected-account negatives | Stripe-side only |

Minus everything Stripe has debited: its processing fees, every refund, every chargeback and dispute fee.

**Of those rows, exactly one has a ledger.** The platform's own position — what is ours, what is owed, what is held in trust for a taxing authority — is a residue: whatever is left after transfers, derivable only by summing order columns and reconciling against Stripe by hand. There is no `PLATFORM` payee subject type (`enums.prisma:99-102` is `HUMAN | ORGANIZATION`), so the platform cannot appear in its own ledger even in principle.

Memberships, POS, and resale all land in the same pot by explicit decision (`membership-billing-adapter.ts:177-200`, decision D-2026-04-26, `create-resale-checkout.ts:432`). `on_behalf_of` is never set anywhere. `application_fee_amount` is never set anywhere. The platform's cut is "taken implicitly because the funds never leave the platform balance" (`stripe-adapter.ts:664-669`).

## 3. A dollar, end to end

1. **Charge.** Buyer pays `face − discount + platformFee (PASS_THROUGH) + tax + processorGrossUp (PASS_THROUGH) − credits` on a PaymentIntent created on the platform account. Stripe takes ~2.9% + 30¢ off the top. The rest is `pending` on our balance, `available` two business days later.
2. **Finalize.** `payment_intent.succeeded` → splits computed on `amountGross − feesPlatform` (tax and Stripe's fee excluded) across the event's `PayoutTermsLine`s → one `SETTLEMENT_CREDIT` per payee, with `availableAt = max(schedule date, charge + 2 business days)`.
3. **Wait.** The credit sits until it matures. Refunds (`REFUND_DEBIT`) and dispute holds subtract immediately; credits only ever add on maturity. The asymmetry is deliberate — it is what stops a refund-then-payout leak.
4. **Batch.** Nightly at 00:00 CT, `run-batch` sums matured credits per `(payee, currency)`, clamps at zero, skips cells under $10, deducts reserve and the $2 fee, and creates **one Stripe transfer** from the platform's available balance. No `source_transaction`. Withheld cents are simply not sent.
5. **Second hop.** The organiser's connected account pays out to their bank on Stripe's default schedule for it, which we never set.
6. **Residue.** Fee, tax, reserves, and the $2 stay on our balance with no entry anywhere.

## 4. Who is what

Two axes the July memo insisted on keeping separate, and which the code confirms:

**Merchant of record — us.** A card-network concept. The buyer's transaction is with Ithas Fire; our descriptor is on their statement; Stripe debits *our* balance for every refund, chargeback and dispute fee; *we* submit dispute evidence (ADMIN-only, `disputes/evidence/staff.ts:10-16`). The Terms say this correctly since `cd82713a`.

**Possession of funds — also us, functionally.** A money-transmission concept. Stripe is the licensed transmitter, and the design keeps money inside Stripe's perimeter until one of two things moves it out: our transfer to an organiser (fine — that is the point), or **Stripe's automatic payout of our platform balance to our own bank.** The second one is where "we hold funds in Stripe" becomes "we hold third-party funds in our operating account." The test platform account is on `interval: daily`. Live is unverified.

## 5. Stripe's position on the pattern

From `docs.stripe.com/connect/account-balances`, verbatim:

> We recommend that platforms hold funds only when there's a clear purpose and a commitment to transfer them or pay them out when an event occurs or a precondition is satisfied. The typical use case for holding funds is on-demand services platforms, where the marketplace usually waits for the service to be completed and confirmed before paying out to the service provider.
>
> We advise against platforms holding funds arbitrarily… If you aren't sure about holding funds, speak with your legal advisor.

An event ending is the precondition. The schedule options are all "after the event." So the *design* sits inside the sanctioned case. Two things sit outside it: the pot also holds money that is not owed to anyone in particular (tax, reserves, fee), and nothing enforces that the pot can cover what is owed.

Stripe also states the two rules our batch now respects but our documentation used to ignore: a transfer needs available balance or fails, and a failed transfer does not retry itself when funds arrive.

## 6. What the code knows and what it doesn't

**Knows, precisely:** what each payee is owed right now (`listPayableBalances` — a signed sum over matured credits, refund and dispute debits, prior payouts, minus pending holds); what is reserved per payee; what has been transferred and when; that refunds net rather than reverse; that the ledger's own rollups reconcile (`verify-ledger-invariants`, nightly).

**Does not know:**

- The platform's own balance. `balance.retrieve` is called in E2E scaffolding only.
- Total outstanding liability — `Σ payables + Σ reserveBalanceCents + Σ tax held`. Never computed.
- Whether the first covers the second. Never compared. The only signal that they have diverged is a transfer failing with `balance_insufficient`, which as of this week is at least classified and reported rather than anonymous.
- Whether "the withheld cents stay on the platform balance" is true. Asserted in six places (`run-batch.ts:2862`, `:1456`; `connect-account-fee.ts:15`; adapter `payee-ledger.ts:132`; types `payee-ledger.ts:152`; `finance.prisma:570`). Checked in none.
- Whether tax is remitted, or by whom. The specs say we are the marketplace facilitator and owe it; the machinery is "Tier 2, trigger-gated," i.e. unbuilt.

## 7. Where the pot leaks — losses the platform absorbs by design

Each of these is a deliberate rule, and each is a way the pot shrinks without a corresponding ledger entry:

- **Debt is carried, never collected.** A negative payable is filtered out at planning and waits for future sales. No `debit_negative_balances` on connected accounts, no clawback, no charge. A payee who never sells again is a permanent loss. (`run-batch.ts:1044-1053`, docstring `:553-559`)
- **Disputes never reverse a transfer.** A LOST close writes a `DISPUTE_DEBIT` and hopes. Where the payee already refunded the buyer, `cappedByRetained` / `unrecoverablePayeeIds` name the shortfall as platform-absorbed. (`disputes/shared.ts:472-486`)
- **The platform fee is refunded to the buyer on every refund**, and the organiser is never debited for it — the `REFUND_DEBIT` is capped at their post-fee credit. It comes out of our residue. `[REASONED]` from `finalize-from-payment-intent.ts:693-705` + `quote-full-refund.ts:83-88`.
- **Ticketing dispute fees are ours.** Memberships pass the fee to the payee; ticketing does not. (`disputes/shared.ts:259-270`)
- **ABSORB-mode Stripe fees are ours.** The split basis ignores Stripe's deduction, so in ABSORB the platform fee revenue is what shrinks. (`create-checkout.ts:633-652`)
- **Stripe's `connect_reserved`** — when a connected account goes negative, Stripe holds a reserve on *our* available balance to cover it, and after 180 days transfers it to zero the account out.

None of these is wrong. Together they mean the residue is not "fee revenue" — it is fee revenue minus a set of liabilities nobody sums.

## 8. Control points

Everything that moves money, in order of how much it matters:

1. **The nightly batch.** The only thing that ever pays an organiser. Now floored at Stripe's availability window; now classifies a float shortfall distinctly; still has no solvency gate.
2. **The platform account's payout schedule** (Stripe → our bank). Dashboard-only. Test = automatic daily. Live = unverified. This is the setting that decides whether the pot is drained before the batch runs. `docs/runbooks/stripe-platform-payout-settings.md`.
3. **Stripe's availability window.** 2 business days for cards, from creation. ACH's 4 days is already elapsed by `succeeded`. Modelled since this week.
4. **Manual withholding.** Reserves and dispute holds, all ledger-side.

There is no fifth. Nothing gates "can we afford tonight's run" before running it.

## 9. Already-known open items this analysis re-confirms

- **Counsel has never redlined any of it.** Chargeback terms carry `NOT LAWYER-REVIEWED` (`chargeback-terms.ts:46`). The ToS still has `[placeholder]` governing law. The money-transmitter and escheatment questions the July memo raised have no follow-up.
- **The buyer help article contradicts the code.** `help/buying-tickets/refunds-and-cancellations.md:17-18, :47` says booking fees are non-refundable except on organiser cancellation. `quote-full-refund.ts` refunds the platform fee on every refund. One of them is wrong in front of buyers.
- **Resale release window is stamped but never read.** `create-resale-checkout.ts:390` writes `resalePayoutReleaseAt`; `create-credits-from-order.ts` computes `availableAt` with no resale branch. `[REASONED]` — the 7-day resale hold documented in the port is not enforced.
- **`PayoutTermsLine.ticketTypeId` is ignored at settlement.** `listLines` returns every line; `computeOrderSplits` never filters. Either dead or inconsistent with wherever it is edited.
- **Tax is held and never remitted** by any code path.

## 10. The honest framing

The pattern is legitimate, common, and explicitly described by Stripe. What makes *this* instance fragile is not the pattern. It is that the platform side of the ledger does not exist. We have exact accounting of what we owe each organiser and no accounting of what we have — the pot is a single number that Stripe knows and we never ask for. Every safety property of the settlement design (reserves stay, withheld cents stay, debt carries forward, refunds net) is an assertion about a balance the code has never read.

The two cheapest things that would change that: read the balance and compare it to total liability (a solvency check, one job), and set the platform payout schedule to manual until real volume exists. Neither is built. The first is a small use case; the second is a dashboard click.
