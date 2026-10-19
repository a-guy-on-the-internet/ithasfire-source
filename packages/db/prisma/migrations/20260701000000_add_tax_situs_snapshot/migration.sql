-- AlterTable
-- Point-in-time tax-situs snapshot on Order (spec 2026-07-01 §5.2).
-- Freezes the VENUE jurisdiction that determined the order's tax at create
-- time so historical threshold rollups stay correct even if the venue is
-- later edited. Distinct from the buyer's billing address. All columns are
-- nullable and additive; existing rows are unaffected (no backfill — accrues
-- forward, historical orders can be backfilled from event venue if ever needed).
ALTER TABLE "Order" ADD COLUMN     "taxSitusCountry" VARCHAR(2);
ALTER TABLE "Order" ADD COLUMN     "taxSitusState" TEXT;
ALTER TABLE "Order" ADD COLUMN     "taxSitusPostal" TEXT;
ALTER TABLE "Order" ADD COLUMN     "taxRateSource" TEXT;
