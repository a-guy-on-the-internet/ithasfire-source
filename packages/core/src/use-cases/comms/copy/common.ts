import { resolveTimeZone } from "../../../lib/venue-local-time";
import { NOTIFICATION_INTL_LOCALE, type NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// Labels many notifications share (action buttons, mostly). A variant's copy
// module takes these from here instead of writing its own, so "View event"
// reads the same on every notice in every language.
//
// Same rule as every copy module: a full `{ [L in NotificationLocale]: … }`,
// so a new locale fails the typecheck here until its labels exist.
// ─────────────────────────────────────────────────────────────────────────────

export type CommonCopy = {
  /** The standard event action (`eventRouteAction`'s label). */
  readonly viewEvent: string;
};

export const COMMON_COPY: { readonly [L in NotificationLocale]: CommonCopy } = {
  en: {
    viewEvent: "View event",
  },
  es: {
    viewEvent: "Ver evento",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Event dates and times, phrased per locale. Every variant that says "it
// starts …" uses these, so a date reads the same on every notice.
//   en dateTime: "Fri, Nov 13, 2026, 7:30 PM CST"  (unchanged since before locales)
//   es dateTime: "viernes 13 de noviembre de 2026 a las 19:30 (GMT-6)"
// The Spanish body templates put "el" in front, so the phrase starts at the
// weekday. Use `date` / `time` where a variant needs only one half.
// ─────────────────────────────────────────────────────────────────────────────

type Opts = Intl.DateTimeFormatOptions;

type EventWhenFormatters = {
  readonly dateTime: (date: Date, intlLocale: string, tz: string) => string;
  readonly date: (date: Date, intlLocale: string, tz: string) => string;
  readonly time: (date: Date, intlLocale: string, tz: string) => string;
};

/**
 * Formats once and exposes the parts. `get` is "" for a part ICU did not
 * emit; `fallback` is the plain `format()` of the same options, for when a
 * part a builder needs is missing.
 */
function partsOf(date: Date, intlLocale: string, tz: string, opts: Opts) {
  const formatter = new Intl.DateTimeFormat(intlLocale, {
    ...opts,
    timeZone: tz,
  });
  const parts = formatter.formatToParts(date);
  return {
    get: (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "",
    fallback: (): string => formatter.format(date),
  };
}

const EN_DATE: Opts = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
};
const EN_TIME: Opts = {
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};
const ES_DATE: Opts = {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
};
const ES_TIME: Opts = {
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

function esDate(date: Date, intlLocale: string, tz: string): string {
  const p = partsOf(date, intlLocale, tz, ES_DATE);
  const [weekday, day, month, year] = [
    p.get("weekday"),
    p.get("day"),
    p.get("month"),
    p.get("year"),
  ];
  if (!weekday || !day || !month || !year) return p.fallback();
  return `${weekday} ${day} de ${month} de ${year}`;
}

/** "19:30 (GMT-6)"; the zone suffix only when ICU gave a zone name. */
function esTimeParts(
  date: Date,
  intlLocale: string,
  tz: string,
): { text: string; hour: string } | null {
  const p = partsOf(date, intlLocale, tz, ES_TIME);
  const hour = p.get("hour");
  const minute = p.get("minute");
  if (!hour || !minute) return null;
  const zone = p.get("timeZoneName");
  return {
    text: `${hour}:${minute}${zone ? ` (${zone})` : ""}`,
    hour,
  };
}

const EVENT_WHEN_FORMATTERS: {
  readonly [L in NotificationLocale]: EventWhenFormatters;
} = {
  en: {
    dateTime: (date, intlLocale, tz) =>
      partsOf(date, intlLocale, tz, {
        ...EN_DATE,
        ...EN_TIME,
      }).fallback(),
    date: (date, intlLocale, tz) =>
      partsOf(date, intlLocale, tz, EN_DATE).fallback(),
    time: (date, intlLocale, tz) =>
      partsOf(date, intlLocale, tz, EN_TIME).fallback(),
  },
  es: {
    date: esDate,
    time: (date, intlLocale, tz) =>
      esTimeParts(date, intlLocale, tz)?.text ??
      partsOf(date, intlLocale, tz, ES_TIME).fallback(),
    dateTime: (date, intlLocale, tz) => {
      const time = esTimeParts(date, intlLocale, tz);
      if (!time) {
        return partsOf(date, intlLocale, tz, {
          ...ES_DATE,
          ...ES_TIME,
        }).fallback();
      }
      // "a la 1:30", "a las 19:30", "a las 0:05".
      const article = time.hour === "1" ? "a la" : "a las";
      return `${esDate(date, intlLocale, tz)} ${article} ${time.text}`;
    },
  },
};

function formatEventWhen(
  kind: keyof EventWhenFormatters,
  locale: NotificationLocale,
  iso: string,
  timezone: string | null | undefined,
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const format = EVENT_WHEN_FORMATTERS[locale][kind];
  const intlLocale = NOTIFICATION_INTL_LOCALE[locale];
  // A missing or unknown IANA id reads in the platform default
  // (`resolveTimeZone`), never UTC: UTC is the server's zone, and it put an
  // evening show on the next day. resolveTimeZone validates the id, so the
  // formatter cannot throw on it. Callers that format a stored UTC calendar
  // day pass "UTC" explicitly and keep it.
  return format(date, intlLocale, resolveTimeZone(timezone));
}

// Each returns null for an unparseable ISO string (callers omit the sentence),
// formats in the EVENT's timezone (missing or invalid → platform default),
// and never throws.
export const formatEventStart = (
  locale: NotificationLocale,
  iso: string,
  timezone: string | null | undefined,
): string | null => formatEventWhen("dateTime", locale, iso, timezone);

export const formatEventDate = (
  locale: NotificationLocale,
  iso: string,
  timezone: string | null | undefined,
): string | null => formatEventWhen("date", locale, iso, timezone);

export const formatEventTime = (
  locale: NotificationLocale,
  iso: string,
  timezone: string | null | undefined,
): string | null => formatEventWhen("time", locale, iso, timezone);

// ── Stored English placeholder names ─────────────────────────────────────────
// Producers store an English fallback word in a payload's name field when no
// name resolved (the renderer schemas require a non-empty name). Payloads are
// re-rendered at read time, so rows already in the database keep the English
// word: the Spanish copy maps it here instead. A real name passes through
// untouched, and English never goes through this (it prints the fallback
// exactly as stored). The producers and their fallbacks:
//   · "The place": booking-holds/notify-booking-hold-intents (placeName),
//     booking-requests/asks/notify-booking-request-ask (venueName),
//     booking-requests/notify-booking-request-responded (responderName),
//     booking-requests/notify-booking-cancelled (cancelledByName),
//     events/notify-venue-confirmation-intents (placeName)
//   · "The act": notify-booking-hold-intents (actName), notify-booking-
//     request-ask (answeredByName), notify-booking-cancelled (cancelledByName)
//   · "Someone": booking-requests/_shared/bill-notice-support (senderName;
//     lineup-removed / -request-closed, and event.lineup-added addedByName via
//     answer-booking-request-act), notify-booking-lineup-invited (senderName),
//     notify-booking-cancelled and notify-booking-request-ask (clip of an
//     empty name), event-humans/leave-event-lineup (personName),
//     events/notify-event-application-received (applicantName)
//   · "a place": bill-notice-support and notify-booking-lineup-invited
//     (venueName)
//   · "The venue" / "a venue": what the producers above stored before
//     2026-10-17 (copy says "place", never "venue"). Rows written then are
//     still in the database, so their keys stay.
//   · "A performer": notify-booking-request-received (actName)
//   · "An artist": booking-requests/_shared/bill-act-names and
//     notify-booking-lineup-answered (actName)
//   · "Performer": booking-requests/_shared/act-name (resolvePerformerActName:
//     responderName, cancelledByName, hold actName, ask answeredByName)
//   · "Your booking contact": notify-booking-request-message (senderLabel)
//   · "An organizer": notify-organizer-booking-request-received (orgName)
//   · "The organiser": event-humans/notify-lineup-notices (addedByName)
//   · "Your event": notify-venue-confirmation-intents (eventTitle)

/** Where the name sits in the Spanish sentence (picks case and "a"/"de" contraction). */
export type PlaceholderPosition = "start" | "mid" | "a" | "de";

type EsPhrase = { readonly [P in PlaceholderPosition]: string };

/** A phrase that takes no article contraction: "Alguien" / "a alguien". */
const plain = (start: string): EsPhrase => {
  const mid = start.charAt(0).toLowerCase() + start.slice(1);
  return { start, mid, a: `a ${mid}`, de: `de ${mid}` };
};

// Neutral on purpose: no gendered noun or article for a person or group.
const ES_PLACEHOLDER_PHRASES: Readonly<Record<string, EsPhrase>> = {
  "The place": { start: "El lugar", mid: "el lugar", a: "al lugar", de: "del lugar" },
  "a place": plain("Un lugar"),
  // Stored before 2026-10-17; still in older rows.
  "The venue": { start: "El lugar", mid: "el lugar", a: "al lugar", de: "del lugar" },
  "a venue": plain("Un lugar"),
  // True only while every producer of "The act" handles TO_VENUE requests,
  // where the act is the sender. Revisit if one starts serving TO_PERFORMER.
  "The act": plain("Quien envió la solicitud"),
  Someone: plain("Alguien"),
  "A performer": plain("Alguien"),
  "An artist": plain("Alguien"),
  Performer: plain("Alguien"),
  "Your booking contact": plain("Tu contacto de contratación"),
  "An organizer": plain("Alguien que organiza eventos"),
  "The organiser": plain("Quien organiza"),
  "Your event": plain("Tu evento"),
};

/**
 * The name as the reader's language says it. `"en"` and any real name come
 * back verbatim. In `"es"` a stored fallback word becomes locale text; for
 * "a"/"de" positions the result INCLUDES the preposition (the caller drops
 * its own "a "/"de ").
 */
export function localizePlaceholderName(
  locale: NotificationLocale,
  name: string,
  position: PlaceholderPosition = "start",
): string {
  if (locale !== "es") return name;
  const phrase = Object.hasOwn(ES_PLACEHOLDER_PHRASES, name)
    ? ES_PLACEHOLDER_PHRASES[name]
    : undefined;
  return phrase ? phrase[position] : name;
}

/**
 * Same, for a real name in a "a"/"de" slot: the caller's preposition is part
 * of the template, so a real name needs it back.
 */
const withPreposition = (
  locale: NotificationLocale,
  name: string,
  position: PlaceholderPosition,
): string => {
  const phrase = localizePlaceholderName(locale, name, position);
  if (phrase !== name || (position !== "a" && position !== "de")) return phrase;
  return `${position} ${name}`;
};

/** Spanish-sentence helper: `${esName(name, "de")}` replaces `de ${name}`. */
export const esName = (name: string, position: PlaceholderPosition): string =>
  withPreposition("es", name, position);

/**
 * A volunteer role name for es copy. Producers store the English fallback
 * `"Volunteer"` when the role row is missing (`role?.name ?? "Volunteer"` in
 * volunteering/*); any other role name is the organizer's free text and stays
 * verbatim. For a noun-phrase slot ("tu turno de voluntariado",
 * "(voluntariado)").
 */
export function esVolunteerRole(roleName: string): string {
  return roleName === "Volunteer" ? "voluntariado" : roleName;
}

/**
 * The es clause naming the role a signup is for: `como <role>`, or
 * `volunteerForm` for the `"Volunteer"` fallback, which Spanish says without a
 * gendered noun ("Tu inscripción de voluntariado …").
 */
export function esVolunteerRoleClause(
  roleName: string,
  volunteerForm: string,
): string {
  return roleName === "Volunteer" ? volunteerForm : `como ${roleName}`;
}
