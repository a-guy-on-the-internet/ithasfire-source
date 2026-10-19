import { DEFAULT_VENUE_TIMEZONE } from "@th/types/datetime";

/** True when `timezone` is an IANA id Intl accepts. */
export const isKnownTimeZone = (
  timezone: string | null | undefined,
): timezone is string => {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The zone an event's dates render in, for templates.
 *
 * A template that formats an instant with no `timeZone` uses the runtime's
 * zone, which is UTC on Cloud Run: a 7pm Chicago show (00:00Z the next day)
 * printed tomorrow's date. Templates take the event's IANA zone as a prop and
 * spread `zoneOption(timezone)` into their `Intl.DateTimeFormat` options.
 *
 * Returns the zone when Intl knows it, else the platform default
 * (`DEFAULT_VENUE_TIMEZONE`, the same fallback core's `resolveTimeZone`
 * uses), never a throw. The runtime zone is NOT a fallback: on Cloud Run it
 * is UTC, the bug this helper exists to fix.
 */
export const usableTimeZone = (timezone: string | null | undefined): string =>
  isKnownTimeZone(timezone) ? timezone : DEFAULT_VENUE_TIMEZONE;

/** `{ timeZone }` to spread into Intl options: the usable zone, or the default. */
export const zoneOption = (
  timezone: string | null | undefined,
): { timeZone: string } => ({ timeZone: usableTimeZone(timezone) });
