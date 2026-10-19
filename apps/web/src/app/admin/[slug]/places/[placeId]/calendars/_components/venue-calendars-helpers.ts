// ─────────────────────────────────────────────────────────────────────────────
// Calendars management — pure helpers
//
// The availability model moved from Place to Calendar (venue-hierarchy spec,
// FR-007): one `CalendarAvailability` table backs both surfaces, with a
// PLACE-WIDE scope on top:
//  - a row with `dayOfWeek` is a recurring opening window. SEVERAL rows per
//    weekday are legal, which is what lets a calendar open twice in a day —
//    a matinee and an evening.
//  - a row with `date` and `isOpen: false` is a one-off blackout.
//  - `calendarId: null` = "All calendars" — ONE row that applies to every
//    calendar of the place (venue closed = one row, one edit, no drift).
//
// Write semantics the payload builders below pin (and their tests guard):
//  1. FULL-PUT — `upsertCalendarAvailability` replaces the whole row; every
//     field is sent every time and `isOpen` is ALWAYS present (omitting it is
//     a server-side validation error, never a silent reopen).
//  2. dayOfWeek XOR date — exactly one is non-null, never both.
//  3. Scope is immutable after create — updates restate the ROW'S OWN
//     `calendarId`, never the UI's currently-selected scope.
// ─────────────────────────────────────────────────────────────────────────────

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

type PlacesOutputs = inferRouterOutputs<AppRouter>["places"];

/** Availability row as the router returns it (superjson revives `date`). */
export type AvailabilityRow =
  PlacesOutputs["listCalendarAvailability"][number];

export type SpaceRow = PlacesOutputs["listSpaces"][number];
export type CalendarRow = PlacesOutputs["listCalendars"][number];

/**
 * Availability scope selector value: `null` = the place-wide "All calendars"
 * scope, otherwise a calendar id.
 */
export type AvailabilityScope = string | null;

/** Monday-first, because a week of programming starts on Monday, not Sunday. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const DEFAULT_WINDOW = { startTime: "18:00", endTime: "23:00" } as const;
export const DEFAULT_EXTRA_WINDOW = {
  startTime: "12:00",
  endTime: "16:00",
} as const;

/** Widest range a single "add" can expand to, so a fat-fingered year can't
 *  fire hundreds of writes. */
export const MAX_BLACKOUT_RANGE_DAYS = 60;

export function toMinutes(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * A closing time at or before the opening time means the night runs past
 * midnight — Friday 18:00 → 02:00 is one night, not an error.
 */
export function isOvernight(startTime: string, endTime: string): boolean {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start === null || end === null) return false;
  return end <= start;
}

/** The only genuinely invalid window is one with no duration at all. */
export function windowError(
  startTime: string,
  endTime: string,
): "invalid" | "empty" | null {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start === null || end === null) return "invalid";
  if (start === end) return "empty";
  return null;
}

/** Minimal structural shape the scope filters need (tests build these). */
export type AvailabilityRowLike = {
  id: string;
  calendarId: string | null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
  isOpen: boolean;
};

/**
 * Weekly open windows for one weekday WITHIN one scope. Hours never bleed
 * across scopes: the "All calendars" grid edits only place-wide rows, a
 * calendar's grid edits only that calendar's rows.
 */
export function openWindowsForDay<T extends AvailabilityRowLike>(
  rows: readonly T[],
  scope: AvailabilityScope,
  dayOfWeek: number,
): T[] {
  return rows
    .filter(
      (r) =>
        r.calendarId === scope &&
        r.dayOfWeek === dayOfWeek &&
        r.date === null &&
        r.isOpen,
    )
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
}

/**
 * Blackouts visible in a scope, in date order. A place-wide blackout closes
 * EVERY calendar, so it also shows (chip-marked) when a specific calendar is
 * selected — hiding it there would make that calendar look open on a night
 * the venue is dark.
 */
export function blackoutRowsForScope<T extends AvailabilityRowLike>(
  rows: readonly T[],
  scope: AvailabilityScope,
): T[] {
  return rows
    .filter(
      (r) =>
        r.date !== null &&
        !r.isOpen &&
        (r.calendarId === scope || r.calendarId === null),
    )
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}

/** Full-PUT payload (minus placeId/id, added by the caller). */
export type AvailabilityUpsertFields = {
  calendarId: string | null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  isOpen: boolean;
  note: string | null;
};

/**
 * Full-PUT payload for a weekly window. With `row` present this is an UPDATE
 * and the scope comes from THE ROW (scope is immutable after create); without
 * it, a CREATE at the given UI scope.
 */
