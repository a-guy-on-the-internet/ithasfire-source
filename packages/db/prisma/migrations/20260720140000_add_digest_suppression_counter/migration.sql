-- attendee-prompt-delivery-hygiene FR-003: soft auto-suppression counter +
-- last-sent cursor on the per-human digest subscription.
ALTER TABLE "NotificationDigestSubscription"
  ADD COLUMN "consecutiveIgnored" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDigestSentAt" TIMESTAMP(3);
