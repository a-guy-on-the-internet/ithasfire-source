import type { PerformerOwnerRef } from "@th/types/repos/performer-profiles";
import type {
  PerformerBookingDefaultsRecord,
  UpsertPerformerBookingDefaultsInput,
} from "@th/types/repos/performer-booking-defaults";

export interface PerformerBookingDefaultsRepo {
  /** The saved defaults for an owner, or null if none saved yet. */
  getByOwner(
    input: PerformerOwnerRef,
  ): Promise<PerformerBookingDefaultsRecord | null>;
  /**
   * Create-or-replace the saved defaults for an owner. Idempotent on the
   * (ownerType, ownerId) unique. Callers pass the FULL desired state; the
   * adapter overwrites every value column (null clears a field).
   */
  upsert(
    input: UpsertPerformerBookingDefaultsInput,
  ): Promise<PerformerBookingDefaultsRecord>;
}

// NOTE: `PerformerOwnerType`/`PerformerOwnerRef` are intentionally NOT
// re-exported here — they already ride the `export *` from
// `./performer-profiles`, and re-exporting them a second time would make the
// name ambiguous and drop it from the aggregate barrel.
export type {
  PerformerBookingDefaultsRecord,
  UpsertPerformerBookingDefaultsInput,
} from "@th/types/repos/performer-booking-defaults";
