import type {
  CreatePlaceBookingGrantInput,
  FindActivePlaceBookingGrantForActorInput,
  GetPlaceBookingGrantForGranteeInput,
  GetPlaceBookingGrantForPlaceInput,
  ListExpiringPlaceBookingGrantsInput,
  ListPlaceBookingGrantsForGranteeInput,
  ListPlaceBookingGrantsForPlaceInput,
  MarkPlaceBookingGrantExpiryWarnedInput,
  PlaceBookingGrantRecord,
  RespondToPlaceBookingGrantInput,
  RevokePlaceBookingGrantInput,
  UpdatePlaceBookingGrantInput,
} from "@th/types/repos/place-booking-grants";

/**
 * Per-place booking grants (holds-without-a-request spec 2026-09-30, FR-002
 * / FR-003 / FR-004). A grant goes to an org or a person, is given pending,
 * and counts only once accepted. ACTIVE = accepted AND not declined AND not
 * revoked AND not expired; every "active" read below applies all four in
 * the WHERE.
 *
 * NO METHOD DECIDES WHO MAY ACT. Reads take the people / orgs the caller
 * already resolved for the actor, writes take a place id they are scoped
 * to; core gates (place owner / owning-org OWNER|ADMIN to give, edit and
 * revoke; the grantee to answer) before calling.
 */
export interface PlaceBookingGrantsRepo {
  /**
   * The ACTIVE grant at the place, in scope for the calendar, whose grantee
   * is one of `humanIds` (person grant) or `orgIds` (org grant), or null —
   * see {@link FindActivePlaceBookingGrantForActorInput}. Whole-place first,
   * then oldest.
   */
  findActiveForActor(
    input: FindActivePlaceBookingGrantForActorInput,
  ): Promise<PlaceBookingGrantRecord | null>;
  /**
   * EVERY active grant `findActiveForActor` would choose from, in the same
   * order (whole-place first, then oldest): same input, same match. The
   * booker gate's `listPlaceBookerGrants` reads it so a caller can match a
   * hold's holder or offer a choice of party.
   */
  listActiveForActor(
    input: FindActivePlaceBookingGrantForActorInput,
  ): Promise<PlaceBookingGrantRecord[]>;
  /**
   * A grant by id, any state, at `placeId`; null for another place's grant.
   * See {@link GetPlaceBookingGrantForPlaceInput}. The grantee side reads
   * through `listForGrantee` and answers through the scoped accept/decline.
   */
  getForPlace(
    input: GetPlaceBookingGrantForPlaceInput,
  ): Promise<PlaceBookingGrantRecord | null>;
  /**
   * A grant by id, any state, whose grantee is in the caller-resolved sets;
   * null for anyone else's grant. See
   * {@link GetPlaceBookingGrantForGranteeInput}. The respond use case reads
   * it to answer idempotently and to refuse an expired pending grant.
   */
  getForGrantee(
    input: GetPlaceBookingGrantForGranteeInput,
  ): Promise<PlaceBookingGrantRecord | null>;
  /**
   * {@link getForPlace} under a `SELECT … FOR SHARE` row lock, held until the
   * surrounding transaction ends (holds-without-a-request step 6, trap m).
   * A BOOKER placement takes it BEFORE any line lock and re-checks the grant
   * on the row it returns: revoke and update write the row (a FOR NO KEY
   * UPDATE lock), so they wait for the placement to commit, and a placement
   * that comes after them reads the revoked / rescoped row. The hold's FK
   * takes only KEY SHARE, which does not conflict with those writes, so
   * without this a placement could commit a hold on a grant revoked under it.
   * Null for a missing grant or another place's. MUST be called on the tx
   * client inside `repos.tx()`.
   *
   * LOCK ORDER: the place's grant-set lock, then this, then line locks.
   */
  lockSharedAtPlace(
    input: GetPlaceBookingGrantForPlaceInput,
  ): Promise<PlaceBookingGrantRecord | null>;
  /**
   * Give a grant (pending unless `acceptedAt` is passed — fixtures only).
   * Dual-writes the deprecated `humanId` column for a person grantee until
   * the contract migration. A `calendarId` that is not one of `placeId`'s
   * calendars → `{ code: "grant_calendar_place_mismatch" }`.
   */
  create(input: CreatePlaceBookingGrantInput): Promise<PlaceBookingGrantRecord>;
  /**
   * Take the place's GRANT-SET lock: a transaction advisory lock
   * (`pg_advisory_xact_lock(hashtext('place_booking_grants:' || placeId))`),
   * released at commit / rollback. Only serializes when called on the tx
   * repos. Give (and an edit that moves a grant's calendar) takes it before
   * re-reading the place's grants, so two racing gives cannot both pass the
   * idempotency / overlap check and write two live grants.
   *
   * LOCK ORDER: this lock, then a grant row, then line locks; never after.
   */
  lockPlace(placeId: string): Promise<void>;
  /** Pending → accepted. See {@link RespondToPlaceBookingGrantInput}. */
  accept(input: RespondToPlaceBookingGrantInput): Promise<PlaceBookingGrantRecord>;
  /** Pending → declined. See {@link RespondToPlaceBookingGrantInput}. */
  decline(input: RespondToPlaceBookingGrantInput): Promise<PlaceBookingGrantRecord>;
  /**
   * Edit scope / expiry. Null when no live (unrevoked, undeclined, unexpired)
   * grant with that id exists at `placeId`. See {@link UpdatePlaceBookingGrantInput}.
   */
  update(input: UpdatePlaceBookingGrantInput): Promise<PlaceBookingGrantRecord | null>;
  /**
   * Stamp `revokedAt`. Null when no unrevoked grant with that id exists at
   * `placeId` (already revoked, or another place's grant). Holds riding the
   * grant are the revoke use case's job, in the same transaction.
   */
  revoke(input: RevokePlaceBookingGrantInput): Promise<PlaceBookingGrantRecord | null>;
  /** The staff list. See {@link ListPlaceBookingGrantsForPlaceInput}. */
  listForPlace(
    input: ListPlaceBookingGrantsForPlaceInput,
  ): Promise<PlaceBookingGrantRecord[]>;
  /** The grantee's list. See {@link ListPlaceBookingGrantsForGranteeInput}. */
  listForGrantee(
    input: ListPlaceBookingGrantsForGranteeInput,
  ): Promise<PlaceBookingGrantRecord[]>;
  /** The expiry job's read. See {@link ListExpiringPlaceBookingGrantsInput}. */
  listExpiring(
    input: ListExpiringPlaceBookingGrantsInput,
  ): Promise<PlaceBookingGrantRecord[]>;
  /**
   * Stamp the expiry warning. False when it was already stamped (another
   * run won), so the job sends the warning only on true.
   */
  markExpiryWarned(input: MarkPlaceBookingGrantExpiryWarnedInput): Promise<boolean>;
}

export type {
  CreatePlaceBookingGrantInput,
  FindActivePlaceBookingGrantForActorInput,
  GetPlaceBookingGrantForGranteeInput,
  GetPlaceBookingGrantForPlaceInput,
  ListExpiringPlaceBookingGrantsInput,
  ListPlaceBookingGrantsForGranteeInput,
  ListPlaceBookingGrantsForPlaceInput,
  MarkPlaceBookingGrantExpiryWarnedInput,
  PlaceBookingGrantee,
  PlaceBookingGrantRecord,
  RespondToPlaceBookingGrantInput,
  RevokePlaceBookingGrantInput,
  UpdatePlaceBookingGrantInput,
} from "@th/types/repos/place-booking-grants";
