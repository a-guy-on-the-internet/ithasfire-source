---
name: postgresql-code-review
description: 'Review Prisma schema changes, migrations, raw SQL and query code against this repo''s Postgres (Prisma 7 + PrismaPg, PostGIS). Use when reviewing a .prisma file, a migration under packages/db/prisma/migrations, a $queryRaw, an index or constraint, or a concurrency guard.'
---

# PostgreSQL / Prisma Code Review

The database is Postgres with PostGIS, reached through Prisma 7 and the `PrismaPg` adapter. Schema lives in `packages/db/prisma/*.prisma` (multi-file), migrations in `packages/db/prisma/migrations/`. Read the changed schema files and every new migration's SQL in full.

## Migrations

- **An applied migration is never edited.** Its checksum is in `_prisma_migrations` on every database that ran it; editing it causes drift on dev and a failed deploy on prod. A fix is a new migration.
- **Forward-only.** Prisma has no down migrations. A destructive step (column drop, type narrowing, NOT NULL on a populated column) needs a backfill or a staged rollout: stop reading the column in one deploy, drop it in a later one. Check that no code still reading the column ships alongside the drop.
- **Timestamp collisions**: two sessions can generate migrations in the same minute. Compare the new folder name against `ls packages/db/prisma/migrations | tail`.
- **Client generation** runs through `pnpm -F @th/db run generate` only; a bare `prisma generate` run from `packages/db/` reads one schema file of the 42 and writes an empty shared client (from the repo root it is correct, which is why CI's form works).
- **Invariants belong in the database** when the owner has ruled them always-true: a CHECK constraint, a partial unique index or a trigger, not one guard per use case. Where a guard must serialise writers that the row model can't lock (e.g. "no roomless calendars"), the repo uses `pg_advisory_xact_lock`, not `SELECT … FOR UPDATE` on rows that may not exist yet.

## Prisma traps

- **A plain `DateTime` is `timestamp(3)` without time zone, storing UTC.** In SQL, label it before converting: `(d."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE e.timezone`. A single `AT TIME ZONE tz` shifts every row and once produced a false "every recurring date is a day late" alarm. Columns marked `@db.Timestamptz` (most of `search.prisma`, `Event.addressRevealNotifiedAt`) take a single `AT TIME ZONE tz`; check the column's type before flagging. Do not ask for `TIMESTAMPTZ` columns; consistency with the existing schema wins.
- **`previewFeatures = ["relationJoins"]` flips the default** load strategy to `join` for every relation query in the codebase, not just the one that asked. Treat adding it as a codebase-wide change.
- **Adapter integration tests silently skip** unless the test constructs Prisma with `PrismaPg` (pattern: `packages/adapters/test/integration/event-saves.test.ts`). A new adapter test that never ran is not coverage.
- `$queryRaw` / `$executeRaw` take tagged-template parameters; `$queryRawUnsafe` or string concatenation with any user value is [BLOCKING].

## Schema and query checks

- Money is integer cents (`Int`/`BigInt`); never `Float` or `Decimal` arithmetic in JS.
- New foreign keys state their `onDelete`; a cascade that can delete orders, tickets or ledger rows needs a stated reason.
- Every new `where`, `orderBy` or join column on a growing table has an index; a unique constraint backs every "only one" rule (double scans, double settlements).
- JSONB: a field queried by key or containment gets a GIN or expression index; a JSONB blob with a stable shape that is filtered on should be columns.
- Multi-statement mutations run in one `repos.tx()`; a read that a later write depends on happens inside that transaction (TOCTOU otherwise).
- `select` only the columns the caller needs on hot paths; `include` chains on list endpoints multiply queries (N+1).

## Report

Use the reviewer's finding format. For each [BLOCKING], give the concrete failure (which deploy, which rows, which concurrent requests).
