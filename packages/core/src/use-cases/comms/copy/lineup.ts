import type { NotificationLocale } from "../locale";
import { esName } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the lineup notices (event.lineup-added / -left) and the
// bill notices that follow a lineup-booking invite (booking.lineup-answered /
// -request-closed / -removed), one entry per `NotificationLocale`
// (pattern: ./rsvp.ts).
//
// English is ALSO what email and push say for these (the renderers and the
// shared `lineupRequestClosedTitle` / `lineupRemovedTitle` read `.en`), so the
// English stays in one place.
//
// Dates arrive already formatted in the render locale. Names (people, acts,
// groups, venues, events) and the role label are free text or producer labels:
// verbatim. In Spanish the bill is the "lineup" and the venue is "el lugar";
// a person or act is never gendered (names, "quien", no agreeing adjectives).
// ─────────────────────────────────────────────────────────────────────────────

// The producer stores the ENGLISH built-in role label ("Performer", "DJ", ...)
// in the payload (`lineupRoleLabel`). Spanish maps each built-in one to the
// whole clause after "te agregó" ("como artista", "para la conducción"): a
// natural, ungendered way to say each role, which is not always "como" + a
// noun. "" (the built-in "Other") drops the clause. Any other string is the
// organizer's own custom label and stays verbatim after "como".
const ES_BUILT_IN_ROLE_CLAUSES: Readonly<Record<string, string>> = {
  Performer: "como artista",
  Host: "a cargo de la conducción",
  DJ: "como DJ",
  Instructor: "como docente",
  Speaker: "como ponente",
  Vendor: "como comerciante",
  Volunteer: "para el voluntariado",
  Other: "",
};

/** The es clause after "te agregó", or "" for none (see the table above). */
export const esLineupRoleClause = (roleLabel: string): string =>
  (Object.hasOwn(ES_BUILT_IN_ROLE_CLAUSES, roleLabel)
    ? ES_BUILT_IN_ROLE_CLAUSES[roleLabel]
    : undefined) ?? `como ${roleLabel}`;

// ── event.lineup-added ───────────────────────────────────────────────────────

export type LineupAddedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  /** `when` is formatted in the render locale; null = omit it. */
  readonly body: (v: {
    addedByName: string;
    roleLabel: string;
    when: string | null;
    /** The event has already started: Spanish says "Fue el", not "Empieza el". */
    eventEnded: boolean;
  }) => string;
  readonly reviewLabel: string;
};

export const LINEUP_ADDED_COPY: {
  readonly [L in NotificationLocale]: LineupAddedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `You're on the lineup for ${eventTitle}`,
    body: ({ addedByName, roleLabel, when }) =>
      when
        ? `${addedByName} added you as ${roleLabel}. ${when}.`
        : `${addedByName} added you as ${roleLabel}.`,
    reviewLabel: "Review your lineups",
  },
  es: {
    title: ({ eventTitle }) => `Estás en el lineup de ${eventTitle}`,
    body: ({ addedByName, roleLabel, when, eventEnded }) => {
      const clause = esLineupRoleClause(roleLabel);
      return (
        (clause
          ? `${esName(addedByName, "start")} te agregó ${clause}.`
          : `${esName(addedByName, "start")} te agregó al lineup.`) +
        (when ? ` ${eventEnded ? "Fue" : "Empieza"} el ${when}.` : "")
      );
    },
    reviewLabel: "Revisar tus lineups",
  },
};

// ── event.lineup-left ────────────────────────────────────────────────────────

export type LineupLeftCopy = {
  readonly title: (v: { personName: string }) => string;
  /** `date` is formatted in the render locale; null = omit it. */
  readonly body: (v: {
    eventTitle: string;
    date: string | null;
    wasPubliclyListed: boolean;
  }) => string;
  readonly openLabel: string;
};

export const LINEUP_LEFT_COPY: {
  readonly [L in NotificationLocale]: LineupLeftCopy;
} = {
  en: {
    title: ({ personName }) => `${personName} took themselves off the lineup`,
    body: ({ eventTitle, date, wasPubliclyListed }) => {
      const tail = wasPubliclyListed
        ? "Their name is off the event page."
        : "They're off the lineup.";
      return date ? `${eventTitle}, ${date}. ${tail}` : `${eventTitle}. ${tail}`;
    },
    openLabel: "Open the lineup",
  },
  es: {
    title: ({ personName }) => `${esName(personName, "start")} salió del lineup`,
    body: ({ eventTitle, date, wasPubliclyListed }) => {
      const tail = wasPubliclyListed
        ? "Su nombre ya no aparece en la página del evento."
        : "Ya no está en el lineup.";
      return date ? `${eventTitle}, ${date}. ${tail}` : `${eventTitle}. ${tail}`;
    },
    openLabel: "Abrir el lineup",
  },
};

// ── booking.lineup-answered ──────────────────────────────────────────────────

export type BookingLineupAnswer = "joined" | "passed" | "left";

export type BookingLineupAnsweredCopy = {
  readonly title: (v: {
    actName: string;
    venueName: string;
    answer: BookingLineupAnswer;
  }) => string;
  readonly body: (answer: BookingLineupAnswer) => string;
  readonly openLabel: string;
};

