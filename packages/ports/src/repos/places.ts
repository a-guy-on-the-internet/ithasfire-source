import type {
  BulkCreatePlaceInput,
  ListAccessiblePlacesByHumanInput,
  ListAccessiblePlacesSort,
  ListAccessiblePlacesSortField,
  ListAccessiblePlacesStatusFilter,
  ListAllPlacesInput,
  ListOwnedPlacesBySubjectInput,
  ListWithheldOwnedNearPointInput,
  PlaceListItemRecord,
  PlaceRecord,
  PlaceSitemapEntryRecord,
  PlaceStatus,
  PlaceVerificationStatus,
  PlaceWebsiteSource,
  PlaceOwnerInput,
  PlaceAddressInput,
  PlaceGeoInput,
  UpsertPlaceInput,
} from "@th/types/repos/places";

import type {
  CreateProvisionalOwnershipInput,
  CreateVerifiedOwnershipInput,
  PlaceOwnershipRecord,
  RevokeOwnershipInput,
  VerifyOwnershipInput,
} from "@th/types/repos/place-verification";

import type {
  OffsetPaginatedResult,
  OffsetPaginationInput,
} from "../pagination";

/**
 * The owner switch columns {@link PlacesRepo.setFlag} may write. Closed on
 * purpose: each is a plain boolean on `Place` that no search document
 * carries, so a flip needs no reindex.
 */
export type PlaceFlag =
  | "acceptsBookingRequests"
  | "attendeeReviewsPublic"
  | "communityReviewsEnabled";

