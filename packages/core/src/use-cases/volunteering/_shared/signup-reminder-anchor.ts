import type { VolunteerAskRecord } from "@th/ports/repos/volunteering";

/**
 * What a volunteer signup is reminded by (volunteer-ask-reminders FR-001).
 *
 *   - SHIFT        its shift's start;
 *   - EVENT_START  for an event signup on a role with NO shifts, the event's
 *                  start (R7: "event roles without shifts"; the copy says
 *                  the EVENT starts, never "your shift");
 *   - ASK_START    for a signup on a non-EVENT ask, the ask's `startsAt`
 *                  when the ask is ONE_TIME (R1).
 *
 * Exactly one, or none: an ONGOING or RECURRING ask's start is when it
 * opens, not when a volunteer is expected, and an ask without a start has
 * nothing to remind of (R2). A shiftless signup on a role that HAS shifts
 * (a role-level signup, or one whose shift was deleted) gets none either:
 * the volunteer's time is a shift, and the event's start would send them at
 * the wrong time. A signup has a single anchor, which is why the
 * reminder ledger keyed on (signup, kind, channel) can never double-send.
 */
export type SignupReminderAnchor = "SHIFT" | "EVENT_START" | "ASK_START";

/** The ask fields the rule reads. */
export type ReminderAskFields = Pick<
  VolunteerAskRecord,
  "subjectType" | "cadence" | "startsAt"
>;

/**
 * Does a signup on this ask's OWN roles get reminders (and so the text
 * opt-in)? Non-EVENT, ONE_TIME, with a start. Status and owner standing are
 * the dispatcher's concern, not the offer's.
 */
export function askOffersTextReminders(ask: ReminderAskFields): boolean {
  return (
    ask.subjectType !== "EVENT" &&
    ask.cadence === "ONE_TIME" &&
    ask.startsAt !== null
  );
}

/**
 * THE rule, in one place: the submit path, the contact-prefs toggle, the
 * public ask payload and the reminder jobs all call it. `roleHasShifts` is
 * read only for an event signup without a shift; `ask` is the signup's ask
 * (null when it has none, or for an event signup, where it is not read).
 */
export function signupReminderAnchor(signup: {
  shiftId: string | null;
  eventId: string | null;
  roleHasShifts: boolean;
  ask: ReminderAskFields | null;
}): SignupReminderAnchor | null {
  if (signup.shiftId) return "SHIFT";
  if (signup.eventId) return signup.roleHasShifts ? null : "EVENT_START";
  if (signup.ask && askOffersTextReminders(signup.ask)) return "ASK_START";
  return null;
}
