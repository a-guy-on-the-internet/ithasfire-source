/**
 * Pure iCalendar (RFC 5545) generation utilities.
 *
 * No external dependencies — generates spec-compliant .ics text from plain
 * event data. Used by the public calendar feeds (place, org, host), the
 * volunteering feed and emails, and client-side single-event download.
 */

import { resolveEventEnd } from "./event-end";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ICalEvent {
  /** Stable unique identifier (used as UID in the .ics). */
  uid: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  /** Full text address for LOCATION field. */
  location?: string | null;
  /** Plain-text description. */
  description?: string | null;
  /** Absolute http(s) URL to the event page; anything else is omitted. */
  url?: string | null;
  /**
   * Host name. Rendered as a "Hosted by <name>" first line of DESCRIPTION:
   * RFC 5545 ORGANIZER needs a cal-address, and we have no address to give
   * (an empty `MAILTO:` is invalid and some clients reject the entry).
   */
  organizerName?: string | null;
  /** Geo coordinates for the GEO field. */
  geo?: { lat: number; lng: number } | null;
  /**
   * `STATUS`. Defaults to CONFIRMED. A feed keeps a called-off show as
   * CANCELLED (same UID) so subscribers' calendars mark it instead of
   * silently losing it.
   */
  status?: "CONFIRMED" | "CANCELLED";
  /** `SEQUENCE` revision number. Defaults to 0. */
  sequence?: number;
  /** `LAST-MODIFIED` (the row's last write). Omitted when unknown. */
  lastModified?: Date | null;
}

/**
 * The words the lib writes into DESCRIPTION. The lib stays locale-agnostic:
 * the caller passes them already translated. Defaults to English.
 */
export interface ICalLabels {
  cancelled: string;
  hostedBy: (host: string) => string;
}

export const DEFAULT_ICAL_LABELS: ICalLabels = {
  cancelled: "Cancelled.",
  hostedBy: (host) => `Hosted by ${host}`,
};

export interface ICalFeedOptions {
  /** Translated description words. Defaults to English. */
  labels?: ICalLabels;
  /** Calendar display name (X-WR-CALNAME). */
  calendarName: string;
  /** Product identifier (-//Ithas Fire//EN). */
  prodId?: string;
  /** Refresh interval hint (e.g. "PT1H"). Defaults to 1 hour. */
  refreshInterval?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a Date as an iCal DATETIME string in UTC (YYYYMMDDTHHMMSSZ).
 */
function toICalDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** UTF-8 byte length of one code point. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

const MAX_LINE_OCTETS = 75;

/**
 * Fold a content line at 75 OCTETS of UTF-8 (RFC 5545 §3.1). Iterates by
 * code point, so a multi-byte character or a surrogate pair is never split;
 * each continuation line starts with one space, which counts toward its 75.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let currentOctets = 0;
  for (const char of line) {
    const octets = utf8Length(char.codePointAt(0)!);
    if (currentOctets + octets > MAX_LINE_OCTETS) {
      parts.push(current);
      current = " ";
      currentOctets = 1;
    }
    current += char;
    currentOctets += octets;
  }
  parts.push(current);
  return parts.join("\r\n");
}

/**
 * Escape text values per RFC 5545 §3.3.11. CRLF and a lone CR are line
 * breaks too: each becomes one escaped `\n`, never a raw CR in the output.
 */
export function escapeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * A URL value is a URI, not TEXT: it is never text-escaped. Only an absolute
 * http(s) URL is emitted, normalised by the WHATWG parser (which also strips
 * any CR/LF/tab); anything else is dropped.
 */
function safeUriValue(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function buildDescription(
  event: ICalEvent,
  labels: ICalLabels,
): string | null {
  const host = event.organizerName?.trim();
  const lines = [
    // Leads, so a client that ignores STATUS still shows the night is off.
    event.status === "CANCELLED" ? labels.cancelled : null,
    host ? labels.hostedBy(host) : null,
    event.description?.trim() ? event.description : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}

function buildVEvent(
  event: ICalEvent,
  dtstamp: string,
  labels: ICalLabels = DEFAULT_ICAL_LABELS,
): string {
  const lines: string[] = ["BEGIN:VEVENT"];

  lines.push(`UID:${event.uid}`);
  lines.push(`DTSTAMP:${dtstamp}`);
  lines.push(`DTSTART:${toICalDate(event.startsAt)}`);

  lines.push(
    `DTEND:${toICalDate(resolveEventEnd(event.startsAt, event.endsAt))}`,
  );

  if (event.lastModified) {
    lines.push(`LAST-MODIFIED:${toICalDate(event.lastModified)}`);
  }
  lines.push(`SEQUENCE:${Math.max(0, Math.trunc(event.sequence ?? 0))}`);

  lines.push(`SUMMARY:${escapeText(event.title)}`);

  if (event.location) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }

  const description = buildDescription(event, labels);
  if (description) {
    lines.push(`DESCRIPTION:${escapeText(description)}`);
  }

  const url = event.url ? safeUriValue(event.url) : null;
  if (url) {
    lines.push(`URL:${url}`);
  }

  if (event.geo) {
    lines.push(`GEO:${event.geo.lat};${event.geo.lng}`);
  }

  lines.push(`STATUS:${event.status ?? "CONFIRMED"}`);
  lines.push(`TRANSP:${event.status === "CANCELLED" ? "TRANSPARENT" : "OPAQUE"}`);
  lines.push("END:VEVENT");

  return lines.map(foldLine).join("\r\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a single-event .ics file content for "Add to Calendar" downloads.
 */
export function generateSingleEventIcs(event: ICalEvent): string {
  const dtstamp = toICalDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ithas Fire//Event//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    buildVEvent(event, dtstamp),
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * Generate a multi-event iCal feed for "Subscribe to Calendar" (webcal://).
 */
export function generateVenueCalendarFeed(
  events: ICalEvent[],
  options: ICalFeedOptions,
): string {
  const dtstamp = toICalDate(new Date());
  const prodId = options.prodId ?? "-//Ithas Fire//Calendar//EN";
  const refresh = options.refreshInterval ?? "PT1H";

  const header = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.calendarName)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${refresh}`,
    `X-PUBLISHED-TTL:${refresh}`,
  ].map(foldLine);

  const vevents = events.map((e) => buildVEvent(e, dtstamp, options.labels));

  const footer = ["END:VCALENDAR"];

  return [...header, ...vevents, ...footer].join("\r\n") + "\r\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar deep-link generators (client-side use)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a Google Calendar "add event" URL.
 */
export function googleCalendarUrl(event: ICalEvent): string {
  const params = new URLSearchParams();
  params.set("action", "TEMPLATE");
  params.set("text", event.title);
  params.set(
    "dates",
    `${toICalDate(event.startsAt)}/${toICalDate(resolveEventEnd(event.startsAt, event.endsAt))}`,
  );
  if (event.location) params.set("location", event.location);
  if (event.description) params.set("details", event.description);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Generate an Outlook.com "add event" URL.
 */
export function outlookCalendarUrl(event: ICalEvent): string {
  const params = new URLSearchParams();
  params.set("path", "/calendar/action/compose");
  params.set("rru", "addevent");
  params.set("subject", event.title);
  params.set("startdt", event.startsAt.toISOString());
  params.set(
    "enddt",
    resolveEventEnd(event.startsAt, event.endsAt).toISOString(),
  );
  if (event.location) params.set("location", event.location);
  if (event.description) params.set("body", event.description);
  return `https://outlook.live.com/calendar/0/action/compose?${params.toString()}`;
}
