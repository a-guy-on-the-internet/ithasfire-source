# E2E Tests

This directory contains Playwright end-to-end tests for the Ithas Fire web app.

## Read this first: the default run WIPES your dev database

Without `E2E_USE_LIVE_STACK=1`, Playwright boots its own API and runs `prisma migrate reset --force` against the database that API points at. Many specs also call `resetE2eState()` in `beforeEach`, which deletes every order, event, org and auth user in that database.

To run against the stack you already have up (web on :3000, API on :3001) and keep your seed data:

```bash
cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test e2e/<spec>.spec.ts --project=chromium --reporter=list
```

- Under `E2E_USE_LIVE_STACK=1` the specs that call `resetE2eState()` (about 54) fail fast instead of wiping. Set `E2E_ALLOW_LIVE_RESET=1` as well only when you want the live stack wiped (`e2e/helpers/e2e-reset.ts`).
- Your database is not pristine in this mode, so fixture-dependent specs can fail, and any spec you run must clean up what it creates. Use the default (wiping) path for money, settlement and journey suites, against a throwaway database.
- `fullyParallel: true` is on. Specs that mutate the same account collide and the failure looks like a product bug. Pass `--workers=1` when running more than one spec that touches shared account state (the two passkey specs, for example).
- Never set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`. If a reset seems necessary, stop and ask.

## Prerequisites

Before running E2E tests, ensure you have the following services running:

1. **PostgreSQL** - Local database (via Docker Compose)
2. **Redis** - For session/cache (via Docker Compose)
3. **Mailpit** - For email verification testing (via Docker Compose)

Start infrastructure:

```bash
cd infra/docker && docker compose up -d
```

## Required Environment Variables

E2E tests require certain environment variables. Create or update your `.env.local` files:

### `apps/api/.env.local`

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public

# Stripe (use your Stripe TEST mode keys)
STRIPE_SECRET_KEY=sk_test_xxx...
STRIPE_PUBLISHABLE_KEY=pk_test_xxx...
STRIPE_WEBHOOK_SECRET=whsec_xxx...  # From `stripe listen`

# E2E Reset Secret (allows /e2e/reset endpoint)
E2E_RESET_SECRET=playwright-reset-secret

# Redis
REDIS_URL=redis://127.0.0.1:6379

# Email (Mailpit)
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=0
SMTP_DEFAULT_FROM_EMAIL=no-reply@ithasfire.local
```

### `apps/web/.env.local`

```bash
WEB_API_BASE_URL=http://localhost:3001

# Stripe (for E2E tests that need direct Stripe API access)
STRIPE_SECRET_KEY=sk_test_xxx...
```

## Running Tests

Run these from `apps/web` and put flags straight after the script name. Do not add a `--` separator: Playwright then treats everything after it as a file filter, so `--project=guest` or `--workers=1` is silently ignored.

Every command below takes the default path and wipes the dev database. That is deliberate: the full suite and the guest project include the specs that call `resetE2eState()`, `my-tickets-refund.spec.ts` among them, and under `E2E_USE_LIVE_STACK=1` those fail fast instead of running. For a spec that does not reset, use the live-stack command at the top of this file.

### Run all E2E tests

```bash
cd apps/web && pnpm test:e2e  # WIPES the dev DB
```

### Run specific test file

```bash
cd apps/web && pnpm test:e2e e2e/my-tickets-refund.spec.ts  # WIPES the dev DB
```

### Run guest-only tests (no auth setup)

```bash
cd apps/web && pnpm test:e2e --project=guest e2e/my-tickets-refund.spec.ts  # WIPES the dev DB
```

### Run with single worker (serial execution)

```bash
cd apps/web && pnpm test:e2e --workers=1  # WIPES the dev DB
```

## Stripe Testing

### Test Mode vs Stripe Mock

By default, tests use **real Stripe test mode** (sandbox). This requires:

- A valid `STRIPE_SECRET_KEY` (sk*test*...)
- Stripe CLI for webhook forwarding (optional but recommended)

To use stripe-mock instead, set:

```bash
STRIPE_BASE_URL=http://127.0.0.1:12111
```

### Stripe CLI for Webhooks

For full webhook testing, run Stripe CLI:

```bash
stripe listen --forward-to localhost:3001/webhooks/stripe
```

This outputs a webhook secret (`whsec_...`) - add it to your `.env.local`.

### PCI Compliance & Test Cards

Our E2E tests use Stripe's test payment method tokens instead of raw card numbers. Specifically, we use `pm_card_bypassPending` which:

- Keeps tests PCI-compliant
- Works with Stripe's fraud protection (Radar)
- **Bypasses pending balance** - funds go directly to available balance, which is required for Connect transfers to succeed in test mode

Without `pm_card_bypassPending`, Connect transfers fail with "insufficient available funds" because regular test cards (like `pm_card_visa`) put funds in the pending balance.

See: https://docs.stripe.com/testing#available-balance

## Test Categories

| Test File                             | Description                             | Stripe Required |
| ------------------------------------- | --------------------------------------- | --------------- |
| `my-tickets-refund.spec.ts`           | My Tickets page + refund flow           | ✅ Yes          |
| `full-money-flow.spec.ts`             | Complete checkout → settlement → refund | ✅ Yes          |
| `checkout-pricing-validation.spec.ts` | Pricing calculations                    | ✅ Yes          |
| `full-journey.spec.ts`                | User journey through UI                 | ⚠️ Optional     |
| `auth.setup.ts`                       | Authentication setup                    | ❌ No           |
| `sign-up.spec.ts`                     | Sign-up flow                            | ❌ No           |
| `email-verification.*.spec.ts`        | Email verification                      | ❌ No           |

## Troubleshooting

### "STRIPE_SECRET_KEY is undefined"

Ensure you have `STRIPE_SECRET_KEY` in your environment. The test reads from:

1. `process.env.PLAYWRIGHT_STRIPE_SECRET_KEY` (highest priority)
2. `process.env.STRIPE_SECRET_KEY`

You can set it inline:

```bash
cd apps/web && STRIPE_SECRET_KEY=sk_test_xxx pnpm test:e2e e2e/my-tickets-refund.spec.ts --project=guest  # WIPES the dev DB
```

### "Can't reach database server"

Start PostgreSQL:

```bash
cd infra/docker && docker compose up -d
```

### Webhook events not received

Start Stripe CLI:

```bash
stripe listen --forward-to localhost:3001/webhooks/stripe
```

### Tests timeout on auth

The auth setup test creates a dev user. If Better Auth is flaky, try running guest-only tests:

```bash
cd apps/web && pnpm test:e2e --project=guest  # WIPES the dev DB
```
