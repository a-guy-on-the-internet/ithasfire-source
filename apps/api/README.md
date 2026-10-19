# API (apps/api)

Local dev notes

- Copy `apps/api/.env.example` to `apps/api/.env.local` (API-only overrides) and fill in your Stripe test keys. Shared local defaults, including `DATABASE_URL`, live in the repo-root `.env.local`:

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

- When `NODE_ENV !== 'production'`, `apps/api/src/index.ts` loads `apps/api/.env.local` (overriding shell vars) and then the repo-root `.env.local`, which fills unset vars and overrides set ones only when `DATABASE_URL` was not already set by the shell or `apps/api/.env.local`. `DEV_ENV_PINS` (comma-separated names, set by `scripts/human-dev.cjs`) names vars neither file may replace. Both paths resolve from the process cwd, `apps/api` under the package scripts. It does not read `apps/api/.env`. The API listens on `PORT` (default 3001).
- In production the Zod validation (`apps/api/src/lib/env.ts`) is strict and throws if required env vars are missing, including the Stripe keys and `BETTER_AUTH_JWKS_URL`. In development the Stripe keys are optional so the server can start without them (useful for UI/workflow development). If you need Stripe features locally, set the test keys in `apps/api/.env.local` or use the Stripe CLI to forward webhooks. `pnpm stack:dev` starts the detached API and the web dev server together.

Security

- Never commit secrets to git. Keep `.env*` files out of git.
