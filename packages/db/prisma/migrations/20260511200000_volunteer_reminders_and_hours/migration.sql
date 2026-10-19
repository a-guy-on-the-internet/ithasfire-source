-- VolunteerSignup gains two columns and a notifications relation.
ALTER TABLE "VolunteerSignup"
  ADD COLUMN "smsOptIn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "VolunteerSignup"
  ADD COLUMN "hoursWorked" DECIMAL(5, 2);

-- VolunteerReminderKind drives the cron dispatcher's idempotency.
CREATE TYPE "VolunteerReminderKind" AS ENUM ('REMINDER_24H', 'REMINDER_1H');

CREATE TABLE "VolunteerShiftNotification" (
  "id"       TEXT NOT NULL,
  "signupId" TEXT NOT NULL,
  "kind"     "VolunteerReminderKind" NOT NULL,
  "channel"  TEXT NOT NULL,
  "sentAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VolunteerShiftNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VolunteerShiftNotification_signupId_kind_channel_key"
  ON "VolunteerShiftNotification"("signupId", "kind", "channel");

CREATE INDEX "VolunteerShiftNotification_signupId_idx"
  ON "VolunteerShiftNotification"("signupId");

ALTER TABLE "VolunteerShiftNotification"
  ADD CONSTRAINT "VolunteerShiftNotification_signupId_fkey"
  FOREIGN KEY ("signupId") REFERENCES "VolunteerSignup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
