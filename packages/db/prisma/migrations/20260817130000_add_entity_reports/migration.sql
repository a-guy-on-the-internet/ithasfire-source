-- Entity report intake (spec 2026-08-17).
-- Adds the EntityReport moderation queue: polymorphic subject pointer
-- (subjectType + subjectId, no FK — reports survive subject deletion),
-- plain-string human ids (house style, mirrors EventEditSuggestion), and the
-- PENDING → RESOLVED/DISMISSED review lifecycle. Fully additive; no backfill.

-- CreateEnum
CREATE TYPE "EntityReportSubjectType" AS ENUM ('PLACE', 'HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "EntityReportReason" AS ENUM ('CLOSED_OR_GONE', 'INCORRECT_INFO', 'DUPLICATE', 'INAPPROPRIATE', 'SPAM', 'IMPERSONATION', 'OTHER');

-- CreateEnum
CREATE TYPE "EntityReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "EntityReport" (
    "id" TEXT NOT NULL,
    "subjectType" "EntityReportSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "reporterHumanId" TEXT NOT NULL,
    "reason" "EntityReportReason" NOT NULL,
    "details" TEXT,
    "status" "EntityReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntityReport_status_createdAt_idx" ON "EntityReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EntityReport_subjectType_subjectId_status_idx" ON "EntityReport"("subjectType", "subjectId", "status");

-- CreateIndex
CREATE INDEX "EntityReport_reporterHumanId_status_idx" ON "EntityReport"("reporterHumanId", "status");

-- DB backstop for the one-PENDING-report-per-(reporter, subject) rule
-- (entity-report-intake.spec.yaml FR-003). The use-case pre-check in
-- submit-entity-report races under concurrency (double-click submit → two
-- PENDING rows); this partial unique index makes the loser fail with P2002,
-- which the adapter maps to the same REPORT_ALREADY_OPEN domain error.
--
-- Partial indexes are not expressible in the Prisma schema — this index is
-- SQL-only (noted on the EntityReport model in moderation.prisma). Same trick
-- as "BookingRequest_open_pair_key" (20260610120000) and the
-- "EventApplicationSubmission_open_*_key" pair (20260811140000).
CREATE UNIQUE INDEX "EntityReport_open_reporter_subject_key"
  ON "EntityReport"("reporterHumanId", "subjectType", "subjectId")
  WHERE "status" = 'PENDING';
