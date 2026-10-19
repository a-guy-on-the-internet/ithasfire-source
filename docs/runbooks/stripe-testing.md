# Stripe testing (local, CI, and live)

This doc describes how we test Stripe behavior in Ithas Fire.

## Summary

Stripe is tested at three layers:

1. **Core/use-case tests**: business logic against a fake payments port (free checkout skips Stripe, paid checkout requires a Ready payee, idempotency behavior).
2. **Adapter E2E test**: the real Stripe SDK against stripe-mock, checking request shape and headers without reaching Stripe.
3. **Playwright e2e**: the browser and API against **real Stripe test mode**, which is the harness default (`apps/web/playwright.config.ts`). Webhooks reach the local API through `stripe listen`. `.github/workflows/e2e.yml` runs an allowlist of Playwright specs nightly and on dispatch with `STRIPE_SECRET_KEY` deliberately unset (the API falls back to `MissingStripePaymentProcessor`), so no CI job runs a spec against Stripe.

There is no staging suite against a deployed API yet.

## Adapter E2E test (stripe-mock)

We use **stripe-mock** (a local HTTP stub for the Stripe API) to exercise the real Stripe Node SDK from our adapter.

- Test file: `packages/adapters/src/payment-processors/stripe/__tests__/stripe-adapter.e2e.test.ts`
- What it asserts:
  - PaymentIntent is created and returns `{ id, clientSecret }`
  - `destinationAccountId` is stored in metadata (not `transfer_data.destination`)
  - `Idempotency-Key` header is sent (validated by intercepting the outgoing Node HTTP request)

### Local infra

`stripe-mock` is included in `infra/docker/docker-compose.yml` as a service listening on:

- `http://localhost:12111`

### Running the adapter E2E test

Run from repo root:

```zsh
pnpm -C packages/adapters exec vitest --run src/payment-processors/stripe/__tests__/stripe-adapter.e2e.test.ts
```

Notes:

- The test will no-op/skip if Docker isn't available.
- If `infra` compose is already running, the test will reuse the existing `stripe-mock` container.

## Webhooks: can Stripe hit localhost?

Not directly.

Stripe's webhook delivery service cannot reach `http://localhost:...` on your machine.

### Local webhook testing options

#### Option A: Stripe CLI forwarding (recommended for local dev)

The Stripe CLI receives events over the internet and forwards them to the local API.

```zsh
pnpm stripe:listen:bg        # start, logs under logs/dev/stripe
pnpm stripe:listen:bg:status
pnpm stripe:listen:bg:stop
```

`scripts/start-stripe-listen-detached.cjs` forwards to `http://localhost:3001/webhooks/stripe` (override with `STRIPE_LISTEN_FORWARD_TO`). It cannot hand its signing secret to the detached API, which reads `STRIPE_WEBHOOK_SECRET` from `apps/api/.env.local`; the script compares the two and warns on a mismatch, which otherwise shows up as every delivery failing signature verification.

The route is `POST /webhooks/stripe` (`apps/api/src/routes/stripe/webhook.ts`, registered in `apps/api/src/app.ts`). It is the one endpoint for both platform and connected-account events and accepts a signature from either `STRIPE_WEBHOOK_SECRET` or `STRIPE_CONNECT_WEBHOOK_SECRET`.

#### Option B: Public staging URL

Deploy the API somewhere publicly reachable (staging) and configure Stripe's dashboard webhook endpoint to point to that URL.

This is the best match for production behavior and is what we'll use for true "live tests".

## Playwright e2e against real Stripe (test mode)

The harness passes `STRIPE_SECRET_KEY` (or `PLAYWRIGHT_STRIPE_SECRET_KEY`) to the API it starts and sets no `STRIPE_BASE_URL`, so the SDK talks to real Stripe. Setting `STRIPE_BASE_URL` or `PLAYWRIGHT_STRIPE_BASE_URL` (e.g. `http://127.0.0.1:12111`) points it at stripe-mock instead. A spec confirms a PaymentIntent with `confirmStripePaymentIntent` (`apps/web/e2e/helpers/stripe-webhook.ts`, test payment method `pm_card_bypassPending`), then waits for `payment_intent.succeeded` to arrive through `stripe listen` and the order to reach `SUCCEEDED`. Seeds use the connected account in `E2E_STRIPE_ACCOUNT_ID` when set.

The money specs call `resetE2eState()`, which deletes every order, event, org and auth user in the database the API points at. Read "Run It" in `CLAUDE.md` before running one.

The step-by-step for the checkout pricing spec is `docs/runbooks/e2e-checkout-pricing.md`.

## E2E Tests Requiring Stripe Transfers (Connect)

Some E2E tests validate the full money flow including **Stripe Connect transfers** to connected accounts (organizer payouts). These tests include:

- `apps/web/e2e/full-money-flow.spec.ts`
- `apps/web/e2e/item-level-settlements.spec.ts`

### The "Insufficient Funds" Problem

Stripe Connect transfers require **available funds** in your platform account. Even in test mode, you need actual test funds to execute transfers. The error looks like:

```text
TRPCClientError: You have insufficient available funds in your Stripe account.
Try adding funds directly to your available balance by creating Charges using
the 4000000000000077 test card.
```

### Adding Test Funds via E2E Endpoint

`apps/api/src/routes/e2e/stripe.ts` adds funds to the platform test balance:

```text
POST /e2e/stripe/add-test-funds
Headers: x-e2e-reset-secret: <your-e2e-secret>
Body: { "amountCents": 100000, "currency": "usd" }   (both optional; these are the defaults)
```

It creates one charge with `source: "tok_bypassPending"` (the token form of the bypass-pending test card the error above names), reads the balance once without waiting, and returns `{ ok, chargeId, amountCents, currency, availableBalance }`. It needs `STRIPE_SECRET_KEY` on the API.

Specs use `ensureStripeTestFunds` (`apps/web/e2e/helpers/stripe-test-funds.ts`), as `full-money-flow`, `item-level-settlements`, `event-cancellation-refund` and `lifecycle-journey` do. It reads the balance first through `GET /e2e/stripe/balance` and calls the lower-level `addStripeTestFunds` (the POST above) only when the balance is short; it returns whether enough is available:

```typescript
const hasFunds = await ensureStripeTestFunds(request, apiBaseUrl, requiredCents);
```

**Manual fund addition:**

You can also add funds manually via Stripe Dashboard or CLI:

```bash
# Using Stripe CLI
stripe charges create --amount=100000 --currency=usd --source=tok_bypassPending

# Or create a PaymentIntent with the special test card
stripe payment_intents create --amount=100000 --currency=usd \
  --payment-method-types=card --confirm=true \
  --payment-method=pm_card_bypassPending
```

### Checking Your Balance

Use the balance endpoint to verify funds are available before running transfer tests:

```text
GET /e2e/stripe/balance
Headers: x-e2e-reset-secret: <your-e2e-secret>
```

Returns:

```json
{
  "ok": true,
  "available": [{ "amount": 100000, "currency": "usd" }],
  "pending": [{ "amount": 0, "currency": "usd" }]
}
```

### Best Practices for Transfer Tests

1. **Check balance before transfers**: Always verify sufficient funds exist before attempting transfers
2. **Use the E2E endpoint**: Call `/e2e/stripe/add-test-funds` at the start of transfer-heavy test suites
3. **Consider stripe-mock**: For unit/integration tests that don't need real Stripe behavior, use stripe-mock (see above)
4. **Isolate transfer tests**: Group transfer tests together so fund addition happens once per suite, not per test
