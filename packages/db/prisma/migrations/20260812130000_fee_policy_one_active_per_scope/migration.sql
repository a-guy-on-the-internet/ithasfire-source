-- DB backstop for "at most one ACTIVE FeePolicy per scope".
--
-- The platform fee is defined in code
-- (`packages/core/src/lib/pricing/platform-fee-policy.ts`) and materialized into
-- this table by a deploy-time reconciler
-- (`apps/api/src/scripts/seed-platform-fee-policy.ts` ->
-- `reconcilePlatformFeePolicy`). Writing a new policy is ARCHIVE-THEN-CREATE:
-- `feePolicies.upsert` reads the current ACTIVE row with `findFirst`, flips it
-- to ARCHIVED, then inserts version N+1. That is a read-modify-write, so two
-- overlapping writers can both read "version 7 is active" and both insert a
-- version 8 ACTIVE row.
--
-- WHY THE EXISTING UNIQUE CANNOT CATCH THIS. `@@unique([scopeType, scopeId,
-- status, version])` looks like it covers the case and does not: GLOBAL rows
-- carry `scopeId IS NULL`, and Postgres treats NULLs as distinct in a unique
-- index, so ANY number of (GLOBAL, NULL, ACTIVE, 8) rows coexist happily. That
-- is exactly why the index below wraps the column in `COALESCE("scopeId", '')`
-- — it maps every GLOBAL row onto the same non-NULL key so they collide with
-- each other. ORG/EVENT-scoped rows have a real `scopeId` and are unaffected by
-- the COALESCE (a UUID is never the empty string).
--
-- WHAT BREAKS WITHOUT IT. Two ACTIVE rows for one scope is a silent money bug,
-- not a crash. Readers pick one arbitrarily and they do not agree on which:
--   * `feePolicies.getActiveForScope` orders by `version DESC`;
--   * `feePolicies.resolveEffective` orders by `effectiveFrom DESC, version
--     DESC` and additionally filters on the effective window;
--   * the next reconcile archives only ONE of them (`findFirst`), so the loser
--     becomes a permanently-ACTIVE ghost that no later write ever cleans up.
-- Two buyers on the same event can then be priced off different policies, and
-- `PayoutTerms.feePolicyId` pins whichever ghost happened to win at publish
-- time, so the divergence outlives the row that caused it.
--
-- TODAY THE ONLY GUARD IS CODE. `feePolicies.lockScopeGuard`
-- (`pg_advisory_xact_lock`, taken first inside the reconciler's transaction)
-- serializes the read-modify-write. It works, and it stays — it is what keeps
-- the reconciler from ever HITTING this index — but it is opt-in: any future
-- caller of `feePolicies.upsert` that forgets the lock reopens the hole. The
-- invariant is expressible in Postgres, so it is expressed in Postgres.
--
-- WHAT THE FAILURE MODE LOOKS LIKE TO CALLING CODE. A duplicate INSERT/UPDATE
-- raises Postgres 23505, surfaced by Prisma as P2002 with
-- `meta.target = "FeePolicy_one_active_per_scope_key"`. Nothing maps that to a
-- domain error today and nothing should have to: the only write path is the
-- reconciler, which already holds the advisory lock, so a P2002 here means a
-- NEW unguarded writer exists and should fail loudly rather than quietly mint a
-- second ACTIVE row. A future writer that legitimately races (a UI-driven
-- upsert, say) should either take `lockScopeGuard` too or catch P2002 and
-- re-read, the way `send-support-message` does for
-- "support_thread_one_active_per_human_key".
--
-- DRAFT and ARCHIVED are outside the predicate on purpose: a scope may hold any
-- number of archived versions (that history is the point — a `PayoutTerms` pin
-- can reference an old version forever) and any number of unpublished drafts.
--
-- NOTE ON IDENTIFIERS: `FeePolicy` has no `@@map`, so the table and its columns
-- are camelCase and must be double-quoted. (The precedent this follows,
-- `20260623130000_support_thread_one_active_per_human`, is snake_case only
-- because `SupportThread` carries `@@map("support_thread")`.)
--
-- Partial and expression indexes are not expressible in the Prisma schema —
-- this index is SQL-only (noted on the FeePolicy model in finance.prisma).

-- ── 1. Fail LOUDLY, and diagnostically, if the data already violates ───────
-- Verified clean everywhere at authoring time (local dev: 1 ACTIVE GLOBAL +
-- 6 ARCHIVED; Neon dev-cloud: 1 ACTIVE GLOBAL; prod: 0 rows), so there is
-- deliberately NO data-repair step here — picking a winner between two ACTIVE
-- fee policies is an economics decision, not something a migration should do
-- unattended on a money table. Without this block the bare CREATE UNIQUE INDEX
-- would still fail, but with Postgres' generic "Key ... is duplicated" and no
-- indication of WHICH scope, on a deploy job whose logs nobody is watching.
-- Grouping is on the INDEX KEY (`COALESCE("scopeId", '')`), not on the raw
-- column. Grouping on the raw column would put a NULL `scopeId` and a
-- (pathological, but not schema-forbidden) empty-string one in separate
-- buckets, report "clean", and then let the CREATE below fail with the generic
-- message this block exists to replace. `<null-or-empty>` labels that shared
-- bucket honestly rather than claiming the rows are NULL.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(
           format('%s/%s (%s ACTIVE rows)',
                  "scopeType",
                  CASE WHEN scope_key = '' THEN '<null-or-empty>' ELSE scope_key END,
                  n),
           ', ' ORDER BY "scopeType", scope_key
         )
    INTO offenders
    FROM (
      SELECT "scopeType", COALESCE("scopeId", '') AS scope_key, count(*) AS n
        FROM "FeePolicy"
       WHERE "status" = 'ACTIVE'
       GROUP BY "scopeType", COALESCE("scopeId", '')
      HAVING count(*) > 1
    ) dupes;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one-ACTIVE-FeePolicy-per-scope: duplicate ACTIVE policies for %. Archive the losing row(s) (status = ARCHIVED, effectiveTo = now()) before re-running this migration; do not weaken the index.',
      offenders;
  END IF;
END
$$;

-- ── 2. The gate ────────────────────────────────────────────────────────────
-- IF NOT EXISTS because the dev databases here are db-push-managed, so a
-- migration can legitimately be re-applied over a schema that already has the
-- index (same reasoning as 20260811140000_application_submission_open_dedupe).
CREATE UNIQUE INDEX IF NOT EXISTS "FeePolicy_one_active_per_scope_key"
  ON "FeePolicy" ("scopeType", COALESCE("scopeId", ''))
  WHERE "status" = 'ACTIVE';
