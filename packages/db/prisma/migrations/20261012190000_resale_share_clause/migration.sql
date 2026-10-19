-- Organiser share of every resale, step B1 (schema only).
-- Spec: docs/specs/2026-10-12/organiser-resale-share.spec.yaml FR-001, FR-003,
-- FR-005, FR-015.
--
-- Additive only. Every existing PayoutTerms row reads resaleShareType NULL
-- ("not set", FR-015) and every existing OrderItem / Listing row reads NULL in
-- the new columns, so no backfill runs here. The old markup columns
-- (PayoutTerms.resaleSellerMarkupShareBps, TicketType.resaleSellerMarkupShareBpsOverride
-- and the markup snapshots on Listing / OrderItem) stay; step B5 drops them.
--
-- ── PROD PRE-CHECK (FR-015; read-only; the owner runs these on prod BEFORE
-- the B5 migration that cancels live listings and drops the markup columns) ──
--
--   -- Live resale listings (expected 0: resale is off in production).
--   SELECT status, count(*) FROM "Listing"
--   WHERE status IN ('ACTIVE', 'HELD') GROUP BY status;
--
--   -- RESALE payout terms rows, by status (each reads resaleShareType NULL
--   -- after this migration, so resale is off for them until a clause is set).
--   SELECT status, count(*) FROM "PayoutTerms"
--   WHERE kind = 'RESALE' GROUP BY status;
--
-- Nothing in this file reads or writes prod data beyond the DDL below.

-- CreateEnum
CREATE TYPE "ResaleShareType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "ResaleSharePayer" AS ENUM ('SELLER', 'BUYER');

-- AlterTable
ALTER TABLE "PayoutTerms" ADD COLUMN     "resaleShareBps" INTEGER,
ADD COLUMN     "resaleShareCents" INTEGER,
ADD COLUMN     "resaleSharePayer" "ResaleSharePayer" NOT NULL DEFAULT 'SELLER',
ADD COLUMN     "resaleShareType" "ResaleShareType";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "eventShareCents" INTEGER,
ADD COLUMN     "originalUnitPriceCents" INTEGER,
ADD COLUMN     "resaleClauseBps" INTEGER,
ADD COLUMN     "resaleClauseCents" INTEGER,
ADD COLUMN     "resaleClausePayer" "ResaleSharePayer",
ADD COLUMN     "resaleClauseTermsId" TEXT,
ADD COLUMN     "resaleClauseTermsVersion" INTEGER,
ADD COLUMN     "resaleClauseType" "ResaleShareType",
ADD COLUMN     "sharePayer" "ResaleSharePayer";

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "eventShareCents" INTEGER,
ADD COLUMN     "sharePayer" "ResaleSharePayer";

-- ── Shape checks ──
-- Each CASE has an explicit ELSE FALSE: a CASE that falls through yields NULL,
-- and a CHECK treats NULL as passing. NOT VALID first (no full-table scan
-- under the ACCESS EXCLUSIVE lock the ADD takes), then VALIDATE (scans under
-- SHARE UPDATE EXCLUSIVE, so reads and writes continue). Every existing row is
-- NULL in the new columns, so each one validates.

-- The clause on the terms (FR-001, FR-002). 1000 bps = the 10% limit.
ALTER TABLE "PayoutTerms" ADD CONSTRAINT "PayoutTerms_resale_share_shape_check" CHECK (
  CASE
    WHEN "resaleShareType" IS NULL THEN
      "resaleShareBps" IS NULL AND "resaleShareCents" IS NULL
    WHEN "resaleShareType" = 'PERCENT' THEN
      "resaleShareBps" IS NOT NULL AND "resaleShareBps" BETWEEN 0 AND 1000
      AND "resaleShareCents" IS NULL
    WHEN "resaleShareType" = 'FLAT' THEN
      "resaleShareCents" IS NOT NULL AND "resaleShareCents" > 0
      AND "resaleShareBps" IS NULL
    ELSE FALSE
  END
) NOT VALID;

ALTER TABLE "PayoutTerms" VALIDATE CONSTRAINT "PayoutTerms_resale_share_shape_check";

-- The record on the ticket's item (FR-003). All NULL = no record (legacy items,
-- non-ticket items). A set clause always names the terms and version it came
-- from and who pays. The terms id and version travel together.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_resale_clause_shape_check" CHECK (
  CASE
    WHEN "resaleClauseType" IS NULL THEN
      "resaleClauseBps" IS NULL AND "resaleClauseCents" IS NULL
      AND "resaleClausePayer" IS NULL
    WHEN "resaleClauseType" = 'PERCENT' THEN
      "resaleClauseBps" IS NOT NULL AND "resaleClauseBps" BETWEEN 0 AND 1000
      AND "resaleClauseCents" IS NULL
      AND "resaleClausePayer" IS NOT NULL
      AND "resaleClauseTermsId" IS NOT NULL
    WHEN "resaleClauseType" = 'FLAT' THEN
      "resaleClauseCents" IS NOT NULL AND "resaleClauseCents" > 0
      AND "resaleClauseBps" IS NULL
      AND "resaleClausePayer" IS NOT NULL
      AND "resaleClauseTermsId" IS NOT NULL
    ELSE FALSE
  END
  AND ("resaleClauseTermsId" IS NULL) = ("resaleClauseTermsVersion" IS NULL)
  AND ("originalUnitPriceCents" IS NULL OR "originalUnitPriceCents" >= 0)
) NOT VALID;

ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_resale_clause_shape_check";

-- The per-sale share (FR-005): amount and payer both set or both NULL.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_event_share_shape_check" CHECK (
  ("eventShareCents" IS NULL) = ("sharePayer" IS NULL)
  AND ("eventShareCents" IS NULL OR "eventShareCents" >= 0)
) NOT VALID;

ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_event_share_shape_check";

ALTER TABLE "Listing" ADD CONSTRAINT "Listing_event_share_shape_check" CHECK (
  ("eventShareCents" IS NULL) = ("sharePayer" IS NULL)
  AND ("eventShareCents" IS NULL OR "eventShareCents" >= 0)
) NOT VALID;

ALTER TABLE "Listing" VALIDATE CONSTRAINT "Listing_event_share_shape_check";
