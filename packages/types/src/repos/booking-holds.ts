import type { AgreementStatus } from "./agreements";
import type { PerformerOwnerType } from "./performer-profiles";

/**
 * BookingHold — a venue calendar hold on a booking request (booking-holds
 * spec 2026-08-25, FR-001). NOT the POS / PromoHold / ResaleListingHold
 * "hold" (short-TTL inventory reservation): this is a days-long lifecycle
 * that never blocks anything the public sees. Mirrors the Prisma
 * `BookingHoldStatus` enum as a string union so core never imports
 * `@prisma/client`.
 */
export type BookingHoldStatus =
  | "ACTIVE"
  | "CHALLENGED"
  | "CONFIRMED"
  | "RELEASED";

/** Statuses that occupy a slot in a line (position is meaningful). */
export const LIVE_BOOKING_HOLD_STATUSES = [
  "ACTIVE",
  "CHALLENGED",
] as const satisfies readonly BookingHoldStatus[];

/** Why a hold left its line. Mirrors the Prisma `BookingHoldReleaseReason` enum. */
export type BookingHoldReleaseReason =
  | "MANUAL"
  | "EXPIRED"
  | "CONFIRMED_OTHER"
  | "REQUEST_CLOSED"
  | "SIBLING_CONFIRMED"
  | "PAST_DATE"
  /** An event on the same calendar+date became PUBLISHED (FR-018). */
  | "EVENT_SCHEDULED"
  /**
   * The booked night was cancelled (booking-the-night FR-009). The ONE
   * reason a CONFIRMED hold is released; every other reason applies to live
   * holds only.
   */
  | "BOOKING_CANCELLED"
  /**
   * A BOOKER hold whose booking grant was revoked or expired
   * (holds-without-a-request FR-003 / FR-004). Only a BOOKER hold carries it.
   */
  | "GRANT_ENDED";

/** Who a hold belongs to (holds-without-a-request FR-001, H1 / H5 / H6). */
export type BookingHoldOwnerKind = "REQUEST" | "BOOKER" | "PLACE";

/**
 * The org or person a request-less hold names: a BOOKER hold's grantee, or
 * the party a PLACE hold was set aside for. Exactly one id, never both
 * (CHECK "BookingHold_owner_kind_shape").
 */
export type BookingHoldHolder =
  | { kind: "org"; orgId: string }
  | { kind: "person"; humanId: string };

