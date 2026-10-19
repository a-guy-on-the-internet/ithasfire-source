import { isLiveBookingHold } from "./booking-inbox-tabs";

// ─────────────────────────────────────────────────────────────────────────────
// HOLD DISPLAY HELPERS (booking-holds spec 2026-08-25, FR-011 / FR-012).
//
// A hold is a place in a LINE for a calendar date: "2nd hold on Oct 13". The
// inbox row, the thread strip and the calendar overlay all say the same three
// things about one — its date, its position, and whether the clock is running
// on it — so the wording is built here, once, pure, and pinned by tests.
//
// STAFF-SIDE ONLY. The act's view (FR-013, a separate step) shows its own
// position and never the line; nothing here leaks another act's name because
// nothing here reads one.
//
// TIME. `respondBy` is an absolute instant; the "countdown" is derived from
// `now`, which the caller passes so the helpers stay pure (and so a test can
// pin "23 hours left" without faking the clock module-wide). `lapsed` is the
// SERVER's lazy-expiry projection and is trusted over any local arithmetic —
// the server and the client can disagree by a few seconds around the deadline,
// and the server is the one that will actually release the hold.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingHoldStatus = "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";

/** The hold summary a list row carries (bookingRequestHoldSummarySchema). */
export type BookingHoldSummary = {
  id: string;
  /** Null on performer scopes (the act never sees which calendar); always set on venue scopes. */
  calendarId: string | null;
  /** ISO `YYYY-MM-DD`, place-local. */
  date: string;
  position: number;
  status: BookingHoldStatus;
  respondBy: Date | null;
  lapsed: boolean;
};

export const DEFAULT_CHALLENGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MIN_CHALLENGE_WINDOW_MS = 60 * 60 * 1000;
/**
 * The latest deadline a challenge may set (challenge-booking-hold:
 * `MAX_CHALLENGE_WINDOW_MS`, ≤ now + 30 days). An extend has no ceiling.
 */
export const MAX_CHALLENGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Live holds, in line order then date order — the order every surface lists them in. */
export function liveHolds<T extends BookingHoldSummary>(holds: readonly T[]): T[] {
  return holds
    .filter(isLiveBookingHold)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.position - b.position));
}

/**
 * English-style ordinal SUFFIX selection is locale work; the catalogs carry
 * `bkHoldPosition{N}` for 1–3 and, past that, one key per ordinal PLURAL
 * CATEGORY (`Intl.PluralRules(…, { type: "ordinal" })`) so 21 reads "21st",
 * 22 "22nd", 23 "23rd", 24 "24th" — not "21th". Spanish uses the generic
 * "N.ª" form for every category; that is the catalog's decision, not this
 * function's, which is why the selector locale defaults to English: the
 * category only matters where the suffix does.
 */
export function holdPositionKey(position: number, locale = "en"): string {
  if (position === 1) return "admin.bkHoldPosition1";
  if (position === 2) return "admin.bkHoldPosition2";
  if (position === 3) return "admin.bkHoldPosition3";
  return `admin.bkHoldPositionNth${ordinalCategorySuffix(position, locale)}`;
}

/** "" for `other`, else the capitalised CLDR category: One / Two / Few. */
export function ordinalCategorySuffix(position: number, locale = "en"): string {
  let category = "other";
  try {
    category = new Intl.PluralRules(locale, { type: "ordinal" }).select(position);
  } catch {
    // An unknown locale tag falls back to the generic form.
  }
  if (category === "one") return "One";
  if (category === "two") return "Two";
  if (category === "few") return "Few";
  return "";
}

export type HoldCountdown =
  | { kind: "lapsed" }
  | { kind: "hours"; hours: number }
  | { kind: "minutes"; minutes: number };

/**
 * Time left on a challenge, coarsened to what a booker needs: whole hours
 * while more than an hour remains, minutes under that, "lapsed" at or past
 * the deadline (or when the server already says so). Null when the hold is
 * not challenged — there is no clock to read.
 */
export function holdCountdown(
  hold: Pick<BookingHoldSummary, "status" | "respondBy" | "lapsed">,
  now: Date,
): HoldCountdown | null {
  if (hold.status !== "CHALLENGED" || !hold.respondBy) return null;
  if (hold.lapsed) return { kind: "lapsed" };
  const remainingMs = new Date(hold.respondBy).getTime() - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { kind: "lapsed" };
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes >= 60) return { kind: "hours", hours: Math.floor(minutes / 60) };
  return { kind: "minutes", minutes };
}

/**
 * The default deadline offered by the Challenge form, and the floor the form
 * enforces before the server does (challenge-booking-hold: ≥ now + 1h).
 */
export function defaultChallengeDeadline(now: Date): Date {
  return new Date(now.getTime() + DEFAULT_CHALLENGE_WINDOW_MS);
}

/** An extend's new deadline: at least an hour out, no ceiling. */
export function isExtendDeadlineValid(deadline: Date, now: Date): boolean {
  const t = deadline.getTime();
  return Number.isFinite(t) && t - now.getTime() >= MIN_CHALLENGE_WINDOW_MS;
}

/** The latest deadline the Challenge form offers (now + 30 days). */
export function maxChallengeDeadline(now: Date): Date {
  return new Date(now.getTime() + MAX_CHALLENGE_WINDOW_MS);
}

/** A challenge's deadline beyond the 30-day ceiling. */
export function isChallengeDeadlineTooLate(deadline: Date, now: Date): boolean {
  return deadline.getTime() - now.getTime() > MAX_CHALLENGE_WINDOW_MS;
}

/** A challenge's deadline: between an hour and 30 days out. */
export function isChallengeDeadlineValid(deadline: Date, now: Date): boolean {
  return isExtendDeadlineValid(deadline, now) && !isChallengeDeadlineTooLate(deadline, now);
}

/**
 * `datetime-local` input value for an instant, in the viewer's zone, minute
 * precision. Built by hand because `toISOString()` is UTC and would shift the
 * shown time by the viewer's offset.
 */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Inverse of {@link toDateTimeLocalValue}; null for anything unparseable. */
export function fromDateTimeLocalValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Whether a preferred-date entry can seed a hold. `preferredDates` admits
 * `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM`; a hold is date-level, so the clock is
 * dropped. Anything else (legacy/corrupt) is skipped rather than offered.
 */
export function holdDateFromPreferred(entry: string): string | null {
  const [datePart] = entry.split("T");
  return datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

/**
 * Touch floor for the hold action buttons (Keep / Release / Confirm / reorder
 * / Place …). The row keeps `size="$2"` (34px) at desktop density; under
 * `$sm` — where a thumb, not a pointer, hits it — every action grows to the
 * 44px floor the design system sets for touch. `height: "auto"` releases the
 * size variant's fixed height so `minHeight` can win; `minWidth` keeps the
 * icon-only reorder arrows square.
 */
export const HOLD_ACTION_TOUCH = { height: "auto", minHeight: 44, minWidth: 44 } as const;
