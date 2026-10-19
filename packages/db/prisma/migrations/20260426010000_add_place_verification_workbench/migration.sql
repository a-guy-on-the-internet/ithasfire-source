-- Places admin v2 — verification workbench groundwork.
--
-- Spec: docs/specs/2026-04-26/places-admin-v2.spec.md
--
-- Additive changes to PlaceVerificationRequest so platform admins can run
-- a real review workbench:
--   * IN_REVIEW status — set when a platform admin acknowledges a request
--     and starts reviewing it (locks the request to that admin).
--   * WITHDRAWN status — set when the organizer cancels their own pending
--     request. Preserves documents + audit trail vs. hard-deleting.
--   * `acknowledgedAt` / `acknowledgedBy` columns to track who picked up
--     the request and when. Drives queue lock UX + SLA reporting.
--   * Composite index on (status, "createdAt") for the queue query
--     (ORDER BY createdAt within each status).

-- AlterEnum: add IN_REVIEW + WITHDRAWN
ALTER TYPE "PlaceVerificationRequestStatus" ADD VALUE 'IN_REVIEW';
ALTER TYPE "PlaceVerificationRequestStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable: acknowledge tracking
ALTER TABLE "PlaceVerificationRequest"
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "acknowledgedBy" TEXT;

-- AddForeignKey: acknowledger relation (nullable, no cascade — preserve audit)
ALTER TABLE "PlaceVerificationRequest"
  ADD CONSTRAINT "PlaceVerificationRequest_acknowledgedBy_fkey"
  FOREIGN KEY ("acknowledgedBy") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: powers ORDER BY createdAt within status filter for the queue
CREATE INDEX "PlaceVerificationRequest_status_createdAt_idx"
  ON "PlaceVerificationRequest"("status", "createdAt");