/** Columns every hold has, whoever owns it. */
interface BookingHoldRecordBase {
  id: string;
  calendarId: string;
  /** Optional physical room; null after the room is deleted (SetNull). */
  spaceId: string | null;
  /**
   * Place-local calendar day as an ISO `YYYY-MM-DD` string — the DB column is
   * DATE (no time, no zone); the adapter formats the Prisma `Date` back to the
   * calendar day it was written as, so callers never see a UTC-midnight
   * `Date` that renders as the previous day west of Greenwich.
   */
  date: string;
  /**
   * 1-based within the LIVE line (ACTIVE | CHALLENGED) for calendarId+date.
   * RELEASED / CONFIRMED rows keep their last position for history.
   */
  position: number;
  status: BookingHoldStatus;
  /** Human who placed the hold. Plain id, no FK (house style). */
  placedByHumanId: string;
  challengedAt: Date | null;
  /** Keep-or-release deadline; non-null ONLY while CHALLENGED. */
  respondBy: Date | null;
  releasedAt: Date | null;
  releasedReason: BookingHoldReleaseReason | null;
  confirmedAt: Date | null;
  /**
   * The event a request-less hold was booked into (FR-008); null until then,
   * and on request holds (their event rides the request's agreement).
   * SetNull: deleting the event never deletes the hold.
   */
  eventId: string | null;
  /** One shared note (FR-012); see `NoteRecord` (@th/types/repos/notes). */
  note: string | null;
  noteUpdatedByHumanId: string | null;
  noteUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A hold placed for a booking request (every hold before 2026-09-30). */
export interface RequestBookingHoldRecord extends BookingHoldRecordBase {
  ownerKind: "REQUEST";
  bookingRequestId: string;
}

/**
 * An outside booker's hold for itself (H5): rides the booking grant, and the
 * holder is the grantee. No request, no thread (H20).
 */
export interface BookerBookingHoldRecord extends BookingHoldRecordBase {
  ownerKind: "BOOKER";
  grantId: string;
  holder: BookingHoldHolder;
  /**
   * The grant's end facts, read with the hold (the adapter joins the grant
   * row), so the lazy lapse can see a revoked or expired grant on every read
   * (FR-004: `isHoldLapsed` GRANT_ENDED) without a second query.
   */
  grantRevokedAt: Date | null;
  grantExpiresAt: Date | null;
}

/**
 * The place's own hold (H6): unassigned (`holder` null) or naming one party
 * on the platform. No request, no grant, no thread (H20).
 */
export interface PlaceBookingHoldRecord extends BookingHoldRecordBase {
  ownerKind: "PLACE";
  holder: BookingHoldHolder | null;
}

/**
 * BookingHold, discriminated on `ownerKind` (FR-001). Only a REQUEST hold
 * has a `bookingRequestId`, so every site that reads one must narrow first;
 * the other two kinds have no request, no thread and no request
 * notifications, and their history is the audit log (H20).
 */
export type BookingHoldRecord =
  | RequestBookingHoldRecord
  | BookerBookingHoldRecord
  | PlaceBookingHoldRecord;

/** Narrowing helper: the hold was placed for a booking request. */
export function isRequestBookingHold(
  hold: BookingHoldRecord,
): hold is RequestBookingHoldRecord {
  return hold.ownerKind === "REQUEST";
}

/** The hold's request id, or null for a request-less (BOOKER / PLACE) hold. */
export function bookingRequestIdOf(hold: BookingHoldRecord): string | null {
  return hold.ownerKind === "REQUEST" ? hold.bookingRequestId : null;
}

/**
 * A hold as seen by the REQUESTER — the org or human whose booking request
 * placed it (event-calendar-redesign FR-004). The plain record plus exactly
 * the venue-side context the requester may see: which venue, what the
 * request pitched, and the place zone the lapse predicate needs. Nothing
 * about the rest of the line — an act sees its own position only (booking-
 * holds FR-013).
 */
export interface RequesterBookingHoldRecord extends RequestBookingHoldRecord {
  /** Resolved through `Calendar.placeId` — holds carry no placeId of their own. */
  placeId: string;
  placeName: string;
  /** `Place.timezone` as stored (null when unset); core resolves the zone. */
  placeTimezone: string | null;
  /** The request's pitched act name, or null when the pitch carried none. */
  requestActName: string | null;
}

/**
 * Requester-side scope (FR-004). Both keys are REQUIRED and travel into the
 * SQL WHERE through the `BookingRequest` join — the tenant boundary is the
 * query itself, never a client-side filter. `statuses` widens the LIVE
 * default exactly like the other range reads.
 */
export interface ListBookingHoldsForRequesterInput {
  ownerType: PerformerOwnerType;
  ownerId: string;
  statuses?: readonly BookingHoldStatus[];
}

export interface CreateBookingHoldInput {
  bookingRequestId: string;
  calendarId: string;
  spaceId?: string | null;
  /** ISO `YYYY-MM-DD`, place-local. Validated in core (this is not a Date). */
  date: string;
  /** Resolved by the use case from the current line length + 1. */
  position: number;
  placedByHumanId: string;
}

/**
 * Insert a request-less hold (FR-005): a BOOKER hold on its grant, or a
 * PLACE hold, unassigned or naming one party. Same line rules as
 * `CreateBookingHoldInput` (position from the caller, the line's advisory
 * lock in the adapter). One LIVE hold per holder per line is the SQL-only
 * partial uniques "BookingHold_live_holder_org_line_key" /
 * "BookingHold_live_holder_human_line_key"; an unassigned PLACE hold is
 * never limited.
 */
export type CreateRequestlessBookingHoldInput = {
  calendarId: string;
  spaceId?: string | null;
  /** ISO `YYYY-MM-DD`, place-local. Validated in core (this is not a Date). */
  date: string;
  /** Resolved by the use case from the current line length + 1. */
  position: number;
  placedByHumanId: string;
  /**
   * Optional opening note (FR-011 "Hold this date … the optional note"),
   * already sanitized and length-checked by core. Stamped with
   * `placedByHumanId` and `now`.
   */
  note?: string | null;
  /** The use case's clock; stamps the opening note's `noteUpdatedAt`. */
  now: Date;
} & (
  | { ownerKind: "BOOKER"; grantId: string; holder: BookingHoldHolder }
  | { ownerKind: "PLACE"; holder: BookingHoldHolder | null }
);

/**
 * Guarded status transition. The write only lands when the row's current
 * status is one of `expectedFrom` (CAS via `updateMany` count, NFR-002); the
 * loser of a concurrent transition matches zero rows and the adapter throws
 * `{ code: "conflict", message: "booking_hold_status_changed" }` — same
 * contract as `AgreementsRepo.updateStatus` / `BookingRequestsRepo.updateStatus`.
 * Confirming a hold while ANOTHER hold in the same line is already CONFIRMED
 * trips the SQL-only partial unique "BookingHold_confirmed_line_key" →
 * `{ code: "conflict", message: "booking_hold_line_confirmed" }`.
 *
 * `respondBy` is TYPED to the status (discriminated union): REQUIRED when
 * the target is CHALLENGED, absent otherwise — the adapter writes NULL on
 * every non-CHALLENGED target, matching the biconditional DB CHECK
 * "BookingHold_respondBy_challenged_check" ((respondBy IS NULL) = (status <>
 * 'CHALLENGED')). Extending an open challenge is NOT an updateStatus — use
 * `setRespondBy`. The other state-coupled stamps are normalised the same way
 * unless explicitly provided: `confirmedAt` NULL when not CONFIRMED,
 * `releasedAt` / `releasedReason` NULL when not RELEASED.
 */
interface UpdateBookingHoldStatusBase {
  id: string;
  expectedFrom: readonly BookingHoldStatus[];
  challengedAt?: Date | null;
  releasedAt?: Date | null;
  releasedReason?: BookingHoldReleaseReason | null;
  confirmedAt?: Date | null;
}

export type UpdateBookingHoldStatusInput =
  | (UpdateBookingHoldStatusBase & {
      status: "CHALLENGED";
      /** Keep-or-release deadline; mandatory on the challenge transition. */
      respondBy: Date;
    })
  | (UpdateBookingHoldStatusBase & {
      status: Exclude<BookingHoldStatus, "CHALLENGED">;
      /** Not accepted: the adapter writes NULL (CHECK-enforced). */
      respondBy?: never;
    });

/**
 * Rewrite positions 1..n for a line, in the order given. `orderedIds` MUST be
 * exactly the set of LIVE holds (ACTIVE | CHALLENGED) for that calendar+date
 * — the adapter re-reads the line inside the caller's transaction and throws
 * `{ code: "conflict", message: "booking_hold_line_changed" }` if the sets
 * differ (an id outside the line, a missing live hold, or a duplicate), so
 * a stale reorder can never leave gaps or duplicates.
 *
 * MUST run inside `repos.tx()`: the adapter first takes the line's
 * transaction advisory lock (`pg_advisory_xact_lock`, shared with `create` —
 * row locks can't block an INSERT, so create-vs-renumber would otherwise
 * drift positions) and then `SELECT … FOR UPDATE` on the live rows, so two
 * concurrent renumbers (or a renumber racing a release) serialise instead of
 * interleaving their position writes. Outside a transaction both locks are
 * released the moment the statement ends and provide nothing.
 */
export interface RenumberBookingHoldLineInput {
  calendarId: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  orderedIds: readonly string[];
}

/**
 * Move the keep-or-release deadline (FR-005). Guarded on the row still being
 * CHALLENGED; zero rows → `{ code: "conflict", message:
 * "booking_hold_status_changed" }`. `expectedStatus` is the literal
 * "CHALLENGED" so a caller can't accidentally stamp a deadline on an ACTIVE
 * row (the invariant "respondBy non-null ⇔ CHALLENGED" lives here).
 */
export interface SetBookingHoldRespondByInput {
  id: string;
  respondBy: Date;
  expectedStatus: "CHALLENGED";
}

export interface BookingHoldLineKey {
  calendarId: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
}

export interface BookingHoldCalendarRangeInput {
  calendarId: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  from: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  to: string;
  /**
   * Widen past the LIVE default (ACTIVE | CHALLENGED) — same optional
   * widener `listLine` takes. Omitted = live only, so every existing caller
   * is unchanged. The admin calendar overlay passes CONFIRMED as well, so a
   * night already won by an act renders as taken instead of open.
   */
  statuses?: readonly BookingHoldStatus[];
}

export interface BookingHoldPlaceRangeInput {
  placeId: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  from: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  to: string;
  /**
   * Widen past the LIVE default (ACTIVE | CHALLENGED) — same optional
   * widener `listLine` takes. Omitted = live only, so every existing caller
   * is unchanged. The admin calendar overlay passes CONFIRMED as well, so a
   * night already won by an act renders as taken instead of open.
   */
  statuses?: readonly BookingHoldStatus[];
}

/**
 * The terms (Agreement) of the request that owns a hold, as far as the line
 * needs them (booking-the-night N6 / N20 / FR-015). Facts only: whether the
 * terms' `proposedDate` falls on the hold's night is a PLACE-LOCAL question
 * (`proposedDate` is an instant, the hold's `date` a calendar day), so core
 * answers it with the place's zone — the adapter never compares them.
 */
export interface BookingHoldLineTerms {
  agreementId: string;
  status: AgreementStatus;
  proposedDate: Date | null;
}

/**
 * One row of {@link BookingHoldsRepo.listLineWithTerms}: the hold as stored,
 * plus its request's terms. `terms` is null when the request has no
 * agreement (or, once holds without a request exist, when the hold has no
 * request at all — docs/specs/2026-09-30/holds-without-a-request.spec.yaml).
 */
export type BookingHoldLineEntry = BookingHoldRecord & {
  terms: BookingHoldLineTerms | null;
};

/**
 * Revoking a booking grant (holds-without-a-request FR-003 / H15): a hold the
 * place KEEPS becomes the place's own hold naming the booker. CAS on the row
 * still being a LIVE (ACTIVE | CHALLENGED) BOOKER hold riding `grantId`; the
 * write flips `ownerKind` to PLACE and clears `grantId`, keeping the holder,
 * position, status, challenge and note (the CHECK "BookingHold_owner_kind_shape"
 * requires a PLACE hold to carry no grant). The holder partial uniques span
 * both kinds, so the flip can never collide with them.
 */
export interface ConvertBookerHoldToPlaceInput {
  id: string;
  /** The grant being revoked; a hold riding another grant is not touched. */
  grantId: string;
}

/**
 * A named party passes (holds-without-a-request FR-007 / H7): the PLACE hold's
 * holder columns clear, and it stays the place's, unassigned, at the same
 * position. CAS on the row still being a LIVE PLACE hold naming exactly
 * `holder`; a lost CAS (passed already, released, renamed) writes nothing.
 */
export interface ClearPlaceHoldHolderInput {
  id: string;
  holder: BookingHoldHolder;
}
