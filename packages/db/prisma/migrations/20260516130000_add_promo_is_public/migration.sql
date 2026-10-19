-- Add `isPublic` flag to promos so we can distinguish marketing codes
-- (shareable in URLs) from private/comp codes (manual entry only).
-- Defaults to false so existing codes stay private until an admin opts in.

ALTER TABLE "Coupon"
  ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Coupon_isPublic_status_idx" ON "Coupon" ("isPublic", "status");
