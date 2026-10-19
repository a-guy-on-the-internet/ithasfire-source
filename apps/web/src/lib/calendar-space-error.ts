import { getAppErrorCode } from "@/lib/app-error";

/**
 * Reader for the structured `meta` on `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR`
 * (`error.data.meta.calendars`). The server refuses the retirement AND names
 * the calendars it would strand — a bare "no" on a venue with a dozen
 * calendars is a dead end (owner ruling 2026-09-23).
 *
 * Returns `null` for any other error, and for this code without usable meta,
 * so callers fall back to the catalog sentence rather than rendering an empty
 * list. Names come out of `Space`/`Calendar` rows that were plain-text
 * sanitised on write and are rendered as React text nodes — no HTML sink.
 *
 * Shaped like `getInvalidFieldsMeta` in `./suggestion-error.ts`; kept separate
 * because the two metas share no fields.
 */
export type BlockingCalendar = { id: string; name: string };

export function getBlockingCalendars(
  error: unknown,
): BlockingCalendar[] | null {
  if (getAppErrorCode(error) !== "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR") {
    return null;
  }
  if (!error || typeof error !== "object") return null;
  const meta = (error as { data?: { meta?: unknown } }).data?.meta;
  if (!meta || typeof meta !== "object") return null;
  const raw = (meta as { calendars?: unknown }).calendars;
  if (!Array.isArray(raw)) return null;

  const calendars = raw.flatMap((entry): BlockingCalendar[] => {
    if (!entry || typeof entry !== "object") return [];
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || typeof name !== "string") return [];
    if (name.trim().length === 0) return [];
    return [{ id, name }];
  });

  return calendars.length > 0 ? calendars : null;
}

/**
 * Locale-correct "a, b and c". Mirrors `joinFields` in
 * `@/components/bookings/booking-system-entry` — `Intl.ListFormat` is in every
 * runtime this ships to, but a formatter throwing inside a render would take
 * the thread down over a cosmetic join.
 */
export function joinCalendarNames(names: string[], locale: string): string {
  if (names.length <= 1) return names[0] ?? "";
  try {
    return new Intl.ListFormat(locale || "en", {
      style: "long",
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}
