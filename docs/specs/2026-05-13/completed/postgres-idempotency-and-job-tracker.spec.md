# Postgres-backed `IdempotencyPort` and job run tracking

**Date:** 2026-05-13
**Status:** complete
**Priority:** P1 (correctness, pre-launch)
**Depends on:** `IdempotencyPort` (`packages/ports/src/idempotency.ts`), Redis idempotency (`packages/adapters/src/idempotency/redis-adapter.ts`), Prisma idempotency (`packages/adapters/src/idempotency/prisma-adapter.ts`), job run tracker (`apps/jobs/src/lib/job-run-tracker.ts`)

---

## Problem

Two correctness-oriented concerns currently depend on Redis even though their durability and admin-read behavior fit Postgres better:

1. **Idempotency** - API, jobs, mail/SMS adapters, settlements, checkout, POS, resale, org creation, templates, and other use cases call the shared `IdempotencyPort`. Redis claims are fast, but they are stored outside the database that holds the business records. If Redis is unavailable, volatile, or out of sync with a committed database write, retries can become ambiguous.
2. **Job run tracking** - the jobs server stores run history and enabled/disabled flags in Redis. The platform admin/jobs API reads this tracker for `/jobs`, `/jobs/status`, `/jobs/:name/runs`, and `/jobs/:name/enabled`. Losing Redis history loses operator visibility and job toggles.

There is already a Prisma-backed idempotency adapter and an `Idempotency` Prisma model, but the adapter is not wired into the composition roots and needs parity fixes before it can replace Redis safely.

## Goals

- Keep the `IdempotencyPort` contract unchanged: `begin`, `commit`, `fail`, `get`, and `run` all remain available.
- Make the existing Prisma-backed idempotency adapter production-ready behind an `IDEMPOTENCY_BACKEND` flag.
- Preserve Redis namespace isolation when using Postgres-backed idempotency.
- Replace the jobs server's Redis run history and enabled-state store with a Postgres-backed implementation behind a `JOB_TRACKER_BACKEND` flag.
- Keep jobs/admin API behavior unchanged while swapping the storage backend.
- Keep Redis available for the features that still need it: hot events, rate limiting, diagnostics/DLQ, in-app notification transport, and other Redis-native flows.

## Non-Goals

- Changing public port contracts or core use case call sites.
- Claiming idempotency records and business writes in one transaction. The current `IdempotencyPort` does not accept a transaction client, so the safe first step is a durable Postgres-backed store with the existing call pattern. Transaction-scoped idempotency can be designed separately if needed.
- Removing Redis from the infrastructure. This work only removes Redis from idempotency and job run tracking.
- Replacing job diagnostics/DLQ or hot-events storage.
- Changing scheduled job manifests or Cloud Scheduler semantics except for any future prune job.

## Context

| Surface | File |
|---|---|
| Idempotency port | `packages/ports/src/idempotency.ts` |
| Redis idempotency adapter | `packages/adapters/src/idempotency/redis-adapter.ts` |
| Existing Prisma idempotency adapter | `packages/adapters/src/idempotency/prisma-adapter.ts` |
| Existing idempotency table/model | `packages/db/prisma/platform.prisma` (`Idempotency`) |
| Jobs run tracker interface and Redis implementation | `apps/jobs/src/lib/job-run-tracker.ts` |
| Jobs HTTP API consumers of the tracker | `apps/jobs/src/app.ts` |
| API composition root | `apps/api/src/lib/dep.ts` |
| Jobs composition root | `apps/jobs/src/lib/container.ts` |
| Audio transcoder composition root | `apps/audio-transcoder/src/lib/container.ts` |

## Current Contracts

### `IdempotencyPort`

```ts
export interface IdempotencyPort {
  begin(key: string, ttlSec?: number): Promise<boolean>;
  commit<T = unknown>(key: string, result: T, keepSec?: number): Promise<void>;
  fail(key: string, error?: string, keepSec?: number): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  run<T>(key: string, ttlSec: number, fn: () => Promise<T>, keepSec?: number): Promise<{ fresh: boolean; result: T }>;
}
```

### `JobRunTracker`

