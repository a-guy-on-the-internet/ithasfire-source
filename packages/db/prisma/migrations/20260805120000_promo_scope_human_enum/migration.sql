-- Add PromoScope.HUMAN (DB enum "CouponScope").
--
-- HUMAN is the owner-wide "self" scope for direct/personal sellers
-- (event.orgId = null, event.humanId = seller), mirroring ORG for
-- organizations. scopeId = the Human id.
--
-- This ALTER TYPE must live in its OWN migration: Postgres cannot USE a
-- newly-added enum value inside the same transaction that adds it, and
-- Prisma wraps each migration in a single transaction. The backfill that
-- uses 'HUMAN' follows in 20260805121000_promo_scope_human_backfill.

-- AlterEnum
ALTER TYPE "CouponScope" ADD VALUE IF NOT EXISTS 'HUMAN';
