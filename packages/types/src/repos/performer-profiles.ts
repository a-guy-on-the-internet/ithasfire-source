/**
 * Polymorphic performer owner — mirrors the Agreement proposer/counterparty
 * party convention ("human" | "organization", app-enforced).
 */
export type PerformerOwnerType = "human" | "organization";

export interface PerformerOwnerRef {
  ownerType: PerformerOwnerType;
  ownerId: string;
}

/**
 * The performer-mode opt-in row. Enabled means
 * `enabledAt != null && disabledAt == null` — use `isPerformerEnabled` in
 * `@th/core/lib/performer-mode` rather than re-deriving this.
 */
export interface PerformerProfileRecord {
  id: string;
  ownerType: PerformerOwnerType;
  ownerId: string;
  enabledAt: Date | null;
  disabledAt: Date | null;
  /**
   * Opt-in GATE (not content — the profile stays content-free) for receiving
   * organizer→performer booking requests (organizer-booking-requests FR-002).
   * Only meaningful while performer mode is enabled; gate on
   * `isPerformerEnabled(profile) && profile.acceptsBookingRequests`.
   */
  acceptsBookingRequests: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPerformerEnabledInput {
  ownerType: PerformerOwnerType;
  ownerId: string;
  enabled: boolean;
  now: Date;
}

/**
 * Flip the organizer-booking-request acceptance gate on an EXISTING profile.
 * The adapter throws `{ code: "not_found", message: "performer_profile_not_found" }`
 * when no profile row exists — the use case gates enabling on performer mode
 * first, so a missing row only ever surfaces on a race.
 */
export interface SetPerformerAcceptsBookingRequestsInput {
  ownerType: PerformerOwnerType;
  ownerId: string;
  accepts: boolean;
}