export interface PlacesRepo {
  getById(id: string): Promise<PlaceRecord | null>;
  /**
   * {@link PlacesRepo.getById} for many ids in ONE query: id → record, ids with
   * no row absent. For listing pages that need each event's venue (tax situs,
   * cached rate) without one point read per venue.
   */
  getByIds(ids: readonly string[]): Promise<Map<string, PlaceRecord>>;
  upsert(input: UpsertPlaceInput): Promise<PlaceRecord>;
  /**
   * Writes ONLY `status` (every other column untouched) and returns the row.
   * For a status change with no other edit: the community-moderator archive
   * and restore. Throws when the place does not exist.
   */
  setStatus(input: {
    placeId: string;
    status: PlaceRecord["status"];
  }): Promise<PlaceRecord>;
  /**
   * Compare-and-set of `status` ONLY (every other column untouched): writes
   * `to` only while the row still holds `from`. `changed` is false when the
   * status moved since the caller's read (or the row does not exist). For the
   * owner archive / restore / suspend: a whole-row rebuild from a read would
   * overwrite a concurrent name/address edit and rewrite a NULL street line or
   * country as "" / "US".
   */
  compareAndSetStatus(input: {
    placeId: string;
    from: PlaceRecord["status"];
    to: PlaceRecord["status"];
  }): Promise<{ changed: boolean }>;
  /**
   * Compare-and-set of `listedInDirectory` ONLY (every other column
   * untouched): writes `listedInDirectory` only while the row holds the
   * opposite value. `changed` is true when this call flipped it; false when
   * the row already held it (or does not exist). For the staff directory
   * toggles: a whole-row rebuild from a read taken before the transaction
   * would overwrite a moderator's concurrent name/address/pin edit, and the
   * CAS result (not that read) says whether the flag actually moved.
   */
  setDirectoryListing(input: {
    placeId: string;
    listedInDirectory: boolean;
  }): Promise<{ changed: boolean }>;
  /**
   * Compare-and-set of `verification` ONLY: writes `to` only while the row
   * still holds `from`. `changed` is false when the status moved since the
   * caller's read (or the row does not exist). Same reason as
   * {@link PlacesRepo.setDirectoryListing}.
   */
  setVerificationStatus(input: {
    placeId: string;
    from: PlaceVerificationStatus;
    to: PlaceVerificationStatus;
  }): Promise<{ changed: boolean }>;
  /**
   * Compare-and-set of ONE owner switch column (every other column
   * untouched): writes `value` only while the row holds `!value`. `changed`
   * is true when this call flipped it; false when the row already held
   * `value` (or does not exist). For the owner toggles
   * (`setPlaceBookingAcceptance`, `setPlaceAttendeeReviewsPublic`,
   * `setPlaceCommunityReviewsEnabled`): a whole-row upsert from an earlier
   * read would undo a moderator's concurrent name/address edit and rewrite a
   * NULL street line or country as "".
   */
  setFlag(input: {
    placeId: string;
    flag: PlaceFlag;
    value: boolean;
  }): Promise<{ changed: boolean }>;
  /**
   * Compare-and-set of `acceptsCommunityListings` ONLY (every other column,
   * phone / website / websiteSource included, untouched): writes `accepts`
   * only while the row holds `!accepts`, and with `requireVerified` only while
   * `verification` is VERIFIED too. `changed` is false when the row already
   * held `accepts`, failed `requireVerified`, or does not exist; the caller
   * re-reads to tell which.
   *
   * Not a {@link PlaceFlag}: no PLACE search document carries it, but every
   * COMMUNITY listing's EVENT document stamps the venue confirmation it
   * drives, so a caller that flips it owes those listings a reindex mark.
   * Callers: `setPlaceCommunityListingAcceptance` (owner switch) and
   * `reviewPlaceVerification` (the FR-006 consent reset on revocation).
   */
  setCommunityListingAcceptance(input: {
    placeId: string;
    accepts: boolean;
    requireVerified?: boolean;
  }): Promise<{ changed: boolean }>;
  listAccessibleByHuman(
    input: ListAccessiblePlacesByHumanInput,
  ): Promise<OffsetPaginatedResult<PlaceListItemRecord>>;
  /**
   * ACTIVE places OWNED by a subject (org or human), for actor-free callers.
   *
   * Why this exists alongside {@link PlacesRepo.listAccessibleByHuman}: that
   * one is ACTOR-centric (it requires a `humanId` and answers "what can this
   * signed-in person reach?", including globally-verified places they do NOT
   * own). The public embed widget read paths have NO actor and must answer a
   * different question — "which venues does this embed's subject own?" — so
   * they need an owner-keyed lookup.
   *
   * SECURITY: counts ONLY ownership rows that are `verified = true` AND
   * `revokedAt IS NULL` — the same predicate that gates edit access in
   * `toPlaceRecord`. A provisional (unverified) or soft-revoked claim confers
   * nothing here either; otherwise anyone could file a bogus claim on a rival
   * venue and pull that venue's public calendar onto their own website while
   * the claim sat unreviewed. Places are additionally constrained to
   * `status = ACTIVE`.
   *
   * Note the place's OWN `verificationStatus` is deliberately NOT required:
   * a self-created stub place is legitimately yours to list, and since events
   * are keyed to a specific `placeId`, a duplicate stub of a real venue
   * carries none of the real venue's events — so there is nothing to leak.
   *
   * Ordered by name ASC, id ASC (stable). Bounded by `limit`.
   */
  listOwnedBySubject(
    input: ListOwnedPlacesBySubjectInput,
  ): Promise<PlaceRecord[]>;
  /**
   * ACTIVE places that WITHHOLD their address (`locationMode <> EXACT`),
   * owned (verified, unrevoked) by `humanId` directly or by one of `orgIds`,
   * whose TRUE point lies inside a box of at least `withinMeters` around
   * (`lat`, `lng`). Candidates only: the caller measures the true distance
   * and has the final authorization word (`canManagePlace`).
   *
   * Backs the save path's "this freeform address is your own withheld
   * venue" check (place-address-withholding N2). OWNER-SCOPED IN SQL on
   * purpose: the lookup never considers anyone else's places, so its result
   * AND its timing say nothing to a stranger about whether a withheld venue
   * lies near a point they typed. Driven by `PlaceOwnership(ownerType,
   * ownerId)`; bounded by `limit`.
   */
  listWithheldOwnedNearPoint(
    input: ListWithheldOwnedNearPointInput,
  ): Promise<PlaceRecord[]>;
  listAll(
    input: ListAllPlacesInput,
  ): Promise<OffsetPaginatedResult<PlaceRecord>>;
  listForSearchIndex(
    input: OffsetPaginationInput,
  ): Promise<OffsetPaginatedResult<PlaceRecord>>;
  listForSitemap(input?: {
    limit?: number;
  }): Promise<PlaceSitemapEntryRecord[]>;
  /**
   * Counts public directory places. A directory place is
   * `Place.status = ACTIVE AND Place.listedInDirectory = true`; when a `near`
   * scope is given, additionally `lat`/`lng` are non-null and within
   * `radiusKm` of the point.
   */
  countDirectory(input?: {
    near?: { lat: number; lng: number; radiusKm: number };
  }): Promise<number>;

