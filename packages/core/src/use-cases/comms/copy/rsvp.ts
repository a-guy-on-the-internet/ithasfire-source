import type { NotificationLocale } from "../locale";
import { COMMON_COPY } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the RSVP notices, one entry per `NotificationLocale`.
//
// The PATTERN for every notification copy module:
//   - typed `{ readonly [L in NotificationLocale]: … }`, so a new locale in
//     `../locale.ts` fails the typecheck here until its copy is written;
//   - plain functions over the values the sentence needs; the renderer formats
//     dates (in the render locale) before passing them in;
//   - labels shared across notices (e.g. "View event") come from
//     `./common.ts`, never re-typed per variant;
//   - organizer free text (event titles, venue names) is interpolated verbatim,
//     never translated;
//   - English must stay byte-for-byte what the renderer said before the move:
//     it is what gets stored on the row, and what old clients and search see;
//   - once converted, the variant joins `LOCALIZED_VARIANTS` (`./index.ts`)
//     with a frozen payload fixture, or the inbox never re-renders it.
//
// Spanish voice: plain and informal ("tú"), matching the panel's own words
// ("Recibidas", "Descartar todo") and the web RSVP toggle ("Vas a ir").
// ─────────────────────────────────────────────────────────────────────────────

export type RsvpConfirmedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  /** `startsAt` is already formatted in the render locale; null = omit it. */
  readonly body: (v: { eventTitle: string; startsAt: string | null }) => string;
  readonly viewEventLabel: string;
};

export const RSVP_CONFIRMED_COPY: {
  readonly [L in NotificationLocale]: RsvpConfirmedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `You're going to ${eventTitle}`,
    body: ({ eventTitle, startsAt }) =>
      `Your RSVP for ${eventTitle} is confirmed.` +
      (startsAt ? ` It starts ${startsAt}.` : ""),
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: ({ eventTitle }) => `Vas a ir a ${eventTitle}`,
    body: ({ eventTitle, startsAt }) =>
      `Tu asistencia a ${eventTitle} está confirmada.` +
      (startsAt ? ` Empieza el ${startsAt}.` : ""),
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

// ── rsvp.date_cancelled ──────────────────────────────────────────────────────
// The date leads, not the title: the recipient RSVP'd to ONE night of something
// still running, and the only question they have is which night.
//
// `listingTitle` / `listingBody` are the WHOLE-LISTING variant (payload
// `listingCancelled: true`): the listing was cancelled, archived, or completed
// with nights still ahead, so there is no "rest of the schedule" and no other
// dates to see. "Cancelled" is true in all three: every night the recipient
// had ahead is called off. One message covers
// every remaining night the person held, so it names no single date. Its link
// (`viewEventLabel`) is present only when the listing is CANCELLED, the one
// status whose page says "Event cancelled".

export type RsvpDateCancelledCopy = {
  /** `startsAt` is already formatted in the render locale; null = omit it. */
  readonly title: (v: { eventTitle: string; startsAt: string | null }) => string;
  readonly body: (v: { eventTitle: string; startsAt: string | null }) => string;
  readonly seeOtherDatesLabel: string;
  readonly listingTitle: (v: { eventTitle: string }) => string;
  /** Follows the title (in-app) or the subject (email), so names no event. */
  readonly listingBody: string;
  /** Whole-listing link label, shown only when the drain sends a link. */
  readonly viewEventLabel: string;
};

export const RSVP_DATE_CANCELLED_COPY: {
  readonly [L in NotificationLocale]: RsvpDateCancelledCopy;
} = {
  en: {
    title: ({ eventTitle, startsAt }) =>
      startsAt
        ? `Cancelled: ${eventTitle} on ${startsAt}`
        : `Cancelled: ${eventTitle}`,
    body: ({ eventTitle, startsAt }) =>
      startsAt
        ? `The ${startsAt} date of ${eventTitle} has been called off. Your RSVP for that night is cancelled; the rest of the schedule is unchanged.`
        : `One date of ${eventTitle} has been called off. Your RSVP for that night is cancelled; the rest of the schedule is unchanged.`,
    seeOtherDatesLabel: "See other dates",
    listingTitle: ({ eventTitle }) => `Cancelled: ${eventTitle}`,
    listingBody: "None of its remaining nights will happen. Your RSVP is cancelled.",
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: ({ eventTitle, startsAt }) =>
      startsAt
        ? `Fecha cancelada: ${eventTitle}, ${startsAt}`
        : `Fecha cancelada: ${eventTitle}`,
    body: ({ eventTitle, startsAt }) =>
      startsAt
        ? `Se canceló la fecha de ${eventTitle} del ${startsAt}. Tu asistencia para esa noche queda cancelada; las demás fechas siguen igual.`
        : `Se canceló una fecha de ${eventTitle}. Tu asistencia para esa noche queda cancelada; las demás fechas siguen igual.`,
    seeOtherDatesLabel: "Ver otras fechas",
    listingTitle: ({ eventTitle }) => `Evento cancelado: ${eventTitle}`,
    listingBody:
      "Ninguna de sus próximas fechas se va a realizar. Tu asistencia queda cancelada.",
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

// ── rsvp.reminder ────────────────────────────────────────────────────────────
// `dayLabel` is the renderer's own derived label (measured in the listing's
// timezone); null means "not today, not tomorrow".

export type RsvpReminderDay = "Today" | "Tomorrow" | null;

export type RsvpReminderCopy = {
  readonly title: (v: { eventTitle: string; dayLabel: RsvpReminderDay }) => string;
  /** `startsAt` is already formatted in the render locale; null = omit it. */
  readonly body: (v: {
    eventTitle: string;
    dayLabel: RsvpReminderDay;
    startsAt: string | null;
  }) => string;
};

export const RSVP_REMINDER_COPY: {
  readonly [L in NotificationLocale]: RsvpReminderCopy;
} = {
  en: {
    title: ({ eventTitle, dayLabel }) =>
      dayLabel ? `${dayLabel}: ${eventTitle}` : `Coming up: ${eventTitle}`,
    body: ({ eventTitle, dayLabel, startsAt }) =>
      (dayLabel
        ? `${eventTitle} is ${dayLabel.toLowerCase()}.`
        : `${eventTitle} is coming up.`) +
      (startsAt ? ` It starts ${startsAt}.` : ""),
  },
  es: {
    title: ({ eventTitle, dayLabel }) =>
      dayLabel === "Today"
        ? `Hoy: ${eventTitle}`
        : dayLabel === "Tomorrow"
          ? `Mañana: ${eventTitle}`
          : `Se acerca: ${eventTitle}`,
    body: ({ eventTitle, dayLabel, startsAt }) =>
      (dayLabel === "Today"
        ? `${eventTitle} es hoy.`
        : dayLabel === "Tomorrow"
          ? `${eventTitle} es mañana.`
          : `${eventTitle} se acerca.`) +
      (startsAt ? ` Empieza el ${startsAt}.` : ""),
  },
};
