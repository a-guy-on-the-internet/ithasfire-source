-- arrival-areas FR-011: an arrival area can be reported, and the report keeps
-- a snapshot of what the reporter saw.
--
-- Nothing in this migration uses the new enum value: Postgres does not allow a
-- value added by ALTER TYPE ... ADD VALUE to be used in the transaction that
-- added it. The column below is plain JSONB, so both statements are safe here.

-- AlterEnum
ALTER TYPE "EntityReportSubjectType" ADD VALUE 'ARRIVAL_AREA';

-- AlterTable
ALTER TABLE "EntityReport" ADD COLUMN "subjectSnapshot" JSONB;
