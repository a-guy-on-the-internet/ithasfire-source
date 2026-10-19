-- OrderTaxLine: what an order was charged, one row per tax imposition.
--
-- ADDITIVE ONLY. New enums, a new table, its index and its FK. No existing
-- column or row changes, so there is no backfill: orders created before this
-- migration simply have no lines (a missing breakdown means "unknown", not
-- "zero" — see the invariant on Order.taxAmountCents in order.prisma).
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards), so a partial apply or a
-- hand-applied copy re-runs cleanly under `prisma migrate deploy`.
--
-- Lock note: the FK takes a brief SHARE ROW EXCLUSIVE lock on "Order" to
-- register the constraint. "OrderTaxLine" is empty at this point, so there are
-- no rows to validate and the lock is held only for the catalog update.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "OrderTaxBase" AS ENUM ('TICKET_FACE', 'BUYER_TOTAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "OrderTaxCollector" AS ENUM ('PLATFORM', 'ORGANISER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderTaxLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "label" VARCHAR(128) NOT NULL,
    "jurisdiction" VARCHAR(128) NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "base" "OrderTaxBase" NOT NULL,
    "collector" "OrderTaxCollector" NOT NULL,
    "taxableAmountCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderTaxLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderTaxLine_orderId_idx" ON "OrderTaxLine"("orderId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OrderTaxLine"
    ADD CONSTRAINT "OrderTaxLine_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
