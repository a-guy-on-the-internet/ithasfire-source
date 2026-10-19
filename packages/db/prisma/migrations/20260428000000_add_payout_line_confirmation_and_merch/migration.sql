-- Event revenue splits + payout terms UI
-- Spec: docs/specs/2026-04-26/event-revenue-splits.spec.md
--
-- Schema additions to support:
--   * Per-line acknowledgement state on PayoutTermsLine (informational; not
--     a publish gate). Owner lines auto-stamp requiresConfirmation = false;
--     non-owner lines start in PENDING. CONFIRM ships in v1; COUNTER and
--     DECLINE are scaffolded (enum + columns) but their use-case branches
--     return not_implemented until the v2 build.
--   * MERCH payout-terms kind + Event.merchPayoutTermsId so the data model
--     accommodates merch revenue when POS goes live. UI deferred.
--
-- No backfill needed for existing PayoutTermsLine rows — they default to
-- requiresConfirmation = false (the historical assumption was that lines
-- pointed at the event owner). updateEventSplits will re-stamp the flag
-- correctly on next edit.

-- AlterEnum: add MERCH to PayoutTermsKind.
ALTER TYPE "PayoutTermsKind" ADD VALUE 'MERCH';

-- CreateEnum: PayoutLineConfirmationStatus
CREATE TYPE "PayoutLineConfirmationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COUNTERED', 'DECLINED');

-- AlterTable: PayoutTermsLine
ALTER TABLE "PayoutTermsLine"
  ADD COLUMN "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "confirmationStatus" "PayoutLineConfirmationStatus",
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "counterPercentBps" INTEGER,
  ADD COLUMN "counterNote" TEXT;

-- CreateIndex
CREATE INDEX "PayoutTermsLine_payoutTermsId_confirmationStatus_idx" ON "PayoutTermsLine"("payoutTermsId", "confirmationStatus");

-- AlterTable: Event.merchPayoutTermsId (nullable FK; schema-only in v1)
ALTER TABLE "Event"
  ADD COLUMN "merch_payout_terms_id" TEXT;

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_merch_payout_terms_id_fkey" FOREIGN KEY ("merch_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
