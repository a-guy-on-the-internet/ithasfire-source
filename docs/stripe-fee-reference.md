# Stripe Fee Reference

**Spec:** `docs/specs/2026-08-05/completed/recurring-memberships.spec.md` (acceptance criterion: "fee reference records the Stripe numbers this spec depends on, each with a source URL and a checked-on date")
**Why this exists:** the memberships money model (the $2 payout deduction, reserve sizing, break-even-vs-Patreon table) leans on specific Stripe numbers. When one of them moves, the code and the venue-facing copy must move with it. Each row below is a load-bearing dependency; re-check on the cadence noted.

## The numbers

| Fee | Value | Where it lands in code / copy | Source | Checked |
| --- | --- | --- | --- | --- |
| Connect Express active-account fee | **$2/month per account, only in months the account receives a payout.** Dormant accounts free. | `FeePolicy.connectAccountFeeCents` (default 0 = recovery off). To enable, set `connectAccountFeeCents: 200` in `PLATFORM_FEE_POLICY` (`packages/core/src/lib/pricing/platform-fee-policy.ts`); it ships on the next deploy, which reconciles the GLOBAL row from that constant field by field (`/platform/fees` is read-only) → `computeConnectAccountFeeDeduction` in `packages/core/src/use-cases/settlements/connect-account-fee.ts`; venue-facing copy in admin memberships setup + help article. Not `FeePolicy.monthlyPayoutCents` (also 200), which is carried in the pricing inputs but read by no arithmetic. | https://stripe.com/connect/pricing | 2026-08-08 |
| Connect payout fee | 0.25% + $0.25 per payout | Absorbed by platform; part of the "pass through what Stripe charges" envelope. `FeePolicy.payoutPct` (0.0025) and `payoutFixedCents` (25) store it (`packages/core/src/lib/pricing/platform-fee-policy.ts`), but no pricing or payout arithmetic reads them. | https://stripe.com/connect/pricing | 2026-08-08 |
| Stripe Billing | 0.7% of recurring volume (consolidated Jul 2024; was 0.5/0.8 split) | Absorbed; justifies "Card Account Updater alone justifies the surcharge" decision in the memberships design memory | https://stripe.com/billing/pricing | 2026-08-08 |
| Card processing (US domestic) | 2.9% + $0.30 | `FeePolicy.processsorFeePct` (the triple-s typo is the real column name) and `processorFixedCents`, GLOBAL defaults in `packages/core/src/lib/pricing/platform-fee-policy.ts`. Every primary sale (`createCheckout`) is grossed up at this card rate, whatever the payment method, once per order by `solveProcessingFeeGrossUp` (`checkout-helpers.ts` → `price-cart.ts`), not per ticket. Resale (`createResaleCheckout`) is grossed up the same way: `solveResaleCharge` (`packages/core/src/lib/pricing/resale-charge.ts`) wraps the primary path's joint tax and processing solve, so processing covers basis + tax, at the two rate fields of the fee policy the listing froze (`processingFeeConfigRef`). The listing stores the zero-tax figure in `processingPassThroughCents` for display only; the readers re-derive it from the frozen policy, and checkout never reads it. The per-method table `PROCESSING_COST_SCHEDULE` (`packages/core/src/lib/pricing/processing-cost-schedule.ts`) is display-only: its one consumer, `get-checkout-fee-rates.ts`, builds the per-method labels the checkout summary shows. Also the memberships owner-nets examples ($10 tier → ~$9.14 at 10 members). | https://stripe.com/pricing | 2026-08-08 |
| ACH Direct Debit (`us_bank_account`) | 0.8%, capped at $5.00, no fixed fee | Display only, in `PROCESSING_COST_SCHEDULE` (`packages/core/src/lib/pricing/processing-cost-schedule.ts`). ACH buyers are charged the card rate, on primary sales and resale alike. | https://stripe.com/pricing | **UNVERIFIED** (value as coded; never re-checked against Stripe) |
| Stripe Tax Basic | 0.5% per transaction where registered; **$0 while registered nowhere**; no monthly fee | NOT used — rejected on cost *shape* (0.5% of GMV is a tax on growth). ZipTax decides every rate. Revisit only for *filing* (Tax Complete ~$90/mo) at ~4 registered states. `automatic_tax` is never sent to Stripe; the word appears only in the warning comment in `packages/adapters/src/payment-processors/stripe/membership-billing-adapter.ts`, where memberships use plain Stripe `TaxRate` objects carrying ZipTax's rate. | https://stripe.com/tax/pricing | 2026-08-08 |
| **Dispute fee** | **~$15 — ASSUMED, NOT VERIFIED.** The spec's reserve sizing and the "one dispute erases 30 tickets of platform revenue" arithmetic use $15. Stripe's published US card-network dispute fee has historically been $15, but the number on our own invoices is the only one that counts (network + account-type variations exist). | `Dispute.feeCents` is *captured from the wire* (`dispute.balance_transactions[].fee`) so the code is correct regardless — only the *sizing assumptions* lean on $15. Membership LOST disputes debit the fee to the payee; ticketing absorbs it. | **TODO: verify against a real Stripe invoice in the Dashboard (Billing → Invoices on the platform account), or the first live dispute's `balance_transactions`. Requires dashboard access.** | **UNVERIFIED** |

## Comparison anchors (venue-facing pitch math)

| Competitor | Effective take | Source | Checked |
| --- | --- | --- | --- |
| Patreon (post-Aug-2025) | flat 10% platform + 2.9% + $0.30 processing (5% + $0.10 on pledges ≤ $3); payout $0.25 US; 2.5% FX ⇒ **13–19% effective, worst at $3–$5 tiers** | https://support.patreon.com/hc/en-us/articles/11111747095181 | 2026-08-07 |
| Ko-fi | 5% free tier / 0% on Gold ($6/mo) | https://ko-fi.com/gold | 2026-08-07 |
| Buy Me a Coffee | flat 5% | https://buymeacoffee.com | 2026-08-07 |

Break-even vs Patreon on a $10/mo tier: **2 members** (monthly payouts, $2 deducted only in ticket-free months). From the first member for anyone whose ticket revenue already settles that month.

## Re-check cadence

- **Before any venue outreach that quotes numbers** (the pitch table above).
- **When Stripe emails a pricing update** for Connect/Billing.
- **Dispute fee: at the first real dispute or first dashboard invoice review** — then replace the UNVERIFIED row above and re-run the reserve-sizing sanity check in the spec (`~5 disputes/yr ≈ $125/yr at 200 members`).
