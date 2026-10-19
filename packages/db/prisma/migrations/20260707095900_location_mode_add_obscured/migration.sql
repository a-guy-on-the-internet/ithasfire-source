-- Location-visibility-reveal spec (2026-06-23): add the collapsed 'OBSCURED'
-- value to EventLocationMode.
--
-- This ALTER TYPE ... ADD VALUE must live ALONE in its own migration file:
-- Prisma Migrate wraps EACH migration file in a single transaction on
-- Postgres, and an enum value added inside a transaction cannot be USED
-- before that transaction commits ("unsafe use of new value" — PG12+ allows
-- the ADD VALUE itself in a transaction, but not references to it). The
-- backfill UPDATEs that reference 'OBSCURED' therefore live in the next
-- migration (20260707100000_location_mode_obscured_backfill), which runs in
-- its own, later transaction. Same constraint documented in
-- 20260701120000_add_community_listings.

-- AlterEnum
ALTER TYPE "EventLocationMode" ADD VALUE 'OBSCURED';
