-- Volunteer role template shifts
-- Spec: docs/specs/2026-04-28/volunteer-template-shift-times.spec.md
--
-- Adds shift presets to org-level volunteer role templates. Stored as
-- time-of-day (minute-of-day) plus an optional day offset from the event
-- date — the same pattern used by When I Work, Sling, Mobilize. Times
-- are materialized to absolute `startsAt`/`endsAt` at apply time and
-- confirmed by the organizer via the shift composer; this table never
-- auto-persists `EventVolunteerShift` rows.
--
-- Migration is purely additive. Existing templates have zero rows here,
-- so the apply-template flow continues to work for them as before.

CREATE TABLE "VolunteerRoleTemplateShift" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startMinuteOfDay" INTEGER NOT NULL,
    "endMinuteOfDay" INTEGER NOT NULL,
    "startDayOffset" INTEGER NOT NULL DEFAULT 0,
    "endsNextDay" BOOLEAN NOT NULL DEFAULT false,
    "capacity" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerRoleTemplateShift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VolunteerRoleTemplateShift_templateId_position_idx"
    ON "VolunteerRoleTemplateShift"("templateId", "position");

ALTER TABLE "VolunteerRoleTemplateShift"
    ADD CONSTRAINT "VolunteerRoleTemplateShift_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "VolunteerRoleTemplate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
