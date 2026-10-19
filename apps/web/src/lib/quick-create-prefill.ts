/**
 * Quick-create prefill seam (venue-hierarchy FR-011,
 * docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
 *
 * Clicking an empty cell on an admin calendar routes to
 * `/admin/:slug/events/new` carrying the cell's context in the query string.
 * These helpers are the ONE place that vocabulary is written and read, so the
 * producer (calendar) and the consumer (QuickCreateEventForm) can never drift.
 *
 * Everything here is DEFENSIVE by construction: a hand-edited, stale, or
 * hostile query string must degrade to "no prefill", never to a crash or a
 * bogus form value. `sanitizeQuickCreatePrefill` is also the guard that makes
 * `createDraft(prefill)` safe to bind straight to an `onPress` handler — a
 * React Native gesture event has none of these keys, so it sanitizes to `{}`.
 *
 * PLACEMENT (`calendarId` / `spaceId`): these two keys are PERSISTED. The
 * quick-create mutations (`events.createEventForHuman` / `createEventForOrg` →
 * `save-event-for-*`) accept them as optional input and stamp
 * `Event.calendarId` / `Event.spaceId` in the same transaction that creates the
 * event, after asserting both belong to the resolved Place (and that the space
 * is ACTIVE). The consumer only forwards them while the resolved venue is
 * still the prefilled place — see `resolveQuickCreatePlacement`.
 */

export type QuickCreatePrefill = {
  /** Wall clock for an `<input type="datetime-local">`: "YYYY-MM-DDTHH:mm". */
  startsAt?: string;
  /** An Ithas Fire Place id — seeds the venue field's "My Places" branch. */
  placeId?: string;
  /** Named Calendar (programming stream) the cell belongs to. Persisted on the created event. */
  calendarId?: string;
  /** Space (physical resource) the cell belongs to. Persisted on the created event. */
  spaceId?: string;
};

/** Query-string keys, in the order they are written. */
export const QUICK_CREATE_PREFILL_KEYS = [
  "startsAt",
  "placeId",
  "calendarId",
  "spaceId",
] as const;

/**
 * `datetime-local` with minute precision and NO seconds/offset — exactly what
 * the input reads and writes. Hours are clamped to 00–23 and minutes to 00–59
 * so "2026-13-40T99:99" is rejected rather than handed to the browser.
 */
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** "HH:mm", 24-hour — the shape `Calendar.defaultStartTime` stores. */
const TIME_24H_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Fallback wall clock when no calendar default is known (the dashboard
 * calendar has no place, so it has no Calendar row to read). Evening is the
 * overwhelmingly common start for the events this product schedules; the
 * organiser can still change it, and a wrong-but-plausible time beats an
 * empty required field.
 */
export const QUICK_CREATE_FALLBACK_START_TIME = "19:00";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * A `Date` (interpreted in the browser's zone, which is how every calendar
 * view builds its day/slot Dates) → the `datetime-local` reading of that same
 * wall clock. Deliberately NOT `toDateTimeLocalValue`'s Intl round trip: the
 * input is already a local-time Date, so reading its local getters is both
 * exact and free.
 */
export function toPrefillDateTimeLocal(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/**
 * Month cells carry a DATE with no time. Stamp the calendar's own
 * `defaultStartTime` onto it when the source calendar is known, else the
 * evening fallback. A malformed stored value falls back rather than throwing.
 */
export function dayWithDefaultStartTime(
  day: Date,
  defaultStartTime?: string | null,
): Date {
  const hhmm =
    defaultStartTime && TIME_24H_RE.test(defaultStartTime)
      ? defaultStartTime
      : QUICK_CREATE_FALLBACK_START_TIME;
  const [h, m] = hhmm.split(":");
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Number(h),
    Number(m),
    0,
    0,
  );
}

function validValue(key: (typeof QUICK_CREATE_PREFILL_KEYS)[number], raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (key === "startsAt") return DATETIME_LOCAL_RE.test(value) ? value : null;
  return UUID_RE.test(value) ? value : null;
}

/**
 * Keep only the known keys whose values are well-formed. Anything else —
 * extra keys, wrong types, a gesture event, `null` — yields `{}`.
 */
export function sanitizeQuickCreatePrefill(input: unknown): QuickCreatePrefill {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const out: QuickCreatePrefill = {};
  for (const key of QUICK_CREATE_PREFILL_KEYS) {
    const value = validValue(key, source[key]);
    if (value) out[key] = value;
  }
  return out;
}

export function isEmptyQuickCreatePrefill(prefill: QuickCreatePrefill): boolean {
  return QUICK_CREATE_PREFILL_KEYS.every((key) => prefill[key] === undefined);
}

/**
 * `{ startsAt, placeId }` → `"?startsAt=…&placeId=…"` (empty string when there
 * is nothing to carry, so callers can concatenate unconditionally).
 */
export function buildQuickCreatePrefillQuery(input?: unknown): string {
  const prefill = sanitizeQuickCreatePrefill(input);
  const params = new URLSearchParams();
  for (const key of QUICK_CREATE_PREFILL_KEYS) {
    const value = prefill[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Minimal read surface — satisfied by both `URLSearchParams` and Next's `ReadonlyURLSearchParams`. */
export type PrefillParamReader = { get(name: string): string | null };

/** The consumer half: read the query string back into a validated prefill. */
export function readQuickCreatePrefill(
  params: PrefillParamReader | null | undefined,
): QuickCreatePrefill {
  if (!params) return {};
  const raw: Record<string, unknown> = {};
  for (const key of QUICK_CREATE_PREFILL_KEYS) {
    raw[key] = params.get(key);
  }
  return sanitizeQuickCreatePrefill(raw);
}
