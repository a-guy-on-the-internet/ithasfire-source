# Database Setup and Prisma Workflow

Use this guide to run local and managed database workflows safely.

## Safety warning before destructive commands

Commands like `pnpm db:wipe` and `pnpm db:reset:remote` are destructive.

Before running them:

- Confirm the current `DATABASE_URL` target.
- Confirm whether the target is local or remote.
- Confirm whether data loss is acceptable.
- Use explicit confirmation flags for remote destructive actions where supported (for example `pnpm db:wipe --allow-remote --confirm`).

## Prerequisites

From repo root:

```bash
pnpm install
pnpm prisma:gen
```

Version pin note:

- Prisma and `@prisma/client` are pinned via `package.json#pnpm.overrides`.
- If you upgrade Prisma, bump both together, then rerun `pnpm install` and `pnpm prisma:gen`.

## Workflow A: local Docker development

This starts Postgres, Redis, stripe-mock, Meilisearch, and MinIO.

1. Start local infra.

```bash
cd infra/docker
docker compose up -d
```

2. Configure environment values (for example in `apps/api/.env` or `.env.local`).

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public
REDIS_URL=redis://localhost:6379
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=dev-master-key
```

3. Validate schema and generate client.

```bash
cd /Users/somehuman/Projects/TicketHunter
pnpm db:validate
pnpm prisma:gen
```

4. Apply migrations and seed demo data.

```bash
pnpm -F @th/db prisma migrate dev
pnpm seed:dev
```

5. Optional smoke test.

```bash
cd packages/db
node test-smoke.js
```

6. Optional log and shutdown commands.

```bash
cd infra/docker
docker compose logs -f
docker compose down
```

## Workflow B: managed dev infra (Neon + Upstash)

Use this when you do not want local Postgres/Redis.

### Neon (Postgres)

1. Create Neon project and branch.
2. Copy pooled connection string and include `sslmode=require`.
3. Set `DATABASE_URL` and `DATABASE_MIGRATOR_URL` in your env file.
4. Run schema and seed flow:

```bash
pnpm prisma:gen
pnpm -F @th/db prisma migrate deploy
pnpm seed:dev
```

Seed behavior:

- `pnpm seed:dev` runs `apps/api/src/scripts/seed/seed-data.ts`.
- It is idempotent and creates demo fixtures tied to `THC_EVENTS_DEFAULT_REGION_CODE` (default `ca-sf`). The region's state prefix must be in `STATE_TIMEZONES` (`apps/api/src/scripts/seed/utils.ts`), or the seed throws.

### Upstash (Redis)

1. Create Upstash Redis instance.
2. Set these values in env files used by `apps/api`, `apps/jobs`, and related services:

- `REDIS_URL`
- `REDIS_REST_URL`
- `REDIS_REST_TOKEN`

## Migration workflow

Use this flow when editing `.prisma` files under `packages/db/prisma/`:

1. Validate schema.

```bash
pnpm db:validate
```

2. Generate Prisma client.

```bash
pnpm prisma:gen
```

3. Create migration (development).

```bash
cd packages/db
export DATABASE_URL="postgresql://user:pass@host:5432/dbname?schema=public"
pnpm prisma migrate dev --name <description>
```

4. Smoke test.

```bash
cd packages/db
node test-smoke.js
```

## Reset and wipe workflows

Use these only when you intentionally need to rebuild data.

### Remote reset helper

```bash
pnpm db:reset:remote --seed
```

Behavior:

- Runs `prisma migrate reset --force` and `prisma migrate deploy` against `DATABASE_URL`.
- Optional `--seed` reruns `pnpm seed:dev`.

Safety notes:

- Treat this as an ephemeral dev helper only (for example a personal Neon branch).
- Do not use this flow for shared dev/staging/prod databases.
- Migration changes for shared environments must still flow through reviewed Prisma migrations.

### Wipe helper

```bash
pnpm db:wipe
pnpm db:wipe --seed
pnpm db:wipe --confirm --allow-remote --seed
```

Safety behavior:

- Local targets can run without extra flags.
- Remote targets require both `--allow-remote` and `--confirm`.
- `--seed` is optional.

## Seeding workflow

Run seed manually when you need fresh fixtures:

```bash
pnpm seed:dev
```

To change demo fixture data, edit `EVENT_FIXTURES` in `apps/api/src/scripts/seed/seed-data.ts` and rerun the seed command.

## Troubleshooting

Common issues and actions:

- `Can't reach database server at localhost:5432`
   - Start local Docker services or update `DATABASE_URL` to a reachable host.
- Prisma validation errors about enums or relations
   - Re-check files in `packages/db/prisma/` and rerun `pnpm db:validate`.
- Migration command fails in managed env
   - Verify `DATABASE_URL`, `DATABASE_MIGRATOR_URL`, and SSL parameters.
- App does not show seeded data
   - Confirm API is pointed at the same database that was seeded.