export function hoursUpsertFields(args: {
  scope: AvailabilityScope;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  row?: AvailabilityRowLike;
}): AvailabilityUpsertFields {
  return {
    calendarId: args.row ? args.row.calendarId : args.scope,
    dayOfWeek: args.dayOfWeek,
    date: null,
    startTime: args.startTime,
    endTime: args.endTime,
    // A weekly row in this editor is by definition an open window; restated
    // explicitly on every write (full-PUT — isOpen is never omitted).
    isOpen: true,
    note: args.row?.note ?? null,
  };
}

/** Full-PUT payload for a one-off blackout CREATE at the given scope. */
export function blackoutCreateFields(args: {
  scope: AvailabilityScope;
  date: Date;
  note: string | null;
}): AvailabilityUpsertFields {
  return {
    calendarId: args.scope,
    dayOfWeek: null,
    date: args.date,
    startTime: null,
    endTime: null,
    isOpen: false,
    note: args.note,
  };
}

/**
 * Every date from `from` to `to` inclusive, as local midnights. Returns an
 * empty array when the range is backwards or longer than the cap.
 */
export function expandDateRange(from: string, to: string): Date[] {
  const start = parseDateInput(from);
  const end = parseDateInput(to);
  if (!start || !end || end < start) return [];

  const out: Date[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (out.length > MAX_BLACKOUT_RANGE_DAYS) return [];
  }
  return out;
}

/**
 * `<input type="date">` gives "YYYY-MM-DD". Building the Date from parts keeps
 * it at LOCAL midnight — `new Date("2026-09-01")` parses as UTC and lands on
 * the previous day for anyone west of Greenwich.
 */
export function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Spaces / calendars list rules ────────────────────────────────────────────

export type SpaceRowLike = { id: string; status: "ACTIVE" | "RETIRED" };

/**
 * True when retiring this space would leave the place with zero active spaces —
 * the UI disables Retire with a reason. The server enforces the invariant too
 * (CANNOT_RETIRE_LAST_ACTIVE_SPACE), so a raced click still fails safely.
 */
export function isLastActiveSpace(
  spaces: readonly SpaceRowLike[],
  spaceId: string,
): boolean {
  const active = spaces.filter((r) => r.status === "ACTIVE");
  return active.length === 1 && active[0]?.id === spaceId;
}

/**
 * True when a calendar has no ACTIVE space to schedule into — joined only to
 * retired spaces, or to none at all. Rendered as a "No active spaces" warning
 * chip on the calendar card.
 */
export function calendarHasNoActiveSpaces(calendar: {
  spaces: readonly SpaceRowLike[];
}): boolean {
  return !calendar.spaces.some((r) => r.status === "ACTIVE");
}

/**
 * A native `<input type="time">` / `<input type="date">` style, not the DS
 * `TextInput` — the DS input patches `type` onto the DOM node imperatively
 * and the patch does not land for `type="time"` (verified in the browser by
 * the editor this one absorbs; PackShiftsEditor and VolunteerTemplatesView
 * reach for the same native-input trade).
 */
