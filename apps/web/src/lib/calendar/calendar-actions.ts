/**
 * The calendar overflow / peek actions as PURE helpers (event-calendar-
 * redesign FR-014 / FR-017): a single-event .ics, a month export of whatever
 * the grid is showing, and the webcal feed URL for an owner. Ported from the
 * retired `EventCalendar.tsx` so both mounts (dashboard, place) share one
 * implementation; nothing here touches React or tRPC. The two DOM touches —
 * triggering a download and writing the clipboard — are isolated in
 * `downloadTextFile` / `copyText` so the builders stay unit-testable.
 */

import {
  generateSingleEventIcs,
  generateVenueCalendarFeed,
  type ICalEvent,
} from "@th/core/lib/ical";

import type { CalendarEventItem } from "@/app/admin/[slug]/_components/calendar/types";

/** The feeds `apps/api/src/routes/ical.ts` serves. */
export type WebcalSubject =
  | { kind: "place"; placeId: string }
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

export type CalendarActionOptions = {
  /** Where public event pages live (`https://ithasfire.com`); no trailing slash. */
  siteBaseUrl: string;
  /** Title for an event with none (translated by the caller; helpers stay pure). */
  untitledTitle: string;
  /** The "View event: <url>" line of the description, in the viewer's language. */
  viewEventText: (url: string) => string;
};

const MONTH_FILE = [
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12",
] as const;

function absoluteHref(href: string | undefined, siteBaseUrl: string): string | undefined {
  if (!href) return undefined;
  return href.startsWith("/") ? `${siteBaseUrl}${href}` : href;
}

/** A painted event item as the iCal builders want it. */
export function toICalEvent(
  item: CalendarEventItem,
  { siteBaseUrl, untitledTitle, viewEventText }: CalendarActionOptions,
): ICalEvent {
  const url = absoluteHref(item.href?.public, siteBaseUrl);
  return {
    // One UID per OCCURRENCE — a multi-date listing is several VEVENTs, and a
    // shared UID would make subscribers collapse them onto one night.
    uid: `${item.id}@ithasfire.com`,
    title: item.title || untitledTitle,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    location: item.venueName ?? null,
    url: url ?? null,
    description: url ? viewEventText(url) : null,
  };
}

/** The .ics text for one event and the filename it should download as. */
export function buildSingleEventIcs(
  item: CalendarEventItem,
  options: CalendarActionOptions,
): { filename: string; content: string } {
  return {
    filename: `${safeFilename(item.title || options.untitledTitle)}.ics`,
    content: generateSingleEventIcs(toICalEvent(item, options)),
  };
}

/**
 * Every event the grid currently shows, as one feed file. `year`/`month`
 * (1–12) name the file; the caller passes the items already filtered to the
 * visible window and the active chips, so what exports is what is painted.
 */
export function buildMonthIcs(
  items: readonly CalendarEventItem[],
  year: number,
  month: number,
  calendarName: string,
  options: CalendarActionOptions,
): { filename: string; content: string } {
  const events = [...items]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((item) => toICalEvent(item, options));
  return {
    filename: `${safeFilename(calendarName)}-${year}-${MONTH_FILE[month - 1] ?? "00"}.ics`,
    content: generateVenueCalendarFeed(events, { calendarName }),
  };
}

/**
 * The languages a public calendar feed can be subscribed in, one subscribe
 * menu item each. Keep in step with core's `NOTIFICATION_LOCALES`
 * (`packages/core/src/use-cases/comms/locale.ts`), the languages the feeds
 * have copy for. `name` is the endonym, shown as-is in every UI language.
 */
export const WEBCAL_FEED_LOCALES = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
] as const;

/**
 * The subscribe URL — the API's feed with `webcal:` in place of `http(s):`
 * so Apple Calendar / Outlook open it as a subscription rather than a
 * download. `apiBaseUrl` is the API origin (the feeds are Fastify routes,
 * not Next ones). A non-English `locale` adds `?lang=` so the feed's text is
 * in that language; English URLs stay unchanged (the feeds are cached by URL).
 */
export function webcalFeedUrl(
  subject: WebcalSubject,
  apiBaseUrl: string,
  locale?: string,
): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const path =
    subject.kind === "place"
      ? `/api/venues/${subject.placeId}/calendar.ics`
      : subject.kind === "org"
        ? `/api/orgs/${subject.orgId}/calendar.ics`
        : `/api/humans/${subject.humanId}/calendar.ics`;
  const lang =
    locale && locale !== "en" ? `?lang=${encodeURIComponent(locale)}` : "";
  return `${base}${path}${lang}`.replace(/^https?:/, "webcal:");
}

/** Filesystem-safe, ≤50 chars, never empty. */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-_ ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 50);
  return cleaned || "calendar";
}

/** Browser-only: hand `content` to the user as a download. */
export function downloadTextFile(
  filename: string,
  content: string,
  mime = "text/calendar;charset=utf-8",
): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Browser-only: clipboard write that resolves to whether it took. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