```ts
export interface JobRunTracker {
  record(entry: RunEntry): Promise<void>;
  runs(jobName: string, limit?: number): Promise<RunEntry[]>;
  latestAll(): Promise<Map<string, RunEntry>>;
  isEnabled(jobName: string): Promise<boolean>;
  setEnabled(jobName: string, enabled: boolean): Promise<void>;
}
```

The tracker is not currently an overlap lock. It is the run-history and enabled-state backend for the jobs admin API. Any advisory-lock work should be additive and explicit.

## Design

### A. Idempotency - reuse and harden the existing Prisma adapter

Use the existing `Idempotency` model in `platform.prisma` rather than creating a second table. The model already supports the current port shape:

- `key` - primary key.
- `status` - `in_progress`, `succeeded`, or `failed`.
- `lockedAt` - claim timestamp.
- `expiresAt` - TTL cutoff.
- `resultJson` - cached successful result.
- `errorText` - failure detail.
- `updatedAt` - write timestamp.

Required fixes:

- Preserve namespace isolation by storing a physical key such as `${namespace}:${key}` inside the existing `key` column.
- `begin()` must atomically claim missing rows and reclaim expired rows.
- `begin()` must return `false` for unexpired `in_progress`, `succeeded`, or `failed` rows.
- `commit()` and `fail()` must upsert if the row disappeared between claim and finish, matching the forgiving behavior consumers expect.
- `get()` must only return non-expired rows with `status = "succeeded"`.
- `run()` must match the Redis adapter behavior.

This does not make the idempotency row part of the same transaction as the business write. That would require a transaction-scoped adapter or a new method accepting a repo/client transaction.

### B. Job run tracking - Postgres-backed history and enabled state

Add two Prisma models in the platform/system area:

```prisma
model JobRun {
  id            String   @id
  jobName       String
  startedAt     DateTime
  finishedAt    DateTime
  durationMs    Int
  status        String
  resultSummary String?
  errorMessage  String?
  errorCode     String?
  createdAt     DateTime @default(now())

  @@index([jobName, startedAt])
  @@index([startedAt])
}

model JobState {
  jobName   String   @id
  enabled   Boolean  @default(true)
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}
```

The Postgres tracker implements the existing `JobRunTracker` interface:

- `record(entry)` inserts a run and trims old rows per job to the same retention target as Redis (`MAX_PER_JOB = 50`).
- `runs(jobName, limit)` returns newest first with a cap of 100.
- `latestAll()` returns the newest run per job.
- `isEnabled(jobName)` returns `true` when no row exists, preserving the Redis default.
- `setEnabled(jobName, enabled)` upserts state. A row may be kept for both `true` and `false` so toggles remain auditable.

### C. Advisory overlap locking - separate follow-up

The previous draft described `tryClaim`, `release`, and `withClaim`, but those methods do not exist today. They cannot replace `record`, `runs`, `latestAll`, `isEnabled`, and `setEnabled`.

If overlap prevention is desired, add it as a separate `JobOverlapLock` or an explicit `withClaim` extension to the app-local tracker. The Postgres implementation should use a pinned `pg.PoolClient` or transaction-scoped advisory locks so claim and release happen on the same database session. That is a behavior change for job execution and should get its own review.

### D. Env-flag cutover

```env
IDEMPOTENCY_BACKEND=redis|postgres
JOB_TRACKER_BACKEND=redis|postgres
```

Defaults:

- API: `IDEMPOTENCY_BACKEND=redis` initially.
- Jobs: `IDEMPOTENCY_BACKEND=redis`, `JOB_TRACKER_BACKEND=redis` initially.
- Audio transcoder: preserve current behavior by using Redis when configured, noop when Redis is absent, unless `IDEMPOTENCY_BACKEND=postgres` is explicitly set.

Cutover sequence:

1. Land migrations, adapter fixes, Postgres job tracker, env flags, and tests with defaults still on Redis.
2. Flip dev to Postgres for `IDEMPOTENCY_BACKEND` and `JOB_TRACKER_BACKEND`.
3. Run smoke flows: checkout/webhook-like idempotency replay, jobs list/status/runs/toggle/manual trigger, audio transcode idempotency construction.
4. Flip prod before launch once dev is clean.
5. Keep Redis wired for other features.

