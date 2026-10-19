-- Review aggregate snapshot table (attendee-reviews FR-004, 2026-07-14).
--
-- Generic snapshot-not-live publication for attendee reviews: one review rolls
-- up to four subject types (EVENT | PLACE | OWNER | SERIES), and the weekly
-- recompute-review-aggregates job materializes the suppressed, coarsened public
-- snapshot per subject into a row here. Public reads serve `snapshot` verbatim
-- and never touch live AttendeeReview rows — the snapshot delay is the anonymity
-- mechanism (same defense as PlaceStats.publicSnapshot). See
-- packages/db/prisma/review-aggregate.prisma.

-- CreateEnum
CREATE TYPE "ReviewAggregateSubjectType" AS ENUM ('EVENT', 'PLACE', 'OWNER', 'SERIES');

-- CreateTable
CREATE TABLE "ReviewAggregate" (
    "id" TEXT NOT NULL,
    "subjectType" "ReviewAggregateSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAggregate_subjectType_subjectId_key" ON "ReviewAggregate"("subjectType", "subjectId");