  deletePlace(placeId: string): Promise<void>;

  bulkCreate(places: BulkCreatePlaceInput[]): Promise<{ created: number }>;

  // ── Ownership (claim-venue flow) ────────────────────────────────────────────

  /**
   * The most recent NON-revoked, VERIFIED ownership for a place, if any.
   * A verified owner blocks an instant claim (FR-008 → dispute path).
   */
  getVerifiedOwnershipForPlace(
    placeId: string,
  ): Promise<PlaceOwnershipRecord | null>;
  /**
   * Take a transaction-scoped advisory lock keyed on a placeId. MUST be the
   * first lock taken inside a `repos.tx()` (after `lockClaimsByActor`, where a
   * path takes that) so concurrent claimants of the SAME place serialize;
   * the lock releases automatically when the surrounding transaction
   * commits/rolls back. No-op on backends without advisory locks;
   * the Postgres adapter uses `pg_advisory_xact_lock`. Used by the FR-010
   * fast-track to serialize concurrent auto-verify claims — co-ownership is
   * allowed, so a "one verified owner" unique index can't be used here — and
   * by the provisional claim path and the moderator edit / archive / restore.
   */
  lockPlaceForClaim(placeId: string): Promise<void>;
  /**
   * Transaction-scoped advisory lock keyed on the human FILING claims (the
   * actor, whatever owner they claim for). Serializes one person's concurrent
   * claim submissions so the anti-squatting cap's count
   * (`placeVerificationRequests.countOpenClaimsByClaimant`) and the new claim
   * commit as one step: two parallel submits at 19 cannot both pass. Take it
   * BEFORE `lockPlaceForClaim` (the one order every caller uses). No-op on
   * backends without advisory locks.
   */
  lockClaimsByActor(actorHumanId: string): Promise<void>;
  /**
   * ACTIVE places that PUBLISH their address (`locationMode = EXACT`) whose
   * name, normalized IN SQL, equals `normalizedName`. The SQL normal form is
   * `lower(btrim(regexp_replace(normalize(name, NFKC), '[[:space:]]+', ' ',
   * 'g')))`; callers build `normalizedName` with core's `normalizePlaceName`
   * (NFKC, lower-case, whitespace runs collapsed, trimmed), which agrees with
   * it for every name a person types. Withheld places are never returned, so
   * the result says nothing about where a house is. `excludePlaceId` drops
   * one row (an edit checking against everything but itself). Bounded by
   * `limit` (default 20, max 50), ordered by id.
   *
   * Backs the community-place duplicate guard.
   */
  findActiveExactByNormalizedName(input: {
    normalizedName: string;
    excludePlaceId?: string;
    limit?: number;
  }): Promise<PlaceRecord[]>;
  /**
   * Transaction-scoped advisory lock on a NORMALIZED place name
   * (`pg_advisory_xact_lock(hashtext('place_name:' || name))`). Call it
   * inside `repos.tx()` before the duplicate check, so two writes of the
   * same name serialize and the second sees the first's committed row.
   * Released at commit/rollback. The 32-bit hash can collide: usually that
   * only over-serializes, but it can close a lock cycle Postgres detects as
   * a deadlock, aborting one transaction with a retryable error (callers
   * release their idempotency claim, so a retry works).
   */
  lockPlaceName(normalizedName: string): Promise<void>;
  getOwnershipById(ownershipId: string): Promise<PlaceOwnershipRecord | null>;
  /**
   * ALL active (revokedAt IS NULL) ownership rows for a place — verified AND
   * provisional. Used by dispute resolution to revoke every contested owner
   * before installing the disputant.
   */
  listActiveOwnershipsForPlace(
    placeId: string,
  ): Promise<PlaceOwnershipRecord[]>;
  /**
   * Installs a VERIFIED ownership row in one motion (dispute-resolution
   * transfer). Reuses the (placeId, ownerType, ownerId) row when one exists
   * (e.g. a just-revoked prior claim by the same identity) — flips it back to
   * verified with fresh reviewer/proof rather than colliding on the unique key.
   */
  createVerifiedOwnership(
    input: CreateVerifiedOwnershipInput,
  ): Promise<PlaceOwnershipRecord>;
  /**
   * Creates a PROVISIONAL (verified=false) ownership row. Confers NO edit
   * access — access is gated on verified=true AND revokedAt IS NULL.
   */
  createProvisionalOwnership(
    input: CreateProvisionalOwnershipInput,
  ): Promise<PlaceOwnershipRecord>;
  /**
   * Reviewer stamp: flips a provisional ownership to verified=true. REFUSES
   * to un-revoke — throws a conflict when the row is missing or revokedAt is
   * set (a stale claim approval must never resurrect a row a dispute transfer
   * revoked). Callers should pre-check revokedAt for a friendly error.
   */
  verifyOwnership(input: VerifyOwnershipInput): Promise<PlaceOwnershipRecord>;
  /** Soft-revoke on reject: sets revokedAt (row kept for audit). */
  revokeOwnership(input: RevokeOwnershipInput): Promise<PlaceOwnershipRecord>;

