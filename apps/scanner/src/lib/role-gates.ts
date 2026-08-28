/**
 * Org role gates for the scanner UI.
 *
 * The scanner-session-context query returns the operator's role for the
 * currently selected event (`currentEvent.role`). Surfaces use these helpers
 * to decide which CTAs to render or disable.
 *
 * Source of truth: packages/core/src/lib/rbac.ts (ORG_EDIT_ROLES /
 * ORG_SCAN_ROLES). We hand-mirror the membership lists here as plain string
 * sets to avoid pulling the core package's RBAC module into the Expo bundle.
 * If the canonical list ever changes, update both — the spec
 * (unified-scan-resolver.spec.yaml §FR-008) treats this gate as load-bearing
 * for not auto-enabling the volunteer check-in CTA for SCANNER-only
 * operators.
 */

const ORG_EDIT_ROLES = new Set(["OWNER", "ADMIN", "EDITOR"]);

/**
 * Volunteer check-in writes (`volunteer.signups.checkIn`) require an edit
 * role. Read-only enrichment (`scan.resolvePayload`'s `alsoVolunteering` /
 * `candidates`) is available to SCANNER role too.
 */
export const canCheckInVolunteers = (
  role: string | null | undefined,
): boolean => !!role && ORG_EDIT_ROLES.has(role);
