/**
 * Pure helpers for the ORGANIZER-ISSUED volunteer badge sheet.
 *
 * Extracted so the parts that decide WHO gets a badge — and what a badge is
 * allowed to say — are unit-testable without a browser, a theme provider or a
 * tRPC client. Nothing here formats for print; the sheet owns that.
 *
 * ── The product boundary these helpers enforce ────────────────────────────
 * A badge is CREDENTIAL STOCK. It reads as authorization at a door, so it is
 * issued by the organizer or venue — the party accountable there — and never
 * self-served by the volunteer. A volunteer's own printable QR is a separate,
 * later surface and is only ever "scan me in".
 *
 * Two consequences show up directly in this file:
 *   - APPROVED only. `mintVolunteerScanToken` refuses anything else with
 *     SIGNUP_NOT_APPROVED, so a PENDING/REJECTED/WITHDRAWN/CHECKED_IN/NO_SHOW
 *     row must be filtered out HERE rather than allowed to throw per row.
 *   - One badge per HUMAN, not per signup. The scan token is human+event
 *     scoped (`packages/ports/src/volunteer-scan-token.ts`), so a volunteer
 *     working three shifts has ONE credential covering all three — and wears
 *     one badge, not three.
 */

/** The subset of `volunteer.signups.list` rows this document reads. */
export type BadgeSignupRow = {
  id: string;
  humanId: string | null;
  roleId: string;
  shiftId: string | null;
  contactName: string | null;
  contactEmail: string;
  status: string;
};

/** The subset of `volunteer.roles.list` rows this document reads. */
export type BadgeRoleRow = {
  id: string;
  name: string;
  shifts: ReadonlyArray<{
    id: string;
    label: string | null;
    startsAt: Date;
    endsAt: Date;
  }>;
};

/** One role + shift a volunteer is approved for. */
export type BadgeAssignment = {
  /** Stable react key — the signup this assignment came from. */
  signupId: string;
  roleName: string | null;
  shiftLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

/** One badge: one human, one credential, one or more assignments. */
export type BadgeRecipient = {
  humanId: string;
  /**
   * The signup handed to `mintScanToken`. Any APPROVED signup of this human
   * on this event mints the SAME human+event token, so which one we pick is
   * immaterial — but it must be deterministic, or a re-render would re-mint
   * against a different signup and scatter the audit trail across rows.
   * Hence: the earliest assignment, by shift start then signup id.
   */
  mintSignupId: string;
  /** What the door reads first. `contactName`, else the contact email. */
  name: string;
  assignments: BadgeAssignment[];
};

export type SelectBadgeRecipientsResult = {
  recipients: BadgeRecipient[];
  /**
   * APPROVED signups with no `humanId`. These cannot mint a token at all
   * (`SIGNUP_MISSING_HUMAN`), so they get no badge — but they ARE on the
   * roster, and silently dropping a person from a credential run is exactly
   * the failure a door notices and the sheet cannot explain. Counted so the
   * screen can say so.
   */
  unissuableCount: number;
};

const APPROVED = "APPROVED";

/**
 * Order two assignments the way a shift list reads: earliest first, undated
 * last, ties broken by signup id so the output is stable across refetches.
 */
const compareAssignments = (a: BadgeAssignment, b: BadgeAssignment): number => {
  const at = a.startsAt ? a.startsAt.getTime() : Number.POSITIVE_INFINITY;
  const bt = b.startsAt ? b.startsAt.getTime() : Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.signupId.localeCompare(b.signupId);
};

/**
 * Group an event's APPROVED volunteer signups into one badge per human.
 *
 * Alphabetical by display name, because a badge run is handed out from a
 * table: staff find a person by name, never by shift time. Ties fall back to
 * `humanId` so the order cannot flicker between renders.
 */
export const selectBadgeRecipients = (
  signups: ReadonlyArray<BadgeSignupRow>,
  roles: ReadonlyArray<BadgeRoleRow>,
): SelectBadgeRecipientsResult => {
  const roleNameById = new Map<string, string>();
  const shiftById = new Map<
    string,
    { label: string | null; startsAt: Date; endsAt: Date }
  >();
  for (const role of roles) {
    roleNameById.set(role.id, role.name);
    for (const shift of role.shifts) {
      shiftById.set(shift.id, {
        label: shift.label,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
      });
    }
  }

  /**
   * `declaredName` is tracked apart from `emailFallback` on purpose: a
   * volunteer can sign up twice and supply their name on only one of the two
   * rows. Collapsing the two into a single "name" field the moment the first
   * row is seen would print an email address on the badge of somebody whose
   * name we demonstrably hold.
   */
  type Draft = {
    humanId: string;
    declaredName: string | null;
    emailFallback: string;
    assignments: BadgeAssignment[];
  };

  const byHuman = new Map<string, Draft>();
  let unissuableCount = 0;

  for (const signup of signups) {
    if (signup.status !== APPROVED) continue;
    if (!signup.humanId) {
      unissuableCount += 1;
      continue;
    }

    const shift = signup.shiftId ? shiftById.get(signup.shiftId) : undefined;
    const assignment: BadgeAssignment = {
      signupId: signup.id,
      roleName: roleNameById.get(signup.roleId) ?? null,
      shiftLabel: shift?.label ?? null,
      startsAt: shift?.startsAt ?? null,
      endsAt: shift?.endsAt ?? null,
    };
    const declared = signup.contactName?.trim() || null;

    const existing = byHuman.get(signup.humanId);
    if (existing) {
      existing.assignments.push(assignment);
      existing.declaredName = existing.declaredName ?? declared;
      continue;
    }

    byHuman.set(signup.humanId, {
      humanId: signup.humanId,
      declaredName: declared,
      emailFallback: signup.contactEmail,
      assignments: [assignment],
    });
  }

  const recipients = Array.from(byHuman.values()).map((draft) => {
    const assignments = [...draft.assignments].sort(compareAssignments);
    return {
      humanId: draft.humanId,
      name: draft.declaredName ?? draft.emailFallback,
      assignments,
      // Deterministic mint source: the earliest assignment. Every APPROVED
      // signup of this human on this event mints the same human+event token,
      // so this only fixes WHICH audit row records the issue.
      mintSignupId: assignments[0]?.signupId ?? draft.assignments[0].signupId,
    } satisfies BadgeRecipient;
  });

  recipients.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
    });
    if (byName !== 0) return byName;
    return a.humanId.localeCompare(b.humanId);
  });

  return { recipients, unissuableCount };
};

/**
 * Split the run into fixed-width rows.
 *
 * The badge sheet paginates on ROWS, not on badges, and it does so in plain
 * BLOCK FLOW — see the header comment in `volunteer-badge-sheet.css`. Forced
 * page breaks (`break-before: page`) are only reliable on block-level boxes;
 * inside a CSS grid or flex container browsers have historically ignored
 * them, and "how many badges per sheet" is a property a box office has to be
 * able to rely on. So the rows are real elements in the markup rather than an
 * emergent property of a wrapping layout.
 */
export const chunkIntoRows = <T>(items: ReadonlyArray<T>, perRow: number): T[][] => {
  if (perRow < 1) throw new Error("perRow must be at least 1");
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) {
    rows.push(items.slice(i, i + perRow));
  }
  return rows;
};
