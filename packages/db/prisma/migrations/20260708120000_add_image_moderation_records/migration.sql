-- CreateTable
-- Key-based image moderation record + async drain outbox. One row per moderated
-- public object, keyed by its R2 storage key. `status = 'PENDING'` is the drain
-- worker's to-do state; the worker calls the Content Safety provider and flips
-- the row to APPROVED/FLAGGED. Read-time gating hides any object whose record is
-- not APPROVED; ABSENCE of a record (legacy objects) is treated as APPROVED.
-- `status`/`kind`/`subject_type` are plain strings validated in app code (not
-- Prisma enums — see PendingObjectDeletion / Settlement house style).
-- See packages/db/prisma/moderation.prisma.
CREATE TABLE "image_moderation_records" (
    "id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "subject_type" TEXT,
    "subject_id" TEXT,
    "public_url" TEXT,
    "content_type" TEXT,
    "created_by_human_id" TEXT,
    "max_severity" INTEGER,
    "categories" JSONB,
    "provider" TEXT,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "moderated_at" TIMESTAMP(3),
    "reviewed_by_human_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_moderation_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "image_moderation_records_storage_key_key" ON "image_moderation_records"("storage_key");

-- CreateIndex
CREATE INDEX "image_moderation_records_status_next_attempt_at_idx" ON "image_moderation_records"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "image_moderation_records_status_moderated_at_idx" ON "image_moderation_records"("status", "moderated_at");

-- CreateIndex
CREATE INDEX "image_moderation_records_subject_type_subject_id_idx" ON "image_moderation_records"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "image_moderation_records_created_by_human_id_idx" ON "image_moderation_records"("created_by_human_id");

-- AddForeignKey
ALTER TABLE "image_moderation_records" ADD CONSTRAINT "image_moderation_records_created_by_human_id_fkey" FOREIGN KEY ("created_by_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
