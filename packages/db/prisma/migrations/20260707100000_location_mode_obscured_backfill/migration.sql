-- Location-visibility-reveal spec (2026-06-23): collapse EventLocationMode
-- APPROXIMATE/HIDDEN → OBSCURED (data backfill).
--
-- ⚠ TRANSACTION SEMANTICS: Prisma Migrate wraps each migration file in a
-- single transaction on Postgres, and an ALTER TYPE ... ADD VALUE'd enum
-- value cannot be USED inside the transaction that added it ("unsafe use of
-- new value"). The 'OBSCURED' value referenced below was therefore added by
-- the PREVIOUS migration (20260707095900_location_mode_add_obscured), whose
-- transaction has already committed by the time this file runs. Do NOT merge
-- that ADD VALUE back into this file. (Same constraint documented in
-- 20260701120000_add_community_listings.)
--
-- Migration 20260707100001 then recreates the type as exactly
-- {EXACT, OBSCURED} once no rows reference the legacy values.

-- AlterTable
-- New job cursor for the Step B address-reveal notification fan-out.
-- NULL = not yet fanned out.
ALTER TABLE "Event" ADD COLUMN "address_reveal_notified_at" TIMESTAMPTZ(6);

-- Backfill (a): every legacy APPROXIMATE/HIDDEN event becomes OBSCURED.
-- Product note (spec data.notes): formerly-APPROXIMATE events — which never
-- revealed their exact pin — WILL now reveal it to ticket holders at the
-- backfilled date below. This is the agreed consequence of dropping
-- 'never reveal'.
UPDATE "Event"
SET "locationMode" = 'OBSCURED'
WHERE "locationMode" IN ('APPROXIMATE', 'HIDDEN');

-- Backfill (b): every OBSCURED event must have a reveal date (FR-005 — no
-- 'never reveal'). Rows with a reveal date already set are left alone (c).
--   * future events ("startsAt" > now()): reveal day-before ("startsAt" - 24h)
--   * past/started events: LEAST(now(), "startsAt") — effectively already
--     revealed.
-- The preset is stamped CUSTOM so the edit UI shows the concrete datetime
-- rather than mislabelling it as a relative preset.
UPDATE "Event"
SET "address_reveal_at" = CASE
      WHEN "startsAt" > NOW() THEN "startsAt" - INTERVAL '24 hours'
      ELSE LEAST(NOW(), "startsAt")
    END,
    "address_reveal_preset" = 'CUSTOM'
WHERE "locationMode" = 'OBSCURED'
  AND "address_reveal_at" IS NULL;

-- Backfill (d): mark already-passed reveals as notified so the future reveal
-- job never retro-spams historical events. Only future reveals notify, and
-- only OBSCURED events participate in the reveal fan-out.
UPDATE "Event"
SET "address_reveal_notified_at" = NOW()
WHERE "address_reveal_at" < NOW()
  AND "locationMode" = 'OBSCURED';

-- Persisted waiver auto-select rules (spec risk: "waiver auto-select breaks"):
-- the private-residential rule keyed on locationMode = HIDDEN; after the
-- collapse it triggers on ANY obscured-location event. WaiverClauseAutoRule
-- stores plain strings (not the enum), so this is a data fix, not DDL.
UPDATE "WaiverClauseAutoRule"
SET "value" = 'OBSCURED'
WHERE "field" = 'locationMode'
  AND "value" IN ('APPROXIMATE', 'HIDDEN');
