/**
 * Shared date formatting helpers for form components.
 *
 * Note: keep these free of React/DOM dependencies so they can be used in
 * native/web implementations.
 */

export type DateInput = Date | string | number | null | undefined;

export type DateDisplayFormat = keyof typeof DEFAULT_PLACEHOLDERS;

export type DatePickerVariant = "input-with-popover" | "input" | "picker";

export const DEFAULT_PLACEHOLDERS = {
  single: "YYYY-MM-DD",
  rangeStart: "Start date",
  rangeEnd: "End date",
} as const;

/**
 * Normalizes any supported date input to a Date instance.
 * Returns null for invalid / empty inputs.
 */
export function toDate(value: DateInput): Date | null {
  if (value == null) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Formats a Date into an ISO-like date string: YYYY-MM-DD.
 * Returns "" if the input is empty/invalid.
 */
export function formatDateYYYYMMDD(value: DateInput): string {
  const d = toDate(value);
  if (!d) return "";

  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Formats into a user-display-friendly string. We intentionally keep this
 * deterministic and locale-agnostic to avoid server/client mismatches.
 */
export function formatDateForDisplay(value: DateInput): string {
  const d = toDate(value);
  if (!d) return "";
  return formatDateYYYYMMDD(d);
}

export function formatDigitsForDisplay(digits: string): string {
  const clean = digits.replace(/[^0-9]/g, "");
  const yyyy = clean.slice(0, 4);
  const mm = clean.slice(4, 6);
  const dd = clean.slice(6, 8);

  const parts = [yyyy];
  if (mm.length) parts.push(mm);
  if (dd.length) parts.push(dd);
  return parts.filter(Boolean).join("-");
}

export function formatIsoToDisplay(iso: string | null | undefined): string {
  if (!iso) return "";
  // We treat ISO values as already normalized (YYYY-MM-DD)
  return iso;
}

/**
 * Formats an ISO date string into a human-readable label like
 * "Feb 12, 2026" (date-only) or "Feb 12, 2026 at 7:00 PM" (datetime).
 * Falls back to the raw value when the input is unparseable.
 */
export function formatIsoToHumanDisplay(
  iso: string | null | undefined,
): string {
  if (!iso) return "";

  const d = toDate(iso);
  if (!d) return iso;

  // Determine whether the value includes meaningful time information.
  // Pure date values (YYYY-MM-DD) parse to midnight UTC; anything with
  // an explicit time component or a timezone offset is treated as datetime.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);

  if (isDateOnly) {
    // Use UTC methods so "2026-02-12" doesn't shift to the previous day.
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(d);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function parseDisplayToIso(display: string): string | null {
  const digits = display.replace(/[^0-9]/g, "");
  if (digits.length !== 8) return null;

  const yyyy = digits.slice(0, 4);
  const mm = digits.slice(4, 6);
  const dd = digits.slice(6, 8);

  // Basic bounds check (more strict validation can be layered above)
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  )
    return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const candidate = `${yyyy}-${mm}-${dd}`;
  // Reject impossible calendar dates like 2024-02-31
  const parsed = toDate(candidate);
  if (!parsed) return null;
  if (formatDateYYYYMMDD(parsed) !== candidate) return null;

  return candidate;
}

export function isIsoWithinBounds(
  iso: string | null | undefined,
  bounds: { min?: string | null; max?: string | null },
): boolean {
  if (!iso) return true;
  const { min, max } = bounds;
  if (min && iso < min) return false;
  if (max && iso > max) return false;
  return true;
}
