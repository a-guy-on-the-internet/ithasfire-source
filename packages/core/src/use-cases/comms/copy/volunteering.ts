import type { NotificationLocale } from "../locale";

import { esVolunteerRole, formatEventTime } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the volunteer shift reminder the cron dispatcher writes
// straight to the inbox (volunteering/send-volunteer-shift-reminders.ts), one
// entry per `NotificationLocale` (pattern: ./rsvp.ts). In-app only: the
// reminder's email and SMS are rendered elsewhere and stay English.
//
// The English is what the dispatcher stored before it stored a template;
// reword it only on purpose. One deliberate change (2026-10-08): "In 1 hour"
// became "In about an hour", because the 1h reminder now lands 40 to 80
// minutes before the shift. Older rows re-render with the new wording.
//
// Event title, role name and shift label are organizer free text: verbatim.
// Spanish: "turno de voluntariado", never a gendered "voluntario/a".
// ─────────────────────────────────────────────────────────────────────────────

export type ShiftReminderKind = "REMINDER_24H" | "REMINDER_1H";

/** One shift in a grouped reminder (R12): its role and its label. */
export type ShiftReminderRole = {
  roleName: string;
  shiftLabel: string | null;
};

export type VolunteerShiftReminderCopy = {
  readonly title: (v: {
    eventTitle: string;
    kind: ShiftReminderKind;
    roles?: readonly ShiftReminderRole[] | null;
  }) => string;
  readonly body: (v: {
    eventTitle: string;
    roleName: string;
    shiftLabel: string | null;
    kind: ShiftReminderKind;
    /**
     * Set (two or more) when one notice covers several shifts of one person
     * at the same event and start (volunteer-ask-reminders R12). Absent on
     * rows stored before 2026-10-18 and on single-shift rows: those read the
     * `roleName` / `shiftLabel` pair.
     */
    roles?: readonly ShiftReminderRole[] | null;
  }) => string;
  readonly openLabel: string;
};

/** "Tomorrow" / "In about an hour": the English lead the dispatcher uses. */
function enKindLabel(kind: ShiftReminderKind): string {
  return kind === "REMINDER_24H" ? "Tomorrow" : "In about an hour";
}

function labelSuffix(shiftLabel: string | null): string {
  return shiftLabel ? ` (${shiftLabel})` : "";
}

/** "A", "A and B", "A, B and C"; `and` is the locale's word. */
function joinNames(names: readonly string[], and: string): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;
}

/** A grouped notice: two or more roles; anything less reads the single form. */
function groupedShifts(
  roles: readonly ShiftReminderRole[] | null | undefined,
): readonly ShiftReminderRole[] | null {
  return roles && roles.length > 1 ? roles : null;
}

/**
 * The roles a start notice names. A grouped row (`roleNames`, R12) names
 * every distinct role in it; a single row names its `roleName`. The stored
 * "Volunteer" fallback names no role either way, so a group of "Volunteer"
 * and "Check-in table" names "Check-in table" alone, whatever its stored
 * `roleName` says (rows stored before 2026-10-18 kept the first signup's).
 */
function startRoleNames(
  roleName: string,
  roleNames: readonly string[] | null | undefined,
): readonly string[] {
  const all = roleNames && roleNames.length > 0 ? roleNames : [roleName];
  return [...new Set(all)].filter((n) => n !== "Volunteer");
}

