-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('DELIVERABLE', 'BOUNCED', 'COMPLAINED');

-- AlterTable
ALTER TABLE "auth_user" ADD COLUMN     "email_delivery_status" "EmailDeliveryStatus",
ADD COLUMN     "email_delivery_status_at" TIMESTAMP(3),
ADD COLUMN     "email_delivery_status_ref" TEXT;

-- CreateTable
CREATE TABLE "email_delivery_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auth_user_id" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "email_delivery_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_event_provider_provider_event_id_key" ON "email_delivery_event"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "email_delivery_event_email_idx" ON "email_delivery_event"("email");

-- CreateIndex
CREATE INDEX "email_delivery_event_auth_user_id_idx" ON "email_delivery_event"("auth_user_id");

-- CreateIndex
CREATE INDEX "email_delivery_event_provider_event_type_idx" ON "email_delivery_event"("provider", "event_type");

-- CreateIndex
CREATE INDEX "email_delivery_event_status_occurred_at_idx" ON "email_delivery_event"("status", "occurred_at");

-- AddForeignKey
ALTER TABLE "email_delivery_event" ADD CONSTRAINT "email_delivery_event_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;