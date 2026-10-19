-- Ask-level volunteer waivers (FR-001 + FR-010,
-- docs/specs/2026-07-07/ask-level-volunteer-waivers.spec.yaml).
--
-- Part 1: additive DDL — nullable VolunteerAsk.waiverTemplateId + FK + index.
--         ON DELETE RESTRICT is deliberate (Event.waiverTemplateId uses
--         SetNull, but deleting a template must never silently disarm a
--         standing ask's liability gate). NO backfill: existing
--         waiverRequired=true asks stay inert until a template is assigned,
--         exactly like the event path's toggle-without-template semantics.
-- Part 2: idempotent seed of the ONE platform-provided "Standard Volunteer
--         Waiver" (orgId + humanId null, isDefault true, source FREEFORM).
--         Its fixed well-known id is exported in code as
--         PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID
--         (packages/core/src/use-cases/waivers/constants.ts) — keep the two
--         in sync. Every statement below is guarded so a re-run is a no-op.

-- AlterTable
ALTER TABLE "VolunteerAsk" ADD COLUMN IF NOT EXISTS "waiverTemplateId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VolunteerAsk_waiverTemplateId_idx" ON "VolunteerAsk"("waiverTemplateId");

-- AddForeignKey (guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'VolunteerAsk_waiverTemplateId_fkey'
      AND conrelid = '"VolunteerAsk"'::regclass
  ) THEN
    ALTER TABLE "VolunteerAsk"
      ADD CONSTRAINT "VolunteerAsk_waiverTemplateId_fkey"
      FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform default volunteer waiver (FR-010). Fixed id + body match
-- PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID / PLATFORM_VOLUNTEER_WAIVER_BODY in
-- packages/core/src/use-cases/waivers/constants.ts (pinned byte-for-byte by
-- constants.test.ts). Platform templates are editor-readonly —
-- updateWaiverTemplate throws PLATFORM_TEMPLATE_READONLY for ownerless
-- templates — so body revisions ship as a follow-up migration that updates
-- "body" AND increments "version" in the same statement, and must update the
-- shared body constant to match. That is also why this INSERT never updates
-- an existing row.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "WaiverTemplate"
  ("id", "orgId", "humanId", "name", "body", "version", "isDefault", "source", "createdAt", "updatedAt")
SELECT
  '00000000-0000-4000-8000-000000000001',
  NULL,
  NULL,
  'Standard Volunteer Waiver',
  '# Volunteer Participation Waiver and Release

Thank you for volunteering. Please read this before signing up.

**1. Voluntary participation.** You are choosing to volunteer. You may stop at any time. You are not an employee or contractor of the organizer, the venue, or Ithas Fire, and you will not receive wages. Any thank-you perks (like a comp ticket) are gifts, not compensation.

**2. What volunteering can involve.** Volunteer roles can include physical activity — such as standing for long periods, lifting and carrying equipment, working around stage gear, cables, and sound systems, being in crowded spaces, and being near loud music. You confirm you can safely perform the role you sign up for, and you''ll tell the organizer about anything that limits what you can safely do.

**3. Assumption of risk.** Live events carry inherent risks, including slips and falls, hearing exposure, equipment-related injuries, and the actions of other attendees. To the extent permitted by law, you knowingly accept these risks.

**4. Release.** In exchange for being allowed to volunteer, you release the event organizer, the venue, their staff, and Ithas Fire from claims for personal injury or property damage arising from ordinary negligence connected with your volunteering. This release does NOT cover gross negligence, recklessness, or intentional misconduct, and it does not limit rights that cannot be waived under applicable law.

**5. Medical care.** If you are injured while volunteering, you consent to reasonable emergency medical care. You are responsible for your own medical costs unless the law provides otherwise.

**6. Following instructions.** You agree to follow the organizer''s reasonable safety instructions and venue rules while volunteering.

**7. Severability.** If any part of this waiver is found unenforceable, the rest still applies.

*If you have questions about this waiver, ask the organizer before signing up. Organizers: this standard waiver is provided as a convenience and may not fit every situation — review it (ideally with counsel) and replace it with your own template if needed.*',
  1,
  true,
  'FREEFORM'::"WaiverTemplateSource",
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM "WaiverTemplate" WHERE "id" = '00000000-0000-4000-8000-000000000001'
);
