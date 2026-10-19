# Stripe restricted key — required scopes

`STRIPE_SECRET_KEY` in prod is a **restricted** key (`rk_live_…`), not a standard
`sk_live_…`. Restricted keys grant per-resource permissions, and **Stripe reports a
missing permission at call time, not at boot** — `apps/api/src/lib/env.ts` validates
`STRIPE_SECRET_KEY` as `z.string().min(1)` and cannot check scope. An under-scoped key
therefore boots perfectly and then fails mid-checkout, mid-onboarding, or inside a
settlement transfer.

**If you add a new Stripe SDK call, add its permission here and to the live key.**
Nothing enforces this list automatically.

## Current scopes (22)

Every **Connect Permissions** column is deliberately `None`. The integration is
separate-charge-and-transfer and runs entirely on the platform account — no
`stripeAccount` request option, no destination charges, no `application_fee_amount`
(see `stripe-adapter.ts:107` and `:640`). Connected-account operations are *platform*
Connect calls, which live under the Connect section's single column.

| Section | Resource | Perm | Required by |
| --- | --- | --- | --- |
| Core | Balance | Read | `balance.retrieve` (e2e routes only) |
| Core | Charges and Refunds | Write | `charges.create/retrieve`, `refunds.create/list` |
| Core | Customers | Write | `customers.create/search` |
| Core | Files | Write | `files.create` (dispute evidence) |
| Core | Payment Disputes | Write | `disputes.retrieve/update/list` |
| Core | Payment Intents | Write | `paymentIntents.create/retrieve/cancel/confirm` |
| Core | Payout Settings | Read | payout schedule reads |
| Core | Payouts | Write | payout management |
| Core | Products | Write | `products.create/update/search` |
| Billing | Customer Portal | Write | `billingPortal.sessions.create` |
| Billing | Invoices | Read | membership invoice webhooks |
| Billing | Prices | Write | `prices.create` |
| Billing | Subscriptions | Write | `subscriptions.create/retrieve/update/cancel` |
| Billing | Tax Rates | Write | `taxRates.create` |
| Connect | Accounts | Write | `accounts.create/retrieve` |
| Connect | Account Links | Write | `accountLinks.create` (onboarding) |
| Connect | Login Links | Write | `accounts.createLoginLink` (`createConnectLoginLink`) |
| Connect | Transfers | Write | `transfers.create/createReversal/retrieve/listReversals` |
| Tax | Tax Calculations, Transactions | Write | `tax.calculations.create` |
| Terminal | Connection Tokens | Write | `terminal.connectionTokens.create` |
| Terminal | Locations | Write | `terminal.locations.create` |
| Terminal | Readers | Write | `terminal.readers.create/del/retrieve/cancelAction/processPaymentIntent` |

Stripe's `Write` includes read on the same resource, so `*.search` / `*.list` /
`*.retrieve` need no extra entry where Write is already granted.
`webhooks.constructEvent` is a local signature check and needs no permission.

## Where the calls live

Only four runtime files construct a Stripe client:

- `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts`
- `packages/adapters/src/payment-processors/stripe/membership-billing-adapter.ts`
- `apps/api/src/routes/stripe/webhook.ts` — the dispatcher calls `refunds.list` (:738)
  and `charges.retrieve` (:1036)
- `apps/api/src/routes/e2e.ts`, `routes/e2e/stripe.ts` — **test routes only**

`packages/core` makes no Stripe calls (hexagonal boundary). `apps/jobs` makes none
directly — it goes through the same adapter, so it needs no separate scope today.
The five files in `events/handlers/` make no Stripe API calls.

## Known loose ends

- **Webhook endpoint API version drift.** Both live endpoints (`playful-serenity`
  platform, `whimsical-dream` connect) serialize at `2026-04-22.dahlia`, while the app
  pins `STRIPE_API_VERSION=2025-08-27.basil`. Stripe fixes an endpoint's version at
  creation and the dashboard renders it read-only, so changing it means recreating the
  endpoints — which rotates their signing secrets.
- **A standard key would also have been defensible.** Write is granted on 15 resource
  groups, so the blast-radius reduction is modest. The real win available later is
  splitting `hf-prod-jobs` onto its own narrower key.

## If you split jobs onto its own key

`apps/jobs` drives Connect reconciliation, expired-cart PI cancellation, and settlement
transfers. A jobs key needs roughly: Payment Intents (Write), Transfers (Write),
Connect Accounts (Read), Charges and Refunds (Read). Verify against the adapter before
trusting that list.
