/**
 * The end every calendar builder (Google, Outlook, .ics) uses. The server can
 * send an `endsAt` that is unreadable, equal to the start or before it, and a
 * calendar link must not take the page down over that: anything that is not a
 * real moment after the start falls back to start + 2 hours.
 */
// Server twin: packages/core/src/lib/event-end.ts (resolveEventEnd). Change both together.
export function resolveEnd(start: Date, endsAt?: string): Date {
  if (endsAt) {
    const end = new Date(endsAt);
    if (end.getTime() > start.getTime()) return end;
  }
  return new Date(start.getTime() + 2 * 60 * 60 * 1000);
}
