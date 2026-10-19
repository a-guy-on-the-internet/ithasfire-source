# E2E Testing Strategy: Paid Checkout Flow

How `apps/web/e2e/checkout-pricing-validation.spec.ts` checks that one price holds across the paid checkout pipeline, from seed data to minted tickets, and how to run it.

## Overview

The spec needs **real Stripe test mode**. It reads the PaymentIntent back with its own `new Stripe(STRIPE_SECRET_KEY)` client, which always talks to real Stripe, so it cannot pass against stripe-mock. It runs only in the `guest` Playwright project; the `chromium` project skips it.

**It wipes the database.** `beforeEach` calls `resetE2eState()`, which deletes every order, event, org and auth user in the database the API points at. Under `E2E_USE_LIVE_STACK=1` that call fails fast unless `E2E_ALLOW_LIVE_RESET=1` is set too. There are two ways to run it. The default harness starts its own API through `scripts/wait-api-healthy.cjs` and resets the local dev database first (`prisma migrate reset --force`); Prisma's agent guardrail refuses that reset, and an agent that reaches it stops and asks the owner. The other is the isolated stack described below, which leaves the dev database alone. See "Run It" in `CLAUDE.md`.

## Prerequisites

### Local Infrastructure

```bash
# Postgres, Redis, Mailpit (the spec reads the verification code), stripe-mock, …
cd infra/docker && docker compose up -d
```

The harness starts the API itself. It reuses a web server already on `http://localhost:3000` and otherwise starts `pnpm web:dev:local`.

### Stripe

1. `STRIPE_SECRET_KEY` must be a test-mode key (`sk_test_…`). `apps/web/playwright.config.ts` loads `apps/api/.env.local`, so the key there reaches both the spec and the API it starts.
2. The API it starts talks to real Stripe unless `STRIPE_BASE_URL` is set. If `apps/api/.env.local` sets `STRIPE_BASE_URL` to stripe-mock, run with `PLAYWRIGHT_STRIPE_BASE_URL=""`: an empty string, not unset, is what overrides it.
3. Forward webhooks so `payment_intent.succeeded` reaches the API:

   ```bash
   pnpm stripe:listen:bg       # forwards to http://localhost:3001/webhooks/stripe, logs under logs/dev/stripe
   pnpm stripe:listen:bg:stop
   ```

   `STRIPE_WEBHOOK_SECRET` in `apps/api/.env.local` must match the listener's secret; the start script warns when it doesn't.

### Environment Variables

All have working defaults except the Stripe key.

```bash
STRIPE_SECRET_KEY=sk_test_...                 # required
E2E_RESET_SECRET=playwright-reset-secret      # default
E2E_API_BASE_URL=http://localhost:3001        # default
PLAYWRIGHT_BASE_URL=http://localhost:3000     # default
E2E_STRIPE_ACCOUNT_ID=acct_...                # optional: the connected account the seed uses
PLAYWRIGHT_STRIPE_BASE_URL=                   # only to override a STRIPE_BASE_URL in .env.local
```

## Test Flow (10 Phases)

### Phase 1: Seed Event with Explicit Price

The test seeds an event via `POST /e2e/seed/paid-checkout` (`apps/api/src/routes/e2e/seed-paid-checkout.ts`) with `priceCents: 4200` ($42.00). This creates:

