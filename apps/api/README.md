# API (apps/api)

Local dev notes

- Copy `apps/api/.env.example` to `apps/api/.env` and fill in your Stripe test keys:

```env
STRIPE_SECRET_KEY=sk_test_...    # Stripe test secret
STRIPE_WEBHOOK_SECRET=whsec_...  # Stripe webhook signing secret
BETTER_AUTH_JWKS_URL=...        # Better Auth JWKS URL (required for authenticated tRPC routes)
BETTER_AUTH_ISSUER=...          # Better Auth issuer
BETTER_AUTH_AUDIENCE=...        # Better Auth audience
APP_BASE_URL=http://localhost:3001
```

- Start the API in dev (foreground):

```bash
pnpm -F api dev
```

- Or run it detached with helper scripts:

```bash
pnpm api:bg           # start detached, logs -> logs/dev/api/api-<timestamp>.log (auto-pruned after ~48h)
pnpm api:bg:status    # check pid/liveness
pnpm api:bg:stop      # send SIGTERM and remove pid file
```

Detached mode stores the PID in `.tmp/api-dev.pid` and rotates logs automatically under `logs/dev/api` (entries older than roughly two days are deleted on startup). Tail the newest file with `tail -f logs/dev/api/<file>.log` while you iterate on the web client.

Behavior

- The app will load `.env` automatically when `NODE_ENV !== 'production'`.
- In production the Zod validation is strict and will throw if required env vars are missing. In development the Stripe keys are optional so the server can start without them (useful for UI/workflow development). If you need Stripe features locally, set the test keys in `.env` or use the Stripe CLI to forward webhooks.

Security

- Never commit secrets to git. Keep `.env` in your local `.gitignore`.
