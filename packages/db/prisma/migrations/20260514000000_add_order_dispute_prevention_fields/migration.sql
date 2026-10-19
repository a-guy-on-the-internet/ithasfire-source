-- Add dispute-prevention checkout evidence fields to Order.
-- All columns are nullable so existing rows are unaffected.
ALTER TABLE "Order"
  ADD COLUMN "billingDescriptor"    VARCHAR(22),
  ADD COLUMN "refundPolicyAckAt"    TIMESTAMP(3),
  ADD COLUMN "refundPolicyAckIp"    VARCHAR(128),
  ADD COLUMN "refundPolicyVersion"  VARCHAR(64),
  ADD COLUMN "refundPolicyText"     TEXT;