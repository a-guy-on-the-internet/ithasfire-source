-- Standard Volunteer Waiver, version bump: "venue" goes. Sections 1, 4
-- and 6 named a party as "the venue"; they now name "the place's owners
-- and operators" (owner ruling 2026-10-17: in legal text "place" is the
-- location, and a party is named as the people). Returning volunteers sign
-- once more the next time they sign up for a shift.
--
-- Data only, no schema change. Platform templates are editor-readonly
-- (updateWaiverTemplate throws PLATFORM_TEMPLATE_READONLY), so a body
-- revision ships as a migration that updates "body" AND increments "version"
-- in the same statement (see 20260707150000_add_ask_waiver_template). The
-- new body matches PLATFORM_VOLUNTEER_WAIVER_BODY in
-- packages/core/src/use-cases/waivers/constants.ts byte-for-byte
-- (constants.test.ts pins it). Acceptance rows keep the version and body
-- hash they were signed under; a volunteer who accepted the old version is
-- no longer "already on file" for the new one.
--
-- Idempotent: the WHERE clause skips a row already at version 2, so a
-- re-run never bumps twice. It keys on the version, not the body, because the
-- dev seed upserts the new body without touching "version"; a body guard
-- would leave a re-seeded dev database at version 1. A database without the row
-- (none in practice; 20260707150000 inserts it) updates nothing.
UPDATE "WaiverTemplate"
SET
  "body" = '# Volunteer Participation Waiver and Release

Thank you for volunteering. Please read this before signing up.

**1. Voluntary participation.** You are choosing to volunteer. You may stop at any time. You are not an employee or contractor of the organizer, the place''s owners and operators, or Ithas Fire, and you will not receive wages. Any thank-you perks (like a comp ticket) are gifts, not compensation.

**2. What volunteering can involve.** Volunteer roles can include physical activity — such as standing for long periods, lifting and carrying equipment, working around stage gear, cables, and sound systems, being in crowded spaces, and being near loud music. You confirm you can safely perform the role you sign up for, and you''ll tell the organizer about anything that limits what you can safely do.

**3. Assumption of risk.** Live events carry inherent risks, including slips and falls, hearing exposure, equipment-related injuries, and the actions of other attendees. To the extent permitted by law, you knowingly accept these risks.

**4. Release.** In exchange for being allowed to volunteer, you release the event organizer, the place''s owners and operators, their staff, and Ithas Fire from claims for personal injury or property damage arising from ordinary negligence connected with your volunteering. This release does NOT cover gross negligence, recklessness, or intentional misconduct, and it does not limit rights that cannot be waived under applicable law.

**5. Medical care.** If you are injured while volunteering, you consent to reasonable emergency medical care. You are responsible for your own medical costs unless the law provides otherwise.

**6. Following instructions.** You agree to follow the organizer''s reasonable safety instructions and the rules of the place''s owners and operators while volunteering.

**7. Severability.** If any part of this waiver is found unenforceable, the rest still applies.

*If you have questions about this waiver, ask the organizer before signing up. Organizers: this standard waiver is provided as a convenience and may not fit every situation — review it (ideally with counsel) and replace it with your own template if needed.*',
  "version" = 2,
  "updatedAt" = now()
WHERE "id" = '00000000-0000-4000-8000-000000000001'
  AND "version" < 2;
