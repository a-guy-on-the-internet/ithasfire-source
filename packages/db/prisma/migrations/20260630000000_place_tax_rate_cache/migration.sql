-- AlterTable
-- Tax-rate cache columns on Place, mirroring SavedLocation. Looked up via the
-- external tax provider (Ziptax) at place create / address change and cached
-- here so checkout can compute admission tax with zero API calls. A
-- publish-time resolver does a last-chance lookup when these are still null.
-- All columns are nullable and additive; existing rows are unaffected (null
-- rate is safe — checkout falls back to zero tax).
ALTER TABLE "Place" ADD COLUMN     "admission_tax_rate_bps" INTEGER;
ALTER TABLE "Place" ADD COLUMN     "tax_rate_source" TEXT;
ALTER TABLE "Place" ADD COLUMN     "tax_rate_fetched_at" TIMESTAMP(3);