- Human (the org's member, with a password sign-in)
- Organization, with the current chargeback terms accepted
- Fee Policy: the GLOBAL `PLATFORM_FEE_POLICY` (`packages/core/src/lib/pricing/platform-fee-policy.ts`) via `seedFeePolicy`
- Payout terms (one PRIMARY line, 100% to the org payee)
- Payee (`ACTIVE`, charges and payouts enabled, on `E2E_STRIPE_ACCOUNT_ID` or the route's default test account)
- Event (PUBLISHED), with Nashville, TN address text but no postal code, Place or saved location (so no tax situs; see the formula below), and no `admissionTaxRateBps` unless the body passes one
- TicketType (with explicit priceCents)

### Phase 2: Create & Authenticate Buyer

A separate buyer signs up through the UI, verifies their email with the 6-digit code read from Mailpit (`verifySignUpOtp`), and signs in through the UI. `signInAndGetToken` (`apps/web/e2e/helpers/trpc.ts`) then gets a JWT, and the tRPC client sends it as a bearer token.

### Phase 3: Validate listEventTicketTypes

Query `events.listEventTicketTypes` via tRPC and assert that the ticket type's `priceCents` matches the seeded value.

```typescript
const ticketTypesRes = await trpc.events.listEventTicketTypes.query({ eventId });
expect(targetTicketType.priceCents).toBe(TICKET_PRICE_CENTS);
```

### Phase 4: Hold Tickets

Call `orders.updateOrderItems` to hold tickets server-side:

```typescript
const holdResult = await trpc.orders.updateOrderItems.mutate({
  eventId: seed.eventId,
  items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
});
```

### Phase 5: Create Checkout

Call `orders.createCheckout` to create the order and PaymentIntent. The server takes the buyer from the session; the procedure's input omits `actorHumanId` and `buyerHumanId`, and there is no `currency` input.

```typescript
const checkoutResult = await trpc.orders.createCheckout.mutate({
  eventId: seed.eventId,
  clientKey: `e2e-pricing-${Date.now()}`,
  termsAccepted: true,          // else TERMS_REQUIRED
  refundPolicyAccepted: true,   // else REFUND_POLICY_REQUIRED
  items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
});
```

### Phase 6: Validate Stripe PaymentIntent Amount

Retrieve the PaymentIntent from Stripe and compare its amount with the expected buyer total (formula below):

```typescript
const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
expect(paymentIntent.amount).toBe(expectedTotal);
```

### Phase 7: Confirm Payment

Confirm the PaymentIntent with the test payment method `pm_card_bypassPending`:

```typescript
await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });
```

Stripe delivers `payment_intent.succeeded` to the API through `stripe listen`.

### Phase 8: Poll for Order Success

Poll `orders.getMyOrder` until the order status becomes `SUCCEEDED`:

```typescript
await expect.poll(async () => {
  const order = await trpc.orders.getMyOrder.query({ orderId });
  return order.status;
}).toBe("SUCCEEDED");
```

### Phase 9: Validate Order Pricing

Verify that `getMyOrder` returns the correct pricing breakdown. The order carries one ticket item per ticket (each `qty` 1, `amountCents` equal to the unit price), not one item with `qty` 2:

```typescript
expect(orderDetails.amountGrossCents).toBe(expectedSubtotal);
expect(orderDetails.feesPlatformCents).toBe(expectedPlatformFee);
```

### Phase 10: Verify Tickets Minted

Query `orders.listMyOrderTickets` and verify the correct number of tickets exist:

```typescript
const ticketsRes = await trpc.orders.listMyOrderTickets.query({ orderId });
expect(ticketsRes.tickets.length).toBe(QTY);
```

## Fee Calculation Reference

Every sale is priced **PASS_THROUGH** (`SALE_FEE_MODE`), whatever the policy row says. The seeded policy is `PLATFORM_FEE_POLICY`:

| Parameter | Value |
| --------- | ----- |
| `buyerFeePct` | 3.33% (0.0333) |
| `maxFeeCents` | 50 (per-ticket cap) |
| `minFeeCents` | 0 |
| `platformFixedCents` | 0 |
| `maxPlatformFeeCents` | null (no order-level cap) |
| `processsorFeePct` | 2.9% (0.029); the triple-s is the real field name |
| `processorFixedCents` | 30 (once per order) |

### Formula

What checkout charges (`priceComputedCart` in `packages/core/src/use-cases/orders/_shared/price-cart.ts`):

```text
platformFee  = max(min(round(unitPrice × 0.0333), 50) + 0, 0)   [per ticket: computePlatformFeePerTicketCents]
net          = Σ (unitPrice + platformFee) × qty  + tax
processorFee = solveProcessingFeeGrossUp(net, 0.029, 30)          [once per order]
buyerTotal   = net + processorFee
```

`solveProcessingFeeGrossUp` (`packages/core/src/lib/pricing/processing-cost-schedule.ts`) finds the smallest charge that still leaves `net` after Stripe takes `ceil(charge × 2.9%) + 30¢`. It is not `round(net × 2.9%) + 30`. With the seed's defaults the order carries no tax. The route creates the event with no `placeId`, no `savedLocationId` and no postal code (the body's `location` has no postal-code field), so `eventTaxRateLocationRef` returns null and the order's tax situs is always null, whatever address text it carries. A seeded `admissionTaxRateBps` is therefore charged on the ticket face (`resolveTaxableBase(null)` is `TICKET_FACE`) and raises the unruled-taxable-base report on every checkout. Testing Tennessee's buyer-total base needs a seed with a resolvable location: a postal code plus country, or a Place.

### Example ($42.00 ticket, qty 2, no tax)

```text
platformFee  = min(round(4200 × 0.0333), 50) = 50 cents
net          = (4200 + 50) × 2 = 8500 cents
processorFee = 285 cents  (charge 8785: ceil(8785 × 0.029) + 30 = 285, and 8785 − 285 = 8500)
buyerTotal   = 8785 cents
```

## Running the Test

From `apps/web`, on the default (wiping) harness:

```bash
pnpm exec playwright test e2e/checkout-pricing-validation.spec.ts --project=guest --reporter=list

# headed, for debugging
pnpm exec playwright test e2e/checkout-pricing-validation.spec.ts --project=guest --headed
```

## Running on an isolated stack (shared dev database untouched)

Use this when other sessions are using the dev stack. It runs `checkout-pricing-validation.spec.ts` and `checkout-journey.spec.ts` against a second API, web server, database and mail catcher, so `resetE2eState()` and `mailpit.clear()` only reach the copies. First run 2026-10-10: both specs passed and the dev database kept its rows.

1. **Checkout of the commit under test**, with its own dependencies. A worktree keeps other sessions' uncommitted work out of the run and gives the second `next dev` its own `.next` (two dev servers cannot share one):

   ```bash
   git worktree add --detach <dir> HEAD
   cd <dir> && pnpm install --frozen-lockfile --prefer-offline
   pnpm -F @th/db run generate && pnpm -F @th/ui-email build
   ```

2. **Database.** Create one on the dev Postgres and migrate it with `deploy`, never `reset`:

   ```bash
   psql 'postgresql://postgres:postgres@[::1]:5432/postgres' -c 'CREATE DATABASE e2e_isolated'
   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/e2e_isolated?schema=public' pnpm exec prisma migrate deploy
   ```

   Check the `Datasource "db"` line it prints names your database. Node's `pg` rejects `[::1]` in `DATABASE_URL`, so the API's URL uses `localhost`; the database name is what keeps a wipe off `dev`.

3. **Mail.** `docker run -d --name e2e-mailpit -p 1026:1025 -p 8026:8025 axllent/mailpit:latest`

4. **Env.** Copy `apps/api/.env.local` and `apps/web/.env.local` into the worktree and edit the copies. The API loads its `.env.local` with `override: true`, so values passed on the command line lose to the file. In the API copy add `PORT=3411` and `DATABASE_URL` (step 2; neither line exists there, because `DATABASE_URL` normally comes from the root `.env.local`, which the worktree does not have), and set `REDIS_URL` to a spare Redis db number, `SMTP_PORT=1026`, `E2E_RESET_SECRET=playwright-reset-secret`, `PUBLIC_WEB_URL` / `CORS_ALLOWED_ORIGINS` / `BETTER_AUTH_TRUSTED_ORIGINS` to `http://localhost:3410`, and `APP_BASE_URL` plus the four `BETTER_AUTH_*` URLs to `http://localhost:3411`. Delete the `MEILISEARCH_*`, `SENTRY_DSN` and `STRIPE_BASE_URL` lines (an empty `MEILISEARCH_HOST` fails env validation; a deleted one turns search off, which keeps e2e events out of the shared index). In the web copy set `NEXT_PUBLIC_API_BASE_URL=http://localhost:3411`.

5. **Stripe listener**, forwarding to the second API. Put the secret it prints in the API copy's `STRIPE_WEBHOOK_SECRET`. The key is the `sk_test_…` value of `STRIPE_SECRET_KEY` in `apps/api/.env.local`; it is not in your shell unless you export it:

   ```bash
   stripe listen --api-key "$STRIPE_SECRET_KEY" --forward-to http://localhost:3411/webhooks/stripe
   ```

   Stripe sends each event to every listener on the account. If `pnpm stripe:listen:bg:status` shows the dev listener running, the dev API also receives this run's `payment_intent.succeeded` events and logs `ORDER_NOT_FOUND` for them. Either accept that noise or run while the dev listener is stopped.

6. **Servers**, from the worktree. Start the API without `watch`, so nobody's edit restarts it mid-run:

   ```bash
   (cd apps/api && pnpm exec tsx src/index.ts)
   PORT=3410 NEXT_PUBLIC_SITE_URL=http://localhost:3410 node scripts/run-web-dev.cjs --base http://localhost:3411
   ```

   Without `NEXT_PUBLIC_SITE_URL` the web server takes its own origin to be `:3000`, `/api/events/<id>/viewer-state` answers 403, and the console-error fixture fails the spec. Use `localhost`, not `127.0.0.1`.

7. **Check the target, then run.** `E2E_ALLOW_LIVE_RESET=1` switches off the only guard against a wipe, so first confirm the second API is the one on your database: `curl -s localhost:3411/health` answers, and this query, which counts the second API's connections to your database, prints a number above 0:

   ```bash
   psql 'postgresql://postgres:postgres@[::1]:5432/postgres' -Atc "select count(*) from pg_stat_activity where datname = 'e2e_isolated'"
   ```

   Then, from the worktree's `apps/web`. The specs take the API from `E2E_API_BASE_URL`, then `PLAYWRIGHT_API_BASE_URL`, and only then fall back to `:3001`, the dev API; set both:

   ```bash
   E2E_USE_LIVE_STACK=1 E2E_ALLOW_LIVE_RESET=1 \
   PLAYWRIGHT_BASE_URL=http://localhost:3410 PLAYWRIGHT_API_BASE_URL=http://localhost:3411 \
   E2E_API_BASE_URL=http://localhost:3411 MAILPIT_API_URL=http://127.0.0.1:8026 \
   pnpm exec playwright test e2e/checkout-pricing-validation.spec.ts e2e/checkout-journey.spec.ts \
     --project=guest --workers=1 --reporter=list
   ```

   The first run after the web server starts can fail on a console 500 while routes compile; run it again before reading anything into it.

8. **Tear down.** Stop the three processes you started by PID, then `docker rm -f e2e-mailpit`, `DROP DATABASE e2e_isolated`, and `git worktree remove <dir>`.

## Troubleshooting

### PaymentIntents Not Showing in Stripe Dashboard

The API is on stripe-mock: `STRIPE_BASE_URL` reached it, most likely from `apps/api/.env.local`. Re-run with `PLAYWRIGHT_STRIPE_BASE_URL=""`.

### Webhook Not Received / Order Stuck in PENDING

Check that `pnpm stripe:listen:bg:status` shows the listener running, forwarding to `http://localhost:3001/webhooks/stripe`, and that its secret matches `STRIPE_WEBHOOK_SECRET` in `apps/api/.env.local`. Then read the API log for webhook handler errors:

```bash
tail -f logs/dev/api/*.log
```

### Price Mismatch

If the Stripe PaymentIntent amount doesn't match the spec's expectation:

1. Check `PLATFORM_FEE_POLICY` for changed rates; the spec derives its numbers from it.
2. Check the pricing path: `computeOrderAmounts` (`packages/core/src/use-cases/orders/checkout-helpers.ts`) for the platform fee, `priceComputedCart` (`price-cart.ts`) and `solveTaxLinesAndProcessorFee` (`packages/core/src/lib/pricing/solve-tax-and-processor-fee.ts`) for tax and the processing fee.

### Stripe Connected Account Error

The seed uses `E2E_STRIPE_ACCOUNT_ID`, else a hard-coded test account in `seed-paid-checkout.ts`. If you see "No such destination", make sure that account exists in your Stripe test mode, or set `E2E_STRIPE_ACCOUNT_ID`.
