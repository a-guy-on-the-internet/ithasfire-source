-- Per-event Tennessee instructional-admission sales-tax exemption.
--
-- Tennessee exempts admission charges for INSTRUCTION only (classes / lessons /
-- courses / teaching) from sales/amusement tax, while recreational admission
-- stays taxable. We model this as an organizer-attested per-event boolean.
-- When true AND the event's frozen tax situs is US/TN, the admission tax rate
-- resolves to 0 with source "exempt:tn-instruction"
-- (packages/core/src/lib/tax/instruction-exemption.ts). The flag alone does NOT
-- exempt outside TN.
--
-- Additive, idempotent DDL only — NOT NULL with a DEFAULT false so existing
-- rows backfill to "not instructional" (the taxable default). Guarded with
-- IF NOT EXISTS so a re-run against the db-push-managed dev database is a no-op.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "instructional_admission" BOOLEAN NOT NULL DEFAULT false;