export function timeInputStyle(hasError: boolean): React.CSSProperties {
  return {
    height: 40,
    padding: "0 12px",
    border: `2px solid ${hasError ? "var(--danger, #B91C1C)" : "var(--borderColor, #211C16)"}`,
    borderRadius: 0,
    backgroundColor: "var(--surface, #FDFAF3)",
    color: "var(--color, #211C16)",
    fontFamily: "inherit",
    fontSize: 14,
    fontVariantNumeric: "tabular-nums",
    boxSizing: "border-box",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking config layer (venue-confirmation-and-booking-intents spec,
// docs/specs/2026-08-27 — "Calendar is the config layer"). Per calendar:
// which INTENTS it accepts (PERFORM / RENT / USE — public verbs "Play here /
// Rent a space / Use a space"), a flat rental rate per booking with its
// currency, and whether that rate shows publicly. `rentalMode` is RESERVED
// (own spec) and never reaches this UI.
//
// Two rules the builders below pin:
//  1. DIFF, never full-put — a save carries only the booking fields the owner
//     changed, so a calendar nobody touched keeps sending the exact payload
//     it sent before this layer existed (byte-identical until a venue flips
//     a toggle).
//  2. A rate is an amount AND a currency — the server refines the pair and
//     the client resolves it the same way, so the refusal surfaces as a field
//     error and never as a toast about "rentalRateCurrency".
// ─────────────────────────────────────────────────────────────────────────────


export type BookingIntentKey = "perform" | "rent" | "use";

/** The stored booking config, as `listCalendars` returns it. */
export interface BookingConfigLike {
  acceptsPerform: boolean;
  acceptsRent: boolean;
  acceptsUse: boolean;
  rentalRateCents: number | null;
  rentalRateCurrency: string | null;
  rentalRateVisible: boolean;
}

/** DB defaults (venue.prisma): perform on, rent/use off, no rate, private. */
export const BOOKING_CONFIG_DEFAULTS: BookingConfigLike = {
  acceptsPerform: true,
  acceptsRent: false,
  acceptsUse: false,
  rentalRateCents: null,
  rentalRateCurrency: null,
  rentalRateVisible: false,
};

/**
 * Currencies offered for the rental rate. Neither the place nor the org
 * carries a currency (see agreement.prisma: "venue-level currency isn't
 * modeled"), so the form defaults to USD. The stored value, when it is
 * something else, is added by `rentalRateCurrencyOptions` so the select never
 * silently re-labels a saved rate.
 */
export const RENTAL_RATE_CURRENCIES = [
  "USD",
  "CAD",
  "MXN",
  "EUR",
  "GBP",
] as const;

export const DEFAULT_RENTAL_RATE_CURRENCY = "USD";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "$",
  MXN: "$",
  EUR: "€",
  GBP: "£",
};

/** The glyph inset into the amount field. Unknown codes show the code. */
export function rentalRateCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

/** The select's options: the fixed list, plus the stored code if it is off-list. */
export function rentalRateCurrencyOptions(stored: string | null): string[] {
  const list: string[] = [...RENTAL_RATE_CURRENCIES];
  if (stored && !list.includes(stored)) list.unshift(stored);
  return list;
}

/** What the booking group of the calendar form holds. */
export interface BookingConfigForm {
  acceptsPerform: boolean;
  acceptsRent: boolean;
  acceptsUse: boolean;
  /** Free-text major units ("500", "500.00", "1.234,56") — parsed on submit. */
  rentalRateAmount: string;
  rentalRateCurrency: string;
  rentalRateVisible: boolean;
}

/**
 * Cents → the text the amount field opens with. Only NULL (no rate stated)
 * is blank; a stored $0 renders "0.00", because blank re-resolves to "no
 * rate" and an untouched save would then wipe a real zero rate as a pair of
 * nulls.
 */
export function centsToAmountInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

/** Keeps digits, separators, sign and whitespace; the parser adjudicates. */
export function sanitizeRentalRateInput(input: string): string {
  return input.replace(/[^0-9.,\s-]/g, "");
}

export function bookingFormFromConfig(config: BookingConfigLike): BookingConfigForm {
  return {
    acceptsPerform: config.acceptsPerform,
    acceptsRent: config.acceptsRent,
    acceptsUse: config.acceptsUse,
    rentalRateAmount: centsToAmountInput(config.rentalRateCents),
    rentalRateCurrency:
      config.rentalRateCurrency ?? DEFAULT_RENTAL_RATE_CURRENCY,
    rentalRateVisible: config.rentalRateVisible,
  };
}

export type RentalRateField = "amount" | "currency";

export type RentalRateResolution =
  | { ok: true; rentalRateCents: number | null; rentalRateCurrency: string | null }
  | { ok: false; field: RentalRateField; messageKey: string };

/**
 * The client half of the server's pair rule. Blank amount = no rate stated
 * (both halves null). Anything typed must parse — ambiguous input ("1,500")
 * is refused rather than guessed, the same footgun class as the $1,550-promo
 * bug — and must come with a 3-letter currency.
 */
export function resolveRentalRate(
  amountRaw: string,
  currency: string,
): RentalRateResolution {
  const parsed = parseMoneyInputToCents(amountRaw);
  if (!parsed.ok) {
    if (parsed.reason === "empty") {
      return { ok: true, rentalRateCents: null, rentalRateCurrency: null };
    }
    return {
      ok: false,
      field: "amount",
      messageKey:
        parsed.reason === "ambiguous"
          ? "admin.calMgrRentalRateAmbiguous"
          : parsed.reason === "negative"
            ? "admin.calMgrRentalRateNegative"
            : "admin.calMgrRentalRateInvalid",
    };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return {
      ok: false,
      field: "currency",
      messageKey: "admin.calMgrRentalRateCurrencyRequired",
    };
  }
  return { ok: true, rentalRateCents: parsed.cents, rentalRateCurrency: currency };
}

/** The wire shape shared by createCalendar and updateCalendar's patch. */
export interface BookingConfigPatch {
  acceptsPerform?: boolean;
  acceptsRent?: boolean;
  acceptsUse?: boolean;
  rentalRateCents?: number | null;
  rentalRateCurrency?: string | null;
  rentalRateVisible?: boolean;
}

export type BookingConfigPatchResult =
  | { ok: true; patch: BookingConfigPatch }
  | { ok: false; field: RentalRateField; messageKey: string };

/**
 * The booking fields to send, and ONLY those that differ from `current` (the
 * stored row on update, `BOOKING_CONFIG_DEFAULTS` on create). The rate travels
 * as a pair — both halves or neither — and only while Rent is on: with Rent
 * off the rate fields are hidden, so whatever they hold is neither validated
 * nor sent, and the stored rate survives a round trip through "off".
 */
export function bookingConfigPatch(
  form: BookingConfigForm,
  current: BookingConfigLike,
): BookingConfigPatchResult {
  const patch: BookingConfigPatch = {};
  if (form.acceptsPerform !== current.acceptsPerform) {
    patch.acceptsPerform = form.acceptsPerform;
  }
  if (form.acceptsRent !== current.acceptsRent) {
    patch.acceptsRent = form.acceptsRent;
  }
  if (form.acceptsUse !== current.acceptsUse) {
    patch.acceptsUse = form.acceptsUse;
  }
  if (form.acceptsRent) {
    if (form.rentalRateVisible !== current.rentalRateVisible) {
      patch.rentalRateVisible = form.rentalRateVisible;
    }
    const rate = resolveRentalRate(form.rentalRateAmount, form.rentalRateCurrency);
    if (!rate.ok) return rate;
    if (
      rate.rentalRateCents !== current.rentalRateCents ||
      rate.rentalRateCurrency !== current.rentalRateCurrency
    ) {
      patch.rentalRateCents = rate.rentalRateCents;
      patch.rentalRateCurrency = rate.rentalRateCurrency;
    }
  }
  return { ok: true, patch };
}

/**
 * Which rate field a FAILED save is about, or null when the error is not a
 * rate-pair refusal. Two wire shapes reach here: tRPC's own input validation
 * (update's patch keeps the `superRefine`, so the message is Zod's JSON issue
 * dump with `path: ["patch", "rentalRateCurrency"]`), and a normalised
 * `data.zodError.fieldErrors` map. Anything else stays a toast.
 */
export function rentalRateFieldFromError(err: unknown): RentalRateField | null {
  const fieldFor = (name: unknown): RentalRateField | null =>
    name === "rentalRateCents"
      ? "amount"
      : name === "rentalRateCurrency"
        ? "currency"
        : null;

  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  if (!record) return null;

  const data = record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : null;
  const zodError = data?.zodError && typeof data.zodError === "object"
    ? (data.zodError as Record<string, unknown>)
    : null;
  const fieldErrors = zodError?.fieldErrors && typeof zodError.fieldErrors === "object"
    ? (zodError.fieldErrors as Record<string, unknown>)
    : null;
  if (fieldErrors) {
    for (const key of Object.keys(fieldErrors)) {
      const field = fieldFor(key.split(".").pop());
      if (field) return field;
    }
  }

  const message = typeof record.message === "string" ? record.message : "";
  if (/^\s*\[/.test(message)) {
    try {
      const issues: unknown = JSON.parse(message);
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const path = (issue as { path?: unknown[] })?.path;
          const field = Array.isArray(path) ? fieldFor(path[path.length - 1]) : null;
          if (field) return field;
        }
      }
    } catch {
      // Not JSON — not a validation dump.
    }
  }
  return null;
}

/**
 * The compact intent line on a calendar's list row — "Play · Rent $500 · Use".
 * Verbs are the spec's public vocabulary, passed in already translated; the
 * rate is formatted by the caller (`Money.format`) so this module stays free
 * of the UI package. An empty array means the calendar takes no requests.
 */
export function intentSummaryParts(
  config: Partial<BookingConfigLike>,
  labels: {
    perform: string;
    rent: string;
    /** `rate` is the formatted amount; the label decides where it sits. */
    rentWithRate: (rate: string) => string;
    use: string;
  },
  formatRate: (cents: number, currency: string) => string,
): string[] {
  const parts: string[] = [];
  if (config.acceptsPerform) parts.push(labels.perform);
  if (config.acceptsRent) {
    parts.push(
      config.rentalRateCents != null && config.rentalRateCurrency
        ? labels.rentWithRate(
            formatRate(config.rentalRateCents, config.rentalRateCurrency),
          )
        : labels.rent,
    );
  }
  if (config.acceptsUse) parts.push(labels.use);
  return parts;
}
