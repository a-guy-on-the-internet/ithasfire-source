import type { PerformerOwnerType } from "./performer-profiles";
import type { BookingFeeType } from "./booking-requests";

/**
 * Saved default values for the booking-request pitch form (performer-mode.spec,
 * 2026-07-11). Keyed polymorphically by owner, exactly like PerformerProfile.
 *
 * Every field is nullable — a save can clear any field. Field parity with the
 * booking-request create input EXCEPT `genre`, which is intentionally NOT stored
 * here (it comes from Human.genreTags on the create path).
 */
export interface PerformerBookingDefaultsRecord {
  id: string;
  ownerType: PerformerOwnerType;
  ownerId: string;
  actName: string | null;
  lineupSize: number | null;
  setLengthMinutes: number | null;
  techNeeds: string | null;
  contactPhone: string | null;
  feeType: BookingFeeType | null;
  /** Integer cents, interpreted in `feeCurrency`. */
  feeAmountCents: number | null;
  /** ISO 4217 currency for `feeAmountCents` (platform base when an amount is set). */
  feeCurrency: string | null;
  messageTemplate: string | null;
  includeVerifiedStats: boolean | null;
  linkMusic: string | null;
  linkVideo: string | null;
  linkSocial: string | null;
  linkEpk: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Upsert input for the saved booking defaults. The owner ref identifies the row;
 * every value field is written as-supplied (null clears it). Callers pass the
 * FULL desired state — the adapter overwrites all value columns on update.
 */
export interface UpsertPerformerBookingDefaultsInput {
  ownerType: PerformerOwnerType;
  ownerId: string;
  actName: string | null;
  lineupSize: number | null;
  setLengthMinutes: number | null;
  techNeeds: string | null;
  contactPhone: string | null;
  feeType: BookingFeeType | null;
  feeAmountCents: number | null;
  feeCurrency: string | null;
  messageTemplate: string | null;
  includeVerifiedStats: boolean | null;
  linkMusic: string | null;
  linkVideo: string | null;
  linkSocial: string | null;
  linkEpk: string | null;
}