  /**
   * Persist a tax rate lookup result on a place. Mirrors
   * SavedLocationsRepo.updateTaxRate.
   *
   * The all-null form CLEARS the cache. `upsertPlace` writes it, in the same
   * transaction as the address write, when the row's postcode or country
   * differs from what it held under the place-location lock and no rate for
   * the new postcode/country was cached — so a save never leaves the old
   * jurisdiction's rate beside a new postcode (owner ruling 2026-10-03). A
   * street-text edit that keeps the postcode and country keeps the rate. A
   * NULL cache is a miss — readers look the rate up again — not a 0% rate.
   * The three columns are set or cleared together, never mixed.
   */
  updateTaxRate(
    input: { id: string } & (
      | {
          admissionTaxRateBps: number;
          taxRateSource: string;
          taxRateFetchedAt: Date;
        }
      | {
          admissionTaxRateBps: null;
          taxRateSource: null;
          taxRateFetchedAt: null;
        }
    ),
  ): Promise<void>;

  /**
   * Cache a tax-rate lookup result ONLY when the place still has no cached
   * rate AND still sits at the postal code / country the lookup was made for
   * — a compare-and-set on `admissionTaxRateBps IS NULL AND postcode =
   * expectedPostalCode AND country = expectedCountryCode`. Resolves `true`
   * when it wrote.
   *
   * For a write that lands long after the read that triggered the lookup
   * (the checkout's after-commit cache write). What it protects: an address
   * edit committed in between (`upsertPlace` re-caches the NEW address's rate,
   * or leaves the cache empty when that lookup misses) is never overwritten
   * with the OLD address's rate. A skipped write only means the next reader
   * looks the rate up again.
   */
  fillTaxRateIfUnset(input: {
    id: string;
    expectedPostalCode: string | null;
    expectedCountryCode: string | null;
    admissionTaxRateBps: number;
    taxRateSource: string;
    taxRateFetchedAt: Date;
  }): Promise<boolean>;

  /**
   * Persist the address-derived IANA timezone on a place (venue-hierarchy
   * FR-004; same lookup-and-cache lifecycle as {@link updateTaxRate}). Callers
   * only invoke this with a NON-null timezone — a failed/unknown lookup keeps
   * the previously-derived value, so there is deliberately no way to null it
   * out through this method.
   */
  updateTimezone(input: { id: string; timezone: string }): Promise<void>;

  // NOTE: there is deliberately no slug surface here. `Place.slug` is
  // deprecated — a multi-segment DIRECTORY key that no route ever resolved.
  // A place is addressed by `placeId`, or publicly by its `EntityPage.slug`
  // (see `EntityPagesRepo.getBySlug` / `resolveSlugHistory`). Do not
  // reintroduce `getBySlug` / `getSlugContext` / `assignSlug` /
  // `recordSlugHistory` / `resolveBySlug` on this repo.
}

export type {
  BulkCreatePlaceInput,
  ListAccessiblePlacesByHumanInput,
  ListAccessiblePlacesSort,
  ListAccessiblePlacesSortField,
  ListAccessiblePlacesStatusFilter,
  ListAllPlacesInput,
  ListOwnedPlacesBySubjectInput,
  ListWithheldOwnedNearPointInput,
  PlaceListItemRecord,
  PlaceRecord,
  PlaceSitemapEntryRecord,
  PlaceStatus,
  PlaceVerificationStatus,
  PlaceWebsiteSource,
  PlaceOwnerInput,
  PlaceAddressInput,
  PlaceGeoInput,
  UpsertPlaceInput,
} from "@th/types/repos/places";