export const BOOKING_LINEUP_ANSWERED_COPY: {
  readonly [L in NotificationLocale]: BookingLineupAnsweredCopy;
} = {
  en: {
    title: ({ actName, venueName, answer }) =>
      answer === "joined"
        ? `${actName} joined your bill at ${venueName}`
        : answer === "passed"
          ? `${actName} passed on your bill at ${venueName}`
          : `${actName} left your bill at ${venueName}`,
    body: (answer) =>
      answer === "joined"
        ? "The place now sees them as joined."
        : "They're off the bill. The place doesn't see them on it.",
    openLabel: "Open your bookings",
  },
  es: {
    title: ({ actName, venueName, answer }) =>
      answer === "joined"
        ? `${esName(actName, "start")} se sumó a tu lineup en ${esName(venueName, "mid")}`
        : answer === "passed"
          ? `${esName(actName, "start")} no se sumará a tu lineup en ${esName(venueName, "mid")}`
          : `${esName(actName, "start")} salió de tu lineup en ${esName(venueName, "mid")}`,
    body: (answer) =>
      answer === "joined"
        ? "El lugar ya ve que se sumó."
        : "Ya no forma parte del lineup ni aparece en la solicitud que ve el lugar.",
    openLabel: "Abrir tus contrataciones",
  },
};

// ── booking.lineup-request-closed ────────────────────────────────────────────

export type BookingLineupRequestClosedCopy = {
  readonly title: (v: { venueName: string }) => string;
  /** `dateLabels` are formatted in the render locale; empty = no dates. */
  readonly body: (v: {
    senderName: string;
    venueName: string;
    dateLabels: readonly string[];
    asGroupName?: string | undefined;
  }) => string;
  readonly viewLabel: string;
};

export const BOOKING_LINEUP_REQUEST_CLOSED_COPY: {
  readonly [L in NotificationLocale]: BookingLineupRequestClosedCopy;
} = {
  en: {
    title: ({ venueName }) => `The request to ${venueName} isn't going ahead`,
    // NO reason, ever (L7): the act learns only that it is not going ahead.
    body: ({ senderName, venueName, dateLabels, asGroupName }) => {
      const forDates =
        dateLabels.length > 0 ? ` for ${dateLabels.join("; ")}` : "";
      const onBill = asGroupName
        ? `with ${asGroupName} on the bill`
        : "with you on the bill";
      return `${senderName}'s request to ${venueName}${forDates}, ${onBill}, isn't going ahead. There's nothing you need to do.`;
    },
    viewLabel: "View the request",
  },
  es: {
    title: ({ venueName }) =>
      `La solicitud de contratación para ${esName(venueName, "mid")} no seguirá adelante`,
    body: ({ senderName, venueName, dateLabels, asGroupName }) => {
      const forDates =
        dateLabels.length > 0
          ? ` (${dateLabels.length === 1 ? "fecha" : "fechas"}: ${dateLabels.join("; ")})`
          : "";
      const onBill = asGroupName
        ? `con ${asGroupName} en el lineup`
        : "contigo en el lineup";
      return `La solicitud de contratación ${esName(senderName, "de")} para ${esName(venueName, "mid")}${forDates}, ${onBill}, no seguirá adelante. No tienes que hacer nada.`;
    },
    viewLabel: "Ver la solicitud",
  },
};

// ── booking.lineup-removed ───────────────────────────────────────────────────

export type BookingLineupRemovedCopy = {
  readonly title: (v: {
    senderName: string;
    venueName: string;
    asGroupName?: string | undefined;
  }) => string;
  readonly body: (v: {
    senderName: string;
    venueName: string;
    dateLabels: readonly string[];
    asGroupName?: string | undefined;
  }) => string;
};

export const BOOKING_LINEUP_REMOVED_COPY: {
  readonly [L in NotificationLocale]: BookingLineupRemovedCopy;
} = {
  en: {
    title: ({ senderName, venueName, asGroupName }) =>
      `${senderName} took ${asGroupName ?? "you"} off the bill at ${venueName}`,
    body: ({ senderName, venueName, dateLabels, asGroupName }) => {
      const forDates =
        dateLabels.length > 0 ? ` for ${dateLabels.join("; ")}` : "";
      const who = asGroupName ?? "you";
      return `${senderName} changed the bill they pitched to ${venueName}${forDates}, and ${who} ${asGroupName ? "is" : "are"} no longer on it. There's nothing you need to do.`;
    },
  },
  es: {
    title: ({ senderName, venueName, asGroupName }) =>
      asGroupName
        ? `${esName(senderName, "start")} quitó a ${asGroupName} del lineup en ${esName(venueName, "mid")}`
        : `${esName(senderName, "start")} te quitó del lineup en ${esName(venueName, "mid")}`,
    body: ({ senderName, venueName, dateLabels, asGroupName }) => {
      const forDates =
        dateLabels.length > 0
          ? ` (${dateLabels.length === 1 ? "fecha" : "fechas"}: ${dateLabels.join("; ")})`
          : "";
      const gone = asGroupName
        ? `${asGroupName} ya no forma parte de él`
        : "ya no formas parte de él";
      return `${esName(senderName, "start")} cambió el lineup que propuso para ${esName(venueName, "mid")}${forDates}, y ${gone}. No tienes que hacer nada.`;
    },
  },
};
