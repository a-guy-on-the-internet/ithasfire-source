import type { Commitment } from "../../../_components/my-volunteering-helpers";

/**
 * Pure selection logic for THE VOLUNTEER'S OWN CHECK-IN CODE.
 *
 * ── This is a QR, not a badge, and the difference is enforced here ────────
 *
 * A BADGE is credential stock: it reads as authorization at a door, so it is
 * issued by the organizer or venue — the party accountable there — and is
 * printed from `/admin/…/volunteers/badges/print`.
 *
 * THIS document is the volunteer's own "scan me in", for the volunteer whose
 * phone is dead. It admits nobody by itself; an org-edit/scan operator still
 * has to resolve it and check the person in. Nothing in this module may grow
 * toward issuance, and nothing that reads as venue-issued belongs on it — see
 * the standing note on `VolunteerScanTokenPort`.
 *
 * ── Why the document is scoped to an EVENT, not to a signup ───────────────
 *
 * The scan token is human+event scoped, so ONE code already covers every
 * eligible signup a volunteer holds at an event. Printing one sheet per shift
 * would hand somebody three pieces of paper carrying the identical code and
 * invite them to think the codes differ. So the document takes an event and
 * lists every approved shift under a single symbol.
 */

/** One approved shift on the printed code. */
export type QrShift = {
  /** `claimId ?? signupId` — see `commitmentRowKey`. Occurrence rows repeat. */
  key: string;
  signupId: string;
  roleName: string;
  shiftLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

/** Everything the sheet needs about the event the code is scoped to. */
export type QrSubject = {
  eventId: string;
  eventTitle: string;
  /** The venue's IANA zone, or null — `Event.timezone` via the read model. */
  timeZone: string | null;
  /** Free-form address the record holds. We print it; we invent nothing. */
  addressText: string | null;
  /**
   * The signup handed to `mintScanToken`. Any APPROVED signup of this human on
   * this event mints the SAME human+event token, so the choice only fixes
   * WHICH audit row records the mint — but it must be deterministic, or a
   * refetch that reorders the list scatters provenance across rows.
   */
  mintSignupId: string;
  shifts: QrShift[];
};

/**
 * Only these can mint.
 *
 * APPROVED because `mintVolunteerScanToken` refuses anything else outright
 * (SIGNUP_NOT_APPROVED) — surfacing that cleanly beats letting it throw.
 * EVENT_SHIFT with a real `eventId` because a scan token is an event-gate
 * concept: an ask-only signup has no event, and the use case answers
 * SIGNUP_NOT_FOUND for one.
 */
const isEligible = (row: Commitment): boolean =>
  row.status === "APPROVED" &&
  row.source === "EVENT_SHIFT" &&
  typeof row.eventId === "string" &&
  row.eventId.length > 0;

const startMs = (row: { startsAt: Date | null }): number =>
  row.startsAt ? row.startsAt.getTime() : Number.POSITIVE_INFINITY;

/**
 * Group a volunteer's own commitments into the events they can print a code
 * for, soonest first.
 *
 * Deliberately NOT filtered on "upcoming": a shift that started an hour ago is
 * exactly when somebody discovers their phone is dead, and the check-in window
 * stays open either side of a shift (`classifyWindow`). Past events fall to the
 * bottom of the list by their own start time and the caller picks the head.
 */
export const selectQrSubjects = (
  rows: readonly Commitment[],
): QrSubject[] => {
  const byEvent = new Map<string, QrSubject>();

  for (const row of rows) {
    if (!isEligible(row)) continue;
    const eventId = row.eventId as string;

    const shift: QrShift = {
      key: row.claimId ?? row.signupId,
      signupId: row.signupId,
      roleName: row.roleName,
      shiftLabel: row.shiftLabel,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    };

    const existing = byEvent.get(eventId);
    if (existing) {
      existing.shifts.push(shift);
      // A zone or address may be present on one row and absent on another;
      // keep the first real value rather than letting a later null blank it.
      existing.timeZone = existing.timeZone ?? row.eventTimezone;
      existing.addressText = existing.addressText ?? row.addressText;
      continue;
    }

    byEvent.set(eventId, {
      eventId,
      eventTitle: row.title,
      timeZone: row.eventTimezone,
      addressText: row.addressText,
      mintSignupId: row.signupId,
      shifts: [shift],
    });
  }

  const subjects = Array.from(byEvent.values()).map((subject) => {
    const shifts = [...subject.shifts].sort(
      (a, b) => startMs(a) - startMs(b) || a.key.localeCompare(b.key),
    );
    return {
      ...subject,
      shifts,
      // Deterministic mint source: the earliest shift.
      mintSignupId: shifts[0]?.signupId ?? subject.mintSignupId,
    } satisfies QrSubject;
  });

  subjects.sort(
    (a, b) =>
      startMs(a.shifts[0]) - startMs(b.shifts[0]) ||
      a.eventId.localeCompare(b.eventId),
  );

  return subjects;
};

/**
 * Pick the event this sheet is about.
 *
 * With an explicit `eventId` (the link carries one), that event or nothing —
 * NEVER a silent fall-through to a different one. Printing a code for the
 * wrong event is worse than printing none: the volunteer arrives holding paper
 * that scans as `volunteer_qr_wrong_event` and has no way to tell why.
 *
 * With no `eventId`, the soonest eligible event, so a bare `/qr/print` is
 * still useful.
 */
export const resolveQrSubject = (
  subjects: readonly QrSubject[],
  eventId: string | null,
): QrSubject | null => {
  if (!eventId) return subjects[0] ?? null;
  return subjects.find((subject) => subject.eventId === eventId) ?? null;
};
