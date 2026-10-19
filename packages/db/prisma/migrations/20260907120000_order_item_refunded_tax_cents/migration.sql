-- OrderItem.refundedTaxCents — the tax portion of the refund actually issued
-- for this item.
--
-- We refund sales tax to buyers (refund-policy.ts: "Ticket price, tax, and
-- platform fees are refundable") and, until now, recorded nothing about it, so
-- `getTaxNexusRollup` counted a PART_REFUNDED order's FULL original
-- `Order.taxAmountCents` toward "what do we owe".
--
-- Nullable with NO backfill, and no default: NULL means "not attributed",
-- which must stay distinguishable from a measured zero. Sums treat NULL as 0.
-- Additive; re-applicable.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "refundedTaxCents" INTEGER;
