import type {
  PerformerOwnerRef,
  PerformerProfileRecord,
  SetPerformerAcceptsBookingRequestsInput,
  UpsertPerformerEnabledInput,
} from "@th/types/repos/performer-profiles";

export interface PerformerProfilesRepo {
  getByOwner(input: PerformerOwnerRef): Promise<PerformerProfileRecord | null>;
  /**
   * Enable / disable performer mode for an owner, creating the profile row on
   * first enable. Idempotent: enabling an already-enabled profile (or
   * disabling an already-disabled one) is a no-op that returns the same row.
   */
  upsertEnabled(
    input: UpsertPerformerEnabledInput,
  ): Promise<PerformerProfileRecord>;
  /**
   * Flip the organizer-booking-request acceptance GATE
   * (organizer-booking-requests FR-002) on an existing profile. Idempotent
   * at the value level; throws `{ code: "not_found", message:
   * "performer_profile_not_found" }` when the profile row doesn't exist.
   */
  setAcceptsBookingRequests(
    input: SetPerformerAcceptsBookingRequestsInput,
  ): Promise<PerformerProfileRecord>;
}

export type {
  PerformerOwnerRef,
  PerformerOwnerType,
  PerformerProfileRecord,
  SetPerformerAcceptsBookingRequestsInput,
  UpsertPerformerEnabledInput,
} from "@th/types/repos/performer-profiles";
