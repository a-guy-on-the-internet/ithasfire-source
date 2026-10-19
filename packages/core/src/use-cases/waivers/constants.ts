/**
 * Platform-provided "Standard Volunteer Waiver" template id (FR-010,
 * docs/specs/2026-07-07/completed/ask-level-volunteer-waivers.spec.yaml).
 *
 * A fixed well-known UUID so code (the ask editor's one-click "Use the
 * standard volunteer waiver" option, tests) and SQL agree on the same row.
 * The row is inserted idempotently by migration
 * 20260707150000_add_ask_waiver_template (orgId + humanId null,
 * isDefault true, source FREEFORM) so dev AND prod both get it; the dev
 * seed (apps/api/src/scripts/seed/waivers.ts) additionally ensures it.
 *
 * Platform templates are editor-readonly — updateWaiverTemplate throws
 * PLATFORM_TEMPLATE_READONLY for ownerless templates — so body revisions
 * ship as a follow-up migration that updates `body` AND increments
 * `version` in the same statement, and must update
 * PLATFORM_VOLUNTEER_WAIVER_BODY below to match.
 */
export const PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID =
  "00000000-0000-4000-8000-000000000001";

/**
 * Verbatim body of the platform volunteer waiver (markdown, NO trailing
 * newline). Single source of truth: the dev seed upserts this exact string,
 * and constants.test.ts pins the SQL-escaped copy in the LATEST revising
 * migration to it byte-for-byte. Revisions so far: v1 inserted by
 * 20260707150000_add_ask_waiver_template; v2 ("the venue" → "the place's
 * owners and operators") by 20261017200000_volunteer_waiver_place_wording.
 * If a future migration
 * revises the shipped body (updating `body` + incrementing `version` — the
 * editor can't, see above), update this constant and the test's migration
 * path in the same change.
 */
export const PLATFORM_VOLUNTEER_WAIVER_BODY = `# Volunteer Participation Waiver and Release

Thank you for volunteering. Please read this before signing up.

**1. Voluntary participation.** You are choosing to volunteer. You may stop at any time. You are not an employee or contractor of the organizer, the place's owners and operators, or Ithas Fire, and you will not receive wages. Any thank-you perks (like a comp ticket) are gifts, not compensation.

**2. What volunteering can involve.** Volunteer roles can include physical activity — such as standing for long periods, lifting and carrying equipment, working around stage gear, cables, and sound systems, being in crowded spaces, and being near loud music. You confirm you can safely perform the role you sign up for, and you'll tell the organizer about anything that limits what you can safely do.

**3. Assumption of risk.** Live events carry inherent risks, including slips and falls, hearing exposure, equipment-related injuries, and the actions of other attendees. To the extent permitted by law, you knowingly accept these risks.

**4. Release.** In exchange for being allowed to volunteer, you release the event organizer, the place's owners and operators, their staff, and Ithas Fire from claims for personal injury or property damage arising from ordinary negligence connected with your volunteering. This release does NOT cover gross negligence, recklessness, or intentional misconduct, and it does not limit rights that cannot be waived under applicable law.

**5. Medical care.** If you are injured while volunteering, you consent to reasonable emergency medical care. You are responsible for your own medical costs unless the law provides otherwise.

**6. Following instructions.** You agree to follow the organizer's reasonable safety instructions and the rules of the place's owners and operators while volunteering.

**7. Severability.** If any part of this waiver is found unenforceable, the rest still applies.

*If you have questions about this waiver, ask the organizer before signing up. Organizers: this standard waiver is provided as a convenience and may not fit every situation — review it (ideally with counsel) and replace it with your own template if needed.*`;
