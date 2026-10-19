/**
 * PlaceBookingGrant — the right to make events at a place (holds-without-a-
 * request spec 2026-09-30, H2 / H3 / H4, FR-002; first modelled by the
 * venue-confirmation-and-booking-intents spec, "Trust for regulars"). NOT an
 * org role: works for person- and org-owned places, scopes to the whole
 * place (`calendarId` null) or one calendar, never touches membership.
 *
 * It goes to an org or a person (`grantee`), is given pending and counts
 * only once the grantee accepts it. ACTIVE = accepted AND not declined AND
 * not revoked AND not expired (`expiresAt` null or after now).
 */

/** Who a grant was given to (H2): an org, or a person. */
export type PlaceBookingGrantee =
  | { kind: "org"; orgId: string }
  | { kind: "person"; humanId: string };

export interface PlaceBookingGrantRecord {
  id: string;
  placeId: string;
  /** Null = whole place; set = this calendar only. */
  calendarId: string | null;
  grantee: PlaceBookingGrantee;
  /** Staff human who gave the grant. Plain id. */
  grantedByHumanId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** Null = pending; nothing counts until the grantee accepts (H4). */
  acceptedAt: Date | null;
  /** Set when the grantee declined; never both with `acceptedAt` (CHECK). */
  declinedAt: Date | null;
  /** When the 7-days-before-expiry warning went out (FR-004); once. */
  expiryWarnedAt: Date | null;
  createdAt: Date;
}

/**
 * The actor-resolving lookup (FR-002): is there an ACTIVE grant at this
 * place, covering this calendar, under which the actor may act?
 *
 * The CALLER resolves who the actor acts for, and passes it in:
 *  - `humanIds`: the actor's own id, plus every person who made the actor
 *    their delegate (a person grant is used by "the person and their
 *    delegates", H2);
 *  - `orgIds`: the orgs where the actor holds an edit role (an org grant is
 *    used by "its edit-role members", H2).
 * The repo matches grantee IN those sets; it never decides membership. Both
 * empty matches nothing (no DB read).
 *
 * Scope: `calendarId` set = whole-place grants plus grants on that
 * calendar; null/omitted = a place-level action, whole-place grants only.
 * Among matches the whole-place grant wins, then the oldest.
 */
export interface FindActivePlaceBookingGrantForActorInput {
  placeId: string;
  calendarId?: string | null;
  humanIds: readonly string[];
  orgIds: readonly string[];
  now: Date;
}

/**
 * Give a grant (FR-003). Pending by default: `acceptedAt` is for fixtures,
 * seeds and backfills of a grant that is already accepted, never for the
 * give use case.
 */
export interface CreatePlaceBookingGrantInput {
  placeId: string;
  calendarId?: string | null;
  grantee: PlaceBookingGrantee;
  grantedByHumanId: string;
  expiresAt?: Date | null;
  acceptedAt?: Date | null;
}

/**
 * Accept or decline a pending grant (FR-003). Scoped to the grantee: the
 * CALLER resolves who may answer for the actor and passes it in, as for
 * `FindActivePlaceBookingGrantForActorInput` —
 *  - `humanIds`: the actor's own id (a person grant is answered by the person);
 *  - `orgIds`: the orgs where the actor may answer for the org (FR-003:
 *    owner/admin).
 * A grant whose grantee is in neither set reads exactly like a missing one,
 * `{ code: "not_found", message: "place_booking_grant_not_found" }`, and is
 * left unchanged; both sets empty → not_found with no write. CAS: lands only
 * while the grant is still pending (not accepted, not declined, not
 * revoked) and not past its expiry at `now`; the loser gets
 * `{ code: "conflict", message: "place_booking_grant_not_pending" }`.
 */
export interface RespondToPlaceBookingGrantInput {
  id: string;
  humanIds: readonly string[];
  orgIds: readonly string[];
  now: Date;
}

/**
 * The grantee side's single read (FR-003 respond): a grant by id, any state,
 * whose grantee is one of `humanIds` (person grant) or `orgIds` (org grant).
 * The sets are caller-resolved, as for `RespondToPlaceBookingGrantInput`; a
 * grant given to anyone else reads as null, exactly like a missing one. Both
 * empty → null with no read.
 */
export interface GetPlaceBookingGrantForGranteeInput {
  id: string;
  humanIds: readonly string[];
  orgIds: readonly string[];
}

/**
 * The staff side's single read (FR-003 edit / revoke preview): a grant by
 * id, any state, AT this place. Another place's grant id reads as null.
 */
export interface GetPlaceBookingGrantForPlaceInput {
  id: string;
  placeId: string;
}

/**
 * Edit a grant's scope or expiry (FR-003). Scoped to `placeId` (a grant id
 * from another place matches nothing) and to a LIVE grant: not revoked,
 * not declined, not expired at `now` (an edit racing expiry or a decline
 * must not revive or re-stamp the ended grant).
 * `undefined` leaves a field as is; `null` clears it (whole place / no
 * expiry). A `calendarId` that is not one of the place's calendars is
 * refused with `{ code: "grant_calendar_place_mismatch" }`, as on create.
 * Moving `expiresAt` clears `expiryWarnedAt`, so a new date earns a new
 * warning.
 */
export interface UpdatePlaceBookingGrantInput {
  id: string;
  placeId: string;
  /** The caller's clock: a grant whose expiry is at or before it is ended. */
  now: Date;
  calendarId?: string | null;
  expiresAt?: Date | null;
}

/** Revoke (FR-003). Scoped to `placeId`; CAS on `revokedAt IS NULL`. */
export interface RevokePlaceBookingGrantInput {
  id: string;
  placeId: string;
  now: Date;
}

/** The staff list (FR-003): every grant at the place, newest first. */
export interface ListPlaceBookingGrantsForPlaceInput {
  placeId: string;
  /** Include revoked and declined grants (history). Default false. */
  includeEnded?: boolean;
}

/**
 * The grantee's list (FR-014): grants given to any of these people or orgs
 * that are pending or active at `now` (not declined, not revoked, not
 * expired), newest first. The sets are caller-resolved, as for
 * `FindActivePlaceBookingGrantForActorInput`. Both empty → [].
 */
export interface ListPlaceBookingGrantsForGranteeInput {
  humanIds: readonly string[];
  orgIds: readonly string[];
  now: Date;
}

/**
 * The expiry job's read (FR-004): accepted, not revoked grants whose
 * `expiresAt` is set and at or before `expiresBefore`, soonest first.
 * `unwarnedOnly` keeps those whose 7-day warning has not gone out.
 */
export interface ListExpiringPlaceBookingGrantsInput {
  expiresBefore: Date;
  unwarnedOnly: boolean;
  limit: number;
}

/**
 * Stamp the expiry warning once: CAS on `expiryWarnedAt IS NULL` AND
 * `expiresAt` still equal to the date the job read. A grant whose expiry was
 * moved in between (which clears `expiryWarnedAt`) is not stamped, so the
 * warning for the old date never claims the new one.
 */
export interface MarkPlaceBookingGrantExpiryWarnedInput {
  id: string;
  /** The `expiresAt` the job read from `listExpiring`. */
  expiresAt: Date;
  now: Date;
}
