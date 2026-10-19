-- CreateTable
-- Transactional outbox for reliable object-storage (R2/S3) deletions. The
-- delete intent is written here in the same DB transaction as the owning row's
-- cascade; a scheduled drain job removes the objects with retries + exponential
-- backoff and dead-letters rows that exhaust their attempt budget. See
-- packages/db/prisma/storage.prisma.
CREATE TABLE "pending_object_deletion" (
    "id" TEXT NOT NULL,
    "target_key" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_object_deletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_object_deletion_status_next_attempt_at_idx" ON "pending_object_deletion"("status", "next_attempt_at");
