import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// Words the public iCal feeds write into a subscriber's calendar. The feed URL
// carries the language (`?lang=`), because the feeds are cached publicly by URL.
// The brand name "Ithas Fire" is not translated.
//
// Same rule as every copy module: a full `{ [L in NotificationLocale]: … }`,
// so a new locale fails the typecheck here until its words exist.
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarFeedCopy = {
  /** First line of a called-off show's description. */
  readonly cancelled: string;
  /** Description line naming the host. */
  readonly hostedBy: (host: string) => string;
  /** Calendar name when the owner has no name. */
  readonly hostCalendar: string;
};

export const CALENDAR_FEED_COPY: {
  readonly [L in NotificationLocale]: CalendarFeedCopy;
} = {
  en: {
    cancelled: "Cancelled.",
    hostedBy: (host) => `Hosted by ${host}`,
    hostCalendar: "Host calendar",
  },
  es: {
    cancelled: "Cancelado.",
    hostedBy: (host) => `Organiza: ${host}`,
    hostCalendar: "Calendario del anfitrión",
  },
};
