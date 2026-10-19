-- ═══════════════════════════════════════════════════════════════════════════
-- BOOKING REQUEST ASKS — a venue's typed ask on a booking thread, with the
-- sender's saved answer (docs/specs/2026-09-25/venue-booking-standards.spec.yaml
-- v1.1: V9–V11, FR-009).
--
--   · BookingRequestAsk           — one ask; kind decides the answer column.
--   · BookingRequestAttachment
--       .askId                    — the ask a file was uploaded to answer.
--
-- Two SQL-only CHECKs (Prisma cannot express them):
--   · "BookingRequestAsk_answer_shape_check" — answer columns are exclusive
--     per kind, and SET_LENGTH minutes sit in 5–600. It does NOT demand a
--     non-null attachment on an ANSWERED IMAGE / FILE ask: that FK is
--     ON DELETE SET NULL, and a CHECK that a SetNull could violate would turn
--     the request cascade into a constraint error.
--   · "BookingRequestAsk_use_as_event_image_check" — only IMAGE asks may be
--     marked "Use as the event image".
--
-- Additive only: two enums, one table, one nullable column, indexes, FKs.
-- No backfill (no ask exists before this migration).
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "BookingRequestAskKind" AS ENUM ('IMAGE', 'FILE', 'LINK', 'TEXT', 'SET_LENGTH');

-- CreateEnum
CREATE TYPE "BookingRequestAskStatus" AS ENUM ('OPEN', 'ANSWERED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "BookingRequestAsk" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "kind" "BookingRequestAskKind" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "note" VARCHAR(240),
    "standardField" "BookingStandardField",
    "useAsEventImage" BOOLEAN NOT NULL DEFAULT false,
    "status" "BookingRequestAskStatus" NOT NULL DEFAULT 'OPEN',
    "askedByHumanId" TEXT NOT NULL,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answerAttachmentId" TEXT,
    "answerUrl" VARCHAR(2048),
    "answerText" VARCHAR(2000),
    "answerMinutes" INTEGER,
    "answeredByHumanId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answerRevision" INTEGER NOT NULL DEFAULT 0,
    "withdrawnByHumanId" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "eventImageEventId" TEXT,
    "eventImageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequestAsk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BookingRequestAsk_label_not_blank_check" CHECK (length(btrim("label")) > 0),
    CONSTRAINT "BookingRequestAsk_use_as_event_image_check" CHECK (NOT "useAsEventImage" OR "kind" = 'IMAGE'),
    CONSTRAINT "BookingRequestAsk_answer_shape_check" CHECK (
      CASE "kind"
        WHEN 'IMAGE' THEN "answerUrl" IS NULL AND "answerText" IS NULL AND "answerMinutes" IS NULL
        WHEN 'FILE' THEN "answerUrl" IS NULL AND "answerText" IS NULL AND "answerMinutes" IS NULL
        WHEN 'LINK' THEN "answerAttachmentId" IS NULL AND "answerText" IS NULL AND "answerMinutes" IS NULL
        WHEN 'TEXT' THEN "answerAttachmentId" IS NULL AND "answerUrl" IS NULL AND "answerMinutes" IS NULL
        WHEN 'SET_LENGTH' THEN "answerAttachmentId" IS NULL AND "answerUrl" IS NULL AND "answerText" IS NULL
          AND ("answerMinutes" IS NULL OR "answerMinutes" BETWEEN 5 AND 600)
      END
    )
);

-- AlterTable
ALTER TABLE "BookingRequestAttachment" ADD COLUMN "askId" TEXT;

-- CreateIndex
CREATE INDEX "BookingRequestAsk_bookingRequestId_askedAt_idx" ON "BookingRequestAsk"("bookingRequestId", "askedAt");

-- CreateIndex
CREATE INDEX "BookingRequestAsk_answerAttachmentId_idx" ON "BookingRequestAsk"("answerAttachmentId");

-- CreateIndex
CREATE INDEX "BookingRequestAttachment_askId_idx" ON "BookingRequestAttachment"("askId");

-- AddForeignKey
ALTER TABLE "BookingRequestAsk" ADD CONSTRAINT "BookingRequestAsk_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestAsk" ADD CONSTRAINT "BookingRequestAsk_answerAttachmentId_fkey" FOREIGN KEY ("answerAttachmentId") REFERENCES "BookingRequestAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestAttachment" ADD CONSTRAINT "BookingRequestAttachment_askId_fkey" FOREIGN KEY ("askId") REFERENCES "BookingRequestAsk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
