// ─────────────────────────────────────────────────────────────────────────────
// Booking-request constants
//
// Leaf module with an EMPTY import graph (no zod / no sanitize-html). The web
// booking form imports these values into a client bundle on the public
// `/p/[slug]` page, so they must be reachable without dragging the use-case
// schema graph (and its `sanitize-html` transitive dep) along. Keep this file
// dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed set-length presets (minutes). The create schema enforces membership;
 * the UI renders these as the picker options. Keep the two in sync via this
 * single exported source.
 */
export const BOOKING_SET_LENGTH_PRESETS = [
  15, 30, 45, 60, 90, 120,
] as const satisfies readonly number[];

/** Milliseconds per day — shared by the booking-request TTL stamping paths. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Fee ask amounts are capped at $100k (10_000_000 cents). */
export const BOOKING_FEE_AMOUNT_MAX_CENTS = 100_000_00;

/**
 * Invite-to-claim tokens (booking-request-embed-button FR-007) expire this
 * many days after issue/rotation. Deliberately generous (vs. the 14-day
 * request TTL) — the request is already ACCEPTED; the link only attaches an
 * identity.
 */
export const CLAIM_TOKEN_TTL_DAYS = 30;

/**
 * Triage-tag bounds (venue-hierarchy FR-008). The create schema sanitizes
 * each tag BEFORE enforcing the length cap; empties are dropped, not
 * rejected. Exported from this leaf so the tag input UI can share them.
 */
export const BOOKING_TAG_MAX_LENGTH = 40;
export const BOOKING_TAG_MAX_COUNT = 20;

/**
 * Venue-level currency is not modeled (no `Place.currency`), so the fee ask
 * amount is stored with the platform base currency snapshotted at create time.
 * The stored `feeCurrency` makes `feeAmountCents` self-describing for the UI and
 * future-proofs a later per-venue currency without a data migration.
 */
export const BOOKING_FEE_DEFAULT_CURRENCY = "usd";
