import type { BookingIntent } from "./booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// Booking standards (venue-booking-standards spec, docs/specs/2026-09-25).
//
// What a venue expects in a pitch, per intent: an ordered checklist of items
// plus up to three example pitches. Owned by a CALENDAR or a PLACE (D1); the
// platform defaults are code constants in core, never rows. Resolution lives
// in `packages/core/src/use-cases/booking-standards/`.
// ─────────────────────────────────────────────────────────────────────────────

/** Who authored the rows (D1). Mirrors the Prisma enum. */
export type BookingStandardOwnerType = "PLACE" | "CALENDAR";

/**
 * The pitch field an item points at (FR-001). Every member but CUSTOM is a
 * field the request form has and the server can check; CUSTOM is a free-text
 * line, guidance only (D2a). Mirrors the Prisma enum.
 */
export type BookingStandardField =
  | "MESSAGE"
  | "PREFERRED_DATES"
  | "EXPECTED_DRAW"
  | "GENRE"
  | "LINEUP_SIZE"
  | "SET_LENGTH"
  | "TECH_NEEDS"
  | "FEE"
  | "LINK_MUSIC"
  | "LINK_VIDEO"
  | "LINK_SOCIAL"
  | "LINK_EPK"
  | "BILL"
  | "PURPOSE"
  | "EXPECTED_ATTENDANCE"
  | "REQUESTED_WINDOW"
  | "CUSTOM";

/** D2: REQUIRED blocks submit; SUGGESTED is a prompt. */
export type BookingStandardRequirement = "REQUIRED" | "SUGGESTED";

/** The polymorphic owner key — a Place id or a Calendar id. */
export interface BookingStandardOwnerKey {
  ownerType: BookingStandardOwnerType;
  ownerId: string;
}

export interface BookingStandardItemRecord extends BookingStandardOwnerKey {
  id: string;
  intent: BookingIntent;
  field: BookingStandardField;
  /** The venue's wording. Plain text (sanitized in core before the write). */
  label: string;
  hint: string | null;
  requirement: BookingStandardRequirement;
  /** 0..n-1 within one (owner, intent) — writes are replace-all. */
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingPitchExampleRecord extends BookingStandardOwnerKey {
  id: string;
  intent: BookingIntent;
  title: string;
  /** Plain multi-line text (sanitized in core before the write). */
  body: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One item to write. Order in the array IS the display order — the adapter
 * stamps `sortOrder` 0..n-1 from the index, so no caller can leave gaps or
 * ties. Validation (caps, which fields may be REQUIRED, field applies to the
 * intent, sanitizing) is core's; the SQL CHECK backstops D2a (CUSTOM) only.
 */
export interface BookingStandardItemInput {
  field: BookingStandardField;
  label: string;
  hint?: string | null;
  requirement: BookingStandardRequirement;
}

/** One example to write. Array order is display order (see above). */
export interface BookingPitchExampleInput {
  title: string;
  body: string;
}

/** Scope of one read: any mix of place and calendar owners, one call. */
export interface ListBookingStandardsForOwnersInput {
  owners: readonly BookingStandardOwnerKey[];
  /** Omitted = every intent (the options read resolves all intents at once). */
  intent?: BookingIntent;
}

/**
 * Both tables for the requested owners. Each list is ordered by
 * (ownerType, ownerId, intent, sortOrder, id).
 */
export interface BookingStandardsForOwners {
  items: BookingStandardItemRecord[];
  examples: BookingPitchExampleRecord[];
}

/**
 * Replace-all for one (owner, intent): after the call that owner+intent holds
 * EXACTLY `items`, in order. `[]` clears it (the owner falls back to the next
 * level: calendar → place → platform).
 */
export interface ReplaceBookingStandardItemsInput extends BookingStandardOwnerKey {
  intent: BookingIntent;
  items: readonly BookingStandardItemInput[];
}

/** Replace-all for one (owner, intent)'s examples — same contract as above. */
export interface ReplaceBookingPitchExamplesInput extends BookingStandardOwnerKey {
  intent: BookingIntent;
  examples: readonly BookingPitchExampleInput[];
}
