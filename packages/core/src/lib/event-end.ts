const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * The end every server-side calendar output (.ics, Google, Outlook) uses.
 * `endsAt` counts only when it is a valid Date strictly after the start
 * (RFC 5545 §3.8.2.2); anything else falls back to start + 2 hours.
 *
 * Mirrors `resolveEnd` in apps/web/src/lib/calendar/event-end.ts (the web app
 * cannot import core internals). Change both together.
 */
export function resolveEventEnd(
  startsAt: Date,
  endsAt: Date | null | undefined,
): Date {
  if (endsAt && endsAt.getTime() > startsAt.getTime()) return endsAt;
  return new Date(startsAt.getTime() + DEFAULT_DURATION_MS);
}
