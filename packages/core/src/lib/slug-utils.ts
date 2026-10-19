/**
 * Shared slug-generation primitives.
 *
 * Used by both the event and place slug generators. Domain-specific helpers
 * (date segments, host segments, etc.) live in their respective `_shared/slug.ts`
 * modules.
 */

const COUNTRY_FALLBACK = "xx";

/**
 * Build a single URL-safe slug segment from an arbitrary string.
 * Falls back to `fallback` when the value is empty after sanitisation.
 */
export function slugSegment(
  value: string | null | undefined,
  fallback: string,
  maxLength: number,
): string {
  const trimmed = sanitizeText(value);
  if (!trimmed) {
    return fallback;
  }
  return truncate(trimmed, maxLength);
}

/**
 * Normalise an arbitrary string into a URL-safe slug fragment.
 *
 * - NFKD-decomposes accented characters and strips combining marks.
 * - Replaces non-letter/non-number runs with a single hyphen.
 * - Lower-cases everything.
 * - Returns `null` if the result would be empty.
 */
export function sanitizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

/**
 * Normalise a country code into a lowercase 2-3 letter slug segment.
 * Returns "xx" when the code is absent or empty.
 */
export function sanitizeCountryCode(code: string | null | undefined): string {
  if (!code) return COUNTRY_FALLBACK;
  const normalized = code.replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (normalized.length === 0) return COUNTRY_FALLBACK;
  return truncate(normalized, 3);
}

/** Truncate a string, stripping any trailing hyphens from the cut. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).replace(/-+$/g, "");
}

/** Length of the base-36 short ID (a-z 0-9). */
const SHORT_ID_LENGTH = 10;

/**
 * Derive a {@link SHORT_ID_LENGTH}-character base-36 short ID from a UUID.
 *
 * Converts the 128-bit UUID hex into a BigInt, encodes in base-36 (a-z 0-9),
 * and takes the last {@link SHORT_ID_LENGTH} characters (most-entropic portion).
 *
 * **Collision probability (birthday paradox):**
 * - 36^10 ≈ 3.66 × 10^15 possible values
 * - At 1 M orders ≈ 0.014 %
 * - At 10 M orders ≈ 1.4 %
 *
 * The `@unique` DB constraint guarantees correctness; on the rare collision
 * the caller should retry with {@link generateRandomShortId}.
 */
export function deriveShortIdFromUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  const n = BigInt(`0x${hex}`);
  const b36 = n.toString(36); // full base-36 encoding of 128-bit value
  // Take the rightmost SHORT_ID_LENGTH chars (highest entropy).
  // Pad left with '0' in the (theoretically impossible) case it's shorter.
  return b36.slice(-SHORT_ID_LENGTH).padStart(SHORT_ID_LENGTH, "0");
}

/**
 * Generate a random {@link SHORT_ID_LENGTH}-character base-36 short ID using
 * `crypto.randomUUID()`. Used as a collision fallback when
 * {@link deriveShortIdFromUuid} produces a duplicate.
 */
export function generateRandomShortId(): string {
  return deriveShortIdFromUuid(crypto.randomUUID());
}

/**
 * Sanitise a candidate short ID: strip non-alphanumeric, truncate to
 * {@link SHORT_ID_LENGTH}, pad. Returns `null` when the candidate is empty
 * after sanitisation.
 */
export function sanitizeShortId(value: string): string | null {
  const normalized = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized.length === 0) return null;
  return truncate(normalized, SHORT_ID_LENGTH).padEnd(SHORT_ID_LENGTH, "0");
}

/**
 * STRICT reading of a short ID someone typed or pasted (a `/e/<shortId>`
 * short link): the lowercased ID when `value` already IS one — exactly
 * {@link SHORT_ID_LENGTH} base-36 characters, any case — else `null`.
 *
 * {@link sanitizeShortId} repairs a candidate (strips, truncates, pads), which
 * is right for minting an ID and wrong for looking one up: `ab` would become
 * `ab00000000` and resolve someone else's event. So this accepts only what
 * sanitising leaves unchanged apart from case.
 */
export function parseShortId(value: string): string | null {
  const sanitized = sanitizeShortId(value);
  return sanitized !== null && sanitized === value.toLowerCase()
    ? sanitized
    : null;
}
