-- ═══════════════════════════════════════════════════════════════════════════
-- BookingRequest.billRecorded — "this request was created WITH a bill"
-- (lineup-booking-requests v3, L12 / FR-006; docs/specs/2026-09-25/
-- lineup-booking-requests-v3.spec.yaml).
--
-- Since L12 a PERFORM request may carry an EMPTY bill (the sender off it, no
-- acts), which writes zero BookingRequestAct rows — exactly what a request
-- sent before bills existed looks like. The event mint must tell them apart:
-- a pre-bill request gets the "sender headlines" fallback, an empty bill
-- mints an empty lineup. This column is that distinction, stated explicitly
-- on the request rather than inferred from its children.
--
-- Additive: one NOT NULL boolean with a default, so every existing row is
-- FALSE (pre-bill) — then TRUE for any request that already has an act row
-- (created by the v2 bill code: it recorded a bill, it just had no flag).
-- On the dev DB at 2026-09-30 that backfill matches 0 of 15 requests.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN "billRecorded" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a request with any act row (removed rows included) recorded a bill.
UPDATE "BookingRequest" r
SET "billRecorded" = true
WHERE EXISTS (
  SELECT 1 FROM "BookingRequestAct" a WHERE a."bookingRequestId" = r.id
);