## Schema

Use the existing `Idempotency` table. Add only the job tracking tables in this pass:

```sql
CREATE TABLE "JobRun" (
  "id" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "resultSummary" TEXT,
  "errorMessage" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobRun_status_check" CHECK ("status" IN ('success', 'error'))
);

CREATE INDEX "JobRun_jobName_startedAt_idx" ON "JobRun"("jobName", "startedAt");
CREATE INDEX "JobRun_startedAt_idx" ON "JobRun"("startedAt");

CREATE TABLE "JobState" (
  "jobName" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobState_pkey" PRIMARY KEY ("jobName")
);
```

No data migration is required pre-launch. Redis run history can be allowed to age out.

## File-by-file changes

| Path | Change |
|---|---|
| `packages/db/prisma/platform.prisma` | Add `JobRun` and `JobState` models. Keep existing `Idempotency` model. |
| `packages/db/prisma/migrations/<timestamp>_job_run_tracker_postgres/migration.sql` | Add `JobRun` and `JobState` tables/indexes. |
| `packages/adapters/src/idempotency/prisma-adapter.ts` | Harden existing adapter for namespace isolation, expired-row reclaim, `get()` TTL filtering, upsert finish operations, and `run()` parity. |
| `packages/adapters/src/idempotency/__tests__/prisma-adapter.test.ts` | Add integration tests for claim/replay/reclaim/run semantics. |
| `packages/adapters/src/index.ts` | Export idempotency adapters. |
| `apps/jobs/src/lib/postgres-job-run-tracker.ts` | New Postgres-backed implementation of the existing `JobRunTracker` interface. |
| `apps/jobs/src/lib/__tests__/postgres-job-run-tracker.test.ts` | Add integration tests for run history, latest run, enabled state, and retention trimming. |
| `apps/api/src/lib/env.ts`, `apps/jobs/src/lib/env.ts`, `apps/audio-transcoder/src/lib/env.ts` | Add backend selection env vars. |
| `apps/api/src/lib/dep.ts` | Branch `IdempotencyPort` construction on `IDEMPOTENCY_BACKEND`. |
| `apps/jobs/src/lib/container.ts` | Branch `IdempotencyPort` and `JobRunTracker` construction while leaving Redis for hot events and diagnostics. |
| `apps/audio-transcoder/src/lib/container.ts` | Branch `IdempotencyPort` construction while preserving no-op fallback when not explicitly using Postgres. |

## Validation Plan

- `pnpm db:validate`
- `pnpm exec prisma generate`
- `pnpm --dir ./packages/adapters exec vitest --run src/idempotency/__tests__/prisma-adapter.test.ts --reporter=verbose`
- `pnpm --dir ./apps/jobs exec vitest --run src/lib/__tests__/postgres-job-run-tracker.test.ts --reporter=verbose`
- `pnpm --dir ./apps/jobs exec vitest --run src/__tests__/app.test.ts --reporter=verbose`
- `pnpm --dir ./apps/jobs build`
- A jobs smoke using `JOB_TRACKER_BACKEND=postgres IDEMPOTENCY_BACKEND=postgres` once local DB migrations are applied.

## Risks and Tuning Hooks

- **Existing adapter shape:** the Prisma adapter existed but was not wired. Tests must cover the full current port before flipping any env.
- **Namespace isolation:** use physical key prefixing to avoid API/jobs/audio collisions without changing the existing Prisma primary key.
- **Cleanup gap:** expired `Idempotency` rows do not affect correctness because `get()` filters by `expiresAt`. A prune job can be added later if row volume warrants it.
- **Redis still required:** setting both new flags to Postgres does not make Redis optional for API/jobs because hot events, rate limiting, and diagnostics still depend on it.
- **Transaction atomicity:** this pass improves durability but does not make idempotency atomic with business writes. That requires a separate transaction-aware design.

## Open Questions

1. Should job overlap prevention be added in the same release, or after the storage swap proves stable?
2. Should `JobState` keep `enabled=true` rows for auditability, or delete rows when enabling to mirror Redis's absent-means-enabled shape?
3. Should a prune job for expired `Idempotency` rows be added now or deferred until row volume is visible?
