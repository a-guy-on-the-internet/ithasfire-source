-- Expo push receipt outbox. The Expo send API returns per-message *tickets*
-- immediately, but many dead installs (DeviceNotRegistered) are only reported
-- in the *receipt* phase ~15 minutes later — so ok-tickets alone can never
-- prune a dead device. The ExpoPushAdapter send path persists one PushReceipt
-- row per ok-ticket (best-effort — a persist failure never fails the send)
-- and the scheduled `push.drain-receipts` job polls due rows
-- (checkAfter <= now) against getPushNotificationReceiptsAsync:
--   * invalid-token receipt (DeviceNotRegistered / InvalidCredentials) →
--     disable the PushDevice row, delete the receipt row;
--   * ok / other-error receipt → delete the receipt row;
--   * receipt missing → bump attempts + push checkAfter back, give up and
--     delete after a small budget (Expo prunes receipts after ~24h).
-- The table therefore drains to empty. Fully additive: one new table,
-- cascading from PushDevice on hard-delete (devices are soft-disabled in
-- normal operation; hard-deletes only happen via the Human cascade, where the
-- pending receipt is meaningless).

-- CreateTable
CREATE TABLE "PushReceipt" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "pushDeviceId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checkAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushReceipt_ticketId_key" ON "PushReceipt"("ticketId");

-- CreateIndex
CREATE INDEX "PushReceipt_checkAfter_idx" ON "PushReceipt"("checkAfter");

-- CreateIndex
CREATE INDEX "PushReceipt_pushDeviceId_idx" ON "PushReceipt"("pushDeviceId");

-- AddForeignKey
ALTER TABLE "PushReceipt" ADD CONSTRAINT "PushReceipt_pushDeviceId_fkey" FOREIGN KEY ("pushDeviceId") REFERENCES "PushDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
