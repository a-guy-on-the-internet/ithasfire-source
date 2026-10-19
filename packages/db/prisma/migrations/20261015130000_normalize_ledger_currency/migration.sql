-- Make "currency is already normalised" a database invariant instead of
-- something every reader has to remember.
--
-- WHY: `PayeeLedgerEntry` and `PayeeLedgerBalance` store currency as raw text.
-- The write path lowercases, but legacy rows, a backfill or direct SQL can put
-- a second casing in, and every aggregate that grouped on the raw column then
-- returned TWO rows for one currency. That produced three separate money bugs:
--
--   * sumOutstandingLiability: a consumer keying by currency dropped a row's
--     cents, understating what the platform owes, and each casing was clamped
--     at zero independently, overstating it. Reported the platform solvent.
--   * listPayableBalances: two payable cells for one payee-currency both hash
--     to run-batch's (already normalised) cellClaimKey, so the loser records
--     itemsSkippedClaimLost. The SAME casing wins every night, so the losing
--     cell's money is never paid out at all.
--   * the pending-hold deduction matched the rollup on the raw column, so a
--     hold under one casing did not reduce the other casing's payable and the
--     payee was overpaid by the held amount.
--
-- The reads were fixed to fold. This constraint is the durable half: it means
-- nobody has to fold again, and a future query that groups on the raw column
-- is correct by construction rather than by vigilance.
--
-- THE FOLDS HAVE AN END-OF-LIFE. Defensive folding in three places is not the
-- resting state — the invariant belongs here, once. Until this migration has
-- APPLIED IN PROD, prod data can still hold a second casing, so the folds are
-- load-bearing and must stay. After it has, they are removable:
--
--   * packages/adapters/src/db/prisma/payee-ledger.ts — the btrim(lower(...))
--     in listPayableBalances and sumOutstandingLiability, and the two
--     aggregate-before-join CTEs that exist only to make folding safe.
--   * packages/core/src/use-cases/settlements/check-platform-solvency.ts —
--     the accumulate-by-summing loops over liabilityRows / taxRows.
--
-- Remove them together or not at all, and only once this constraint is live
-- everywhere. Removing them while any environment is unconstrained
-- reintroduces all three bugs above silently.
--
-- SCOPE: the three tables the ledger/tax money path actually reads. `Order` is
-- here because sumCollectedTaxByCurrency groups on it. `PayoutItem` is
-- deliberately EXCLUDED: its unique key is (payoutId, payeeId, currency) and a
-- PayoutItem is an individual money record with its own transfer id and
-- status — merging two of them would be a settlement decision, not a data
-- cleanup. Normalise it in a separate, considered change.
--
-- Re-applicable by design: every step is guarded or idempotent (UPDATEs match
-- only un-normalised rows, the fold finds no collisions the second time, the
-- constraints check pg_constraint). normalize-ledger-currency-migration
-- .integration.test.ts applies it twice.
--
-- LOCKING: the fold snapshots PayeeLedgerBalance into a temp table, deletes and
-- re-inserts. Under READ COMMITTED a concurrent increment between snapshot and
-- DELETE would be lost, and a concurrent 'usd' upsert beside a lone 'USD' row
-- would make the later UPDATE hit the PK. So all three tables are locked
-- against reads AND writes for the migration's whole transaction
-- (milliseconds at today's sizes). The locks are taken up front, at their
-- final ACCESS EXCLUSIVE strength, in the order the app writes these tables:
-- Order, then entry, then balance (cash sales, cash refunds and disputes all
-- touch the Order before the ledger). Upgrading a lock mid-migration
-- (ROW EXCLUSIVE from an UPDATE, then ACCESS EXCLUSIVE for the ALTER), or
-- locking in any other order, can deadlock against a live write, and either
-- side may be the one aborted. lock_timeout makes the migration fail fast
-- rather than queue live traffic behind it.

SET LOCAL lock_timeout = '5s';

LOCK TABLE "Order", "PayeeLedgerEntry", "PayeeLedgerBalance" IN ACCESS EXCLUSIVE MODE;

-- ── 1. PayeeLedgerEntry — no unique key on currency, so a plain backfill ────
UPDATE "PayeeLedgerEntry"
   SET "currency" = btrim(lower("currency"))
 WHERE "currency" <> btrim(lower("currency"));

-- ── 2. PayeeLedgerBalance — PK is (payeeId, currency), so normalising can
--      COLLIDE. Fold colliding rows into one canonical row first.
--
--      Cents are SUMMED, which is the same arithmetic the read-side fold
--      settled on: two casings are two halves of one payee's real position,
--      never two separate obligations.
DO $$
BEGIN
  DROP TABLE IF EXISTS pg_temp._plb_merge;
  CREATE TEMP TABLE _plb_merge ON COMMIT DROP AS
    SELECT
      "payeeId",
      btrim(lower("currency"))                AS "currency",
      SUM("ledgerBalanceCents")::int          AS "ledgerBalanceCents",
      SUM("ledgerPendingHoldCents")::int      AS "ledgerPendingHoldCents",
      SUM("reserveBalanceCents")::int         AS "reserveBalanceCents",
      MAX("updatedAt")                        AS "updatedAt"
    FROM "PayeeLedgerBalance"
    GROUP BY "payeeId", btrim(lower("currency"))
    HAVING COUNT(*) > 1;

  DELETE FROM "PayeeLedgerBalance" b
   USING _plb_merge m
   WHERE b."payeeId" = m."payeeId"
     AND btrim(lower(b."currency")) = m."currency";

  INSERT INTO "PayeeLedgerBalance" (
    "payeeId", "currency", "ledgerBalanceCents",
    "ledgerPendingHoldCents", "reserveBalanceCents", "updatedAt"
  )
  SELECT
    "payeeId", "currency", "ledgerBalanceCents",
    "ledgerPendingHoldCents", "reserveBalanceCents", "updatedAt"
  FROM _plb_merge;
END
$$;

UPDATE "PayeeLedgerBalance"
   SET "currency" = btrim(lower("currency"))
 WHERE "currency" <> btrim(lower("currency"));

-- ── 3. Order — read by sumCollectedTaxByCurrency; no unique key on currency ──
UPDATE "Order"
   SET "currency" = btrim(lower("currency"))
 WHERE "currency" <> btrim(lower("currency"));

-- ── 4. The invariant itself ─────────────────────────────────────────────────
-- Guarded by pg_constraint so re-application is a no-op (house precedent:
-- PayeeLedgerEntry_settlement_credit_available_check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayeeLedgerEntry_currency_normalized_check'
      AND conrelid = 'public."PayeeLedgerEntry"'::regclass
  ) THEN
    ALTER TABLE "PayeeLedgerEntry"
      ADD CONSTRAINT "PayeeLedgerEntry_currency_normalized_check"
      CHECK ("currency" = btrim(lower("currency")));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayeeLedgerBalance_currency_normalized_check'
      AND conrelid = 'public."PayeeLedgerBalance"'::regclass
  ) THEN
    ALTER TABLE "PayeeLedgerBalance"
      ADD CONSTRAINT "PayeeLedgerBalance_currency_normalized_check"
      CHECK ("currency" = btrim(lower("currency")));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Order_currency_normalized_check'
      AND conrelid = 'public."Order"'::regclass
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_currency_normalized_check"
      CHECK ("currency" = btrim(lower("currency")));
  END IF;
END
$$;
