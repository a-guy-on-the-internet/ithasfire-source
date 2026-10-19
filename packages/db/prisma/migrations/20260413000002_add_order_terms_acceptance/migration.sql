-- Add Terms of Service acceptance fields to Order
-- Both columns are nullable so existing rows are unaffected.
ALTER TABLE "Order"
  ADD COLUMN "termsVersion"     TEXT,
  ADD COLUMN "termsAcceptedAt"  TIMESTAMPTZ;