export const VOLUNTEER_SHIFT_REMINDER_COPY: {
  readonly [L in NotificationLocale]: VolunteerShiftReminderCopy;
} = {
  en: {
    title: ({ eventTitle, kind, roles }) =>
      `Reminder: your ${eventTitle} ${groupedShifts(roles) ? "shifts" : "shift"} ${enKindLabel(kind).toLowerCase()}`,
    body: ({ eventTitle, roleName, shiftLabel, kind, roles }) => {
      const group = groupedShifts(roles);
      if (!group)
        return `${enKindLabel(kind)} — your ${roleName} shift${labelSuffix(shiftLabel)} at ${eventTitle}.`;
      const names = group.map((r) => `${r.roleName}${labelSuffix(r.shiftLabel)}`);
      return `${enKindLabel(kind)} — your shifts at ${eventTitle}: ${joinNames(names, "and")}.`;
    },
    openLabel: "Open your signup",
  },
  es: {
    title: ({ eventTitle, kind, roles }) => {
      if (groupedShifts(roles))
        return kind === "REMINDER_24H"
          ? `Recordatorio: tus turnos de voluntariado en ${eventTitle} son mañana`
          : `Recordatorio: tus turnos de voluntariado en ${eventTitle} empiezan en aproximadamente una hora`;
      return kind === "REMINDER_24H"
        ? `Recordatorio: tu turno de voluntariado en ${eventTitle} es mañana`
        : `Recordatorio: tu turno de voluntariado en ${eventTitle} empieza en aproximadamente una hora`;
    },
    body: ({ eventTitle, roleName, shiftLabel, kind, roles }) => {
      const lead = kind === "REMINDER_24H" ? "Mañana" : "En aproximadamente una hora";
      const group = groupedShifts(roles);
      if (!group)
        return `${lead} — tu turno de ${esVolunteerRole(roleName)}${labelSuffix(shiftLabel)} en ${eventTitle}.`;
      const names = group.map(
        (r) => `${esVolunteerRole(r.roleName)}${labelSuffix(r.shiftLabel)}`,
      );
      return `${lead} — tus turnos en ${eventTitle}: ${joinNames(names, "y")}.`;
    },
    openLabel: "Abrir tu inscripción",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Start reminders (volunteer-ask-reminders FR-004): a shiftless event role is
// reminded before the EVENT starts, a one-time ask before the ask starts.
// The copy names the thing that starts ("Summer Fest starts tomorrow"), never
// "your shift" (R7). The time renders in the zone the producer stored (the
// event's, the ask's or its place's, else the platform default, America/Chicago) with the zone named.
// Title and role name are organizer free text: verbatim.
// ─────────────────────────────────────────────────────────────────────────────

export type VolunteerStartReminderAnchor = "EVENT_START" | "ASK_START";

export type VolunteerStartReminderCopy = {
  readonly title: (v: { title: string; kind: ShiftReminderKind }) => string;
  readonly body: (v: {
    title: string;
    roleName: string;
    kind: ShiftReminderKind;
    startsAtIso: string;
    timezone: string | null;
    /**
     * Every role of one person on the same event or ask at the same start
     * (volunteer-ask-reminders R12), when one notice covers several signups.
     * Absent on rows stored before 2026-10-18 and on single-role rows: those
     * read `roleName`.
     */
    roleNames?: readonly string[] | null;
  }) => string;
  readonly openLabel: (anchor: VolunteerStartReminderAnchor) => string;
};

export const VOLUNTEER_START_REMINDER_COPY: {
  readonly [L in NotificationLocale]: VolunteerStartReminderCopy;
} = {
  en: {
    title: ({ title, kind }) =>
      `Reminder: ${title} starts ${enKindLabel(kind).toLowerCase()}`,
    body: ({ title, roleName, kind, startsAtIso, timezone, roleNames }) => {
      const time = formatEventTime("en", startsAtIso, timezone);
      const named = startRoleNames(roleName, roleNames);
      const as = named.length > 0 ? ` as ${joinNames(named, "and")}` : "";
      return `${enKindLabel(kind)}${time ? ` at ${time}` : ""} — you're volunteering${as} at ${title}.`;
    },
    openLabel: (anchor) =>
      anchor === "ASK_START" ? "View details" : "Open your signup",
  },
  es: {
    title: ({ title, kind }) =>
      kind === "REMINDER_24H"
        ? `Recordatorio: ${title} empieza mañana`
        : `Recordatorio: ${title} empieza en aproximadamente una hora`,
    body: ({ title, roleName, kind, startsAtIso, timezone, roleNames }) => {
      const time = formatEventTime("es", startsAtIso, timezone);
      // "a la 1:30", "a las 19:30".
      const at = time ? `, ${/^1:/.test(time) ? "a la" : "a las"} ${time}` : "";
      const named = startRoleNames(roleName, roleNames);
      const as = named.length > 0 ? ` como ${joinNames(named, "y")}` : "";
      return `${kind === "REMINDER_24H" ? "Mañana" : "En aproximadamente una hora"}${at} — tu voluntariado en ${title}${as}.`;
    },
    openLabel: (anchor) =>
      anchor === "ASK_START" ? "Ver detalles" : "Abrir tu inscripción",
  },
};
