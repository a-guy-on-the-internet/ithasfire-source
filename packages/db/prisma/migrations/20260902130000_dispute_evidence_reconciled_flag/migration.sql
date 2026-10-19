-- DisputeEvidence.reconciledFromProcessor (dispute desk, step 2 follow-up).
--
-- Set when the row was brought into line with a submission the processor
-- already held (an earlier submit crashed between Stripe's accept and our
-- commit). NULL/false = submitted from the desk.
--
-- Its OWN folder on purpose: the column was first appended to
-- 20260901120000_dispute_evidence_package after that migration had already
-- been recorded on a dev database, so the edited file's checksum no longer
-- matched, `migrate deploy` skipped it, and every DisputeEvidence read threw
-- ColumnNotFound until it was applied by hand. A recorded migration is
-- immutable; new DDL gets a new folder. Additive; re-applicable.

-- AlterTable
ALTER TABLE "DisputeEvidence" ADD COLUMN IF NOT EXISTS "reconciledFromProcessor" BOOLEAN;
