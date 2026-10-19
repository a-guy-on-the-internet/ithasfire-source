-- Gap 3 (volunteer-system-gaps spec, 2026-06-10): volunteer form + waiver
-- tied to the Human profile.
--
-- 1. Event.volunteerWaiverRequired — when true AND the event has an assigned
--    waiver template, volunteer signups are gated on waiver acceptance.
-- 2. VolunteerWaiverAcceptance — immutable acceptance record keyed to the
--    Human profile (returning volunteers with a current acceptance skip
--    re-signing) and to the signup that prompted it. Mirrors the field
--    conventions of WaiverAcceptance (order-keyed checkout acceptances).

-- AlterTable
ALTER TABLE "Event"
  ADD COLUMN "volunteerWaiverRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VolunteerWaiverAcceptance" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "waiverTemplateId" TEXT NOT NULL,
    "waiverVersion" INTEGER NOT NULL,
    "waiverBodyHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "VolunteerWaiverAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerWaiverAcceptance_signupId_key" ON "VolunteerWaiverAcceptance"("signupId");

-- CreateIndex
CREATE INDEX "VolunteerWaiverAcceptance_humanId_waiverTemplateId_idx" ON "VolunteerWaiverAcceptance"("humanId", "waiverTemplateId");

-- AddForeignKey
ALTER TABLE "VolunteerWaiverAcceptance" ADD CONSTRAINT "VolunteerWaiverAcceptance_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerWaiverAcceptance" ADD CONSTRAINT "VolunteerWaiverAcceptance_signupId_fkey" FOREIGN KEY ("signupId") REFERENCES "VolunteerSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerWaiverAcceptance" ADD CONSTRAINT "VolunteerWaiverAcceptance_waiverTemplateId_fkey" FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
