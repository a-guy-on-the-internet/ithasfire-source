-- CreateEnum
CREATE TYPE "SupportThreadStatus" AS ENUM ('AWAITING_HUMAN', 'OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportThreadSource" AS ENUM ('WIDGET', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SupportAuthorType" AS ENUM ('USER', 'HUMAN_AGENT', 'AI_CLERK', 'SYSTEM');

-- CreateTable
CREATE TABLE "support_thread" (
    "id" TEXT NOT NULL,
    "human_id" TEXT NOT NULL,
    "event_id" TEXT,
    "order_id" TEXT,
    "status" "SupportThreadStatus" NOT NULL DEFAULT 'OPEN',
    "source" "SupportThreadSource" NOT NULL DEFAULT 'WIDGET',
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_message" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "author_type" "SupportAuthorType" NOT NULL,
    "author_human_id" TEXT,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_thread_status_last_message_at_idx" ON "support_thread"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "support_thread_human_id_idx" ON "support_thread"("human_id");

-- CreateIndex
CREATE INDEX "support_message_thread_id_created_at_idx" ON "support_message"("thread_id", "created_at");

-- AddForeignKey
ALTER TABLE "support_thread" ADD CONSTRAINT "support_thread_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_thread" ADD CONSTRAINT "support_thread_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_thread" ADD CONSTRAINT "support_thread_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "support_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
