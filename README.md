# Ithas Fire

Monorepo for the Ithas Fire platform -- transparent, developer-grade ticketing and event infrastructure.

> **Public source-available mirror.** This repository is published openly for transparency and verifiability of how the platform is built -- not to solicit contributions. It is **source-available, all rights reserved** (see [`LICENSE`](LICENSE)): you may read the code, but it is not licensed for reuse, redistribution, or modification. Issues and pull requests here are not monitored; canonical development happens in a private repository.

## Index

- [Documentation](#documentation)
- [Contributing](CONTRIBUTING.md)
- [CI workflow](#ci-workflow)
- [Quick infra start (local dev)](#quick-infra-start-local-dev)
- [App surfaces & helper scripts](#app-surfaces--helper-scripts)

## Documentation

See **[`docs/README.md`](docs/README.md)** for the full documentation index. Key starting points:

- [`docs/engineering-standards.md`](docs/engineering-standards.md) -- Engineering standards and architecture
- [`docs/env.md`](docs/env.md) -- Environment variables reference
- [`docs/db-setup.md`](docs/db-setup.md) -- Database setup and Prisma workflow
- [`docs/production-checklist.md`](docs/production-checklist.md) -- Production deployment guide

## CI workflow

The repository includes a GitHub Actions workflow at `.github/workflows/ci.yml` that runs on push and PRs to `main`.

What the CI does:

- Installs dependencies with pnpm
- Validates the Prisma schema in `packages/db`
- Generates the Prisma client
- Runs the monorepo build (via turbo)
- Type-checks and runs lint

To run the checks locally (macOS / Linux):

```bash
# install deps
pnpm install

# Validate Prisma schema (requires a running Postgres for full validation)
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dev?schema=public"
pnpm db:validate

# Generate Prisma client
pnpm -F @th/db prisma generate

# Build and typecheck
pnpm build
pnpm -w tsc -p tsconfig.base.json

# Lint
pnpm lint
```

## Quick infra start (local dev)

This repo includes `infra/docker/docker-compose.yml` and `infra/.env` (keep `.env` local). A safe example is included at `infra/.env.example` — copy it to `infra/.env` and edit secrets locally.

Start the infra:

```bash
cd infra/docker
docker compose up -d
```

Need only Redis (for example to exercise the idempotency, rate-limit, or DLQ adapters) but still want data to persist between sessions? Use the dedicated compose file:

```bash
cd infra/docker
docker compose -f docker-compose.redis.yml up -d redis-dev
```

It binds to `localhost:16379` by default (override with `HOT_EVENTS_REDIS_PORT`) and stores data in the named volume `ithasfire-redis-dev`, so you can stop/start containers without losing state. Tear it down with `docker compose -f docker-compose.redis.yml down` when you’re finished.

Then apply Prisma migrations and run a smoke test:

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dev?schema=public"
cd packages/db
pnpm -F @th/db prisma migrate dev --name init
pnpm -F @th/db prisma generate
node test-smoke.js
```

Notes:

- Do not commit `infra/.env` to the repository. Instead copy `infra/.env.example` to `infra/.env` and edit the values locally.

## App surfaces & helper scripts

Once Postgres/Redis are running you can boot individual services (or the full stack) with the helper scripts under `package.json`:

| Command                           | Purpose                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm api:bg`                     | Starts `apps/api` in a detached background process. PID lives in `.tmp/api-dev.pid` and logs stream to `logs/dev/api/api-<timestamp>.log` (files older than ~48h are auto-pruned). Tail with `tail -f logs/dev/api/<latest>.log`. |
| `pnpm api:bg:status`              | Prints whether the detached API is still running.                                                                                                                                                                                 |
| `pnpm api:bg:stop`                | Sends `SIGTERM` to the detached API and cleans up the PID file.                                                                                                                                                                   |
| `pnpm web:dev:local`              | Launches the Next.js dev server while ensuring `WEB_API_BASE_URL` is set (defaults to `http://localhost:3001`). Pass a different base with `--base https://api.dev.foo`.                                                          |
| `pnpm stack:dev`                  | Convenience combo that runs `pnpm api:bg` first and then `pnpm web:dev:local --base http://localhost:3001`.                                                                                                                       |
| `pnpm db:reset`                   | `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public tsx scripts/db-reset.ts`                                                                                                                            |
| `pnpm db:reset:remote`            | `tsx scripts/db-reset.ts`                                                                                                                                                                                                         |
| `pnpm db:wipe`                    | `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public tsx scripts/db-wipe.ts`                                                                                                                             |
| `pnpm db:wipe:remote`             | `tsx scripts/db-wipe.ts`                                                                                                                                                                                                          |
| `pnpm db:backfill:paidout`        | `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public tsx scripts/backfill-order-item-paidout.ts`                                                                                                         |
| `pnpm db:backfill:paidout:remote` | `tsx scripts/backfill-order-item-paidout.ts`                                                                                                                                                                                      |
| `pnpm human:dev`                  | `node scripts/human-dev.cjs`                                                                                                                                                                                                      |
| `pnpm mobile`                     | `pnpm -F mobile ios`                                                                                                                                                                                                              |
| `pnpm mobile:smoke`               | `pnpm -F mobile smoke`                                                                                                                                                                                                            |
| `pnpm mobile:lint`                | `pnpm -F mobile lint`                                                                                                                                                                                                             |
| `pnpm vitest:bg`                  | `node scripts/run-vitest-watch.cjs`                                                                                                                                                                                               |
| `pnpm vitest:bg:stop`             | `node scripts/stop-vitest-watch.cjs`                                                                                                                                                                                              |
| `pnpm scanner`                    | `pnpm -F scanner start`                                                                                                                                                                                                           |
| `pnpm prisma:gen`                 | `pnpm -C packages/db run generate`                                                                                                                                                                                                |
| `pnpm prisma:push`                | `pnpm exec prisma db push`                                                                                                                                                                                                        |
| `pnpm db:migrate:dev`             | `pnpm exec prisma migrate dev`                                                                                                                                                                                                    |
| `pnpm db:migrate:deploy`          | `pnpm exec prisma migrate deploy`                                                                                                                                                                                                 |
| `pnpm db:migrate:status`          | `pnpm exec prisma migrate status`                                                                                                                                                                                                 |
| `pnpm db:validate`                | `pnpm exec prisma validate`                                                                                                                                                                                                       |
| `pnpm infra:test`                 | `bash infra/scripts/validate.sh`                                                                                                                                                                                                  |
| `pnpm seed:dev`                   | `pnpm -F api seed:dev`                                                                                                                                                                                                            |
| `pnpm android`                    | `expo run:android`                                                                                                                                                                                                                |
| `pnpm ios`                        | `expo run:ios`                                                                                                                                                                                                                    |
| `pnpm email:preview`              | Start the `@th/ui-email` preview server (browse templates at `http://localhost:3004`).                                                                                                                                            |

The API logs directory is gitignored; if you need to inspect previous runs, look under `logs/dev/api`. Each invocation appends a timestamped file so they do not clobber one another, and anything older than roughly two days is removed automatically.

The web helper simply wraps `pnpm -F web dev` and injects `WEB_API_BASE_URL` if the env variable is missing; all other flags and `.env.local` entries still behave normally.

The Vitest helper derives a label from the directory path (`packages/core` → `packages-core`). Override it with `--label my-core` when you want clearer names or multiple watchers per directory. Example: `pnpm vitest:bg --dir packages/core` to start a long-running watcher, then `pnpm vitest:bg:stop --label packages-core` (or `kill $(cat logs/dev/tests/packages-core/watcher.pid)`) when you're done.
