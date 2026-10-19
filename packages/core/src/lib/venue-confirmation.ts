import type { ReporterPort } from "@th/ports/reporter";
import type { PlacesRepo } from "@th/ports/repos/places";
import type {
  EventRecord,
  VenueConfirmedFor,
} from "@th/types/repos/events";
import type { EventLocationMode } from "@th/types/repos/events";
import type { PlaceRecord } from "@th/types/repos/places";

import {
  type PublicEventLocation,
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "./location/project-public-event-location";
import type { PlaceLocationSource } from "./location/redact-place-location";

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation — THE derivation (venue-confirmation-and-booking-intents
// spec, docs/specs/2026-08-27 "Confirmation lives on the Event").
//
// Trust is per event: the venue vouches for THIS event at THIS place. It is
// never a stored flag — `isVenueConfirmed` below is the ONLY place the rule
// lives, and every reader (public rendering: venue name + link vs
// address-only; blocking: availability + conflict detection; the search
// index's `venueId`) goes through it or through `venueConfirmedFilterFor`,
// which is the same predicate expressed for the events repo's SQL reads.
// Do not re-derive it inline anywhere else.
//
//   isVenueConfirmed =
//       (venueConfirmedAt != null AND venueConfirmationWithdrawnAt == null
//        AND venueConfirmedPlaceId == placeId)                    // stamp arm
//    OR the event's owner (orgId / humanId) is a verified, unrevoked owner
//       of the place ("confirmed by construction")                // owner arm
//    OR (stewardship == "COMMUNITY" AND place.acceptsCommunityListings
//        AND placeId != null AND placeId == place.id
//        AND venueConfirmationWithdrawnAt == null)                // community arm
//
// THE COMMUNITY ARM (community-listings-at-claimed-venues, FR-002): a
// COMMUNITY listing is OWNERLESS by DB constraint, so the owner arm can never
// hold for one, and an unclaimed venue has nobody to stamp — both sides of the
// relationship were ownerless and confirmation could never happen. The place
// flag is the venue's consent given ONCE for the venue instead of per event.
// Nothing is stamped, so toggling it retroactively confirms (and un-confirms)
// every community listing already attached to the place.
//
// WITHDRAWAL NEGATES THE STAMP ARM AND THE COMMUNITY ARM, NOT THE OWNER ARM
// (FR-003). `withdraw-venue-confirmation.ts` already REFUSES to withdraw a
// venue-owned event (`INVALID_STATUS: venue_owned_event`), and
// `describeVenueConfirmationState` documents venue-owned rows as confirmed by
// construction — so the owner arm is absolute and a stray withdrawal stamp on
// one cannot strip a venue of its own show. What withdrawal buys instead is
// exactly the spec's goal: an owner who accepts listings venue-wide can still
// reject ONE bad listing without flipping the venue flag off.
//
// THE STAMP IS BOUND TO THE PLACE IT WAS ISSUED FOR (security review H1):
// a vouch from venue A must not travel with the event when its organizer
// moves it to venue B. `venueConfirmedPlaceId` is written with the stamp; the
// stamp is live only while it equals the event's current `placeId`. Moving
// the event back to A revives it (the vouch was for A, and still is).
//
// Withdrawn and never-confirmed are indistinguishable to every reader (the
// spec: "unconfirmed and withdrawn render identically"). `placeId` is ALWAYS
// retained regardless.
//
// The `venueConfirmed*` columns are OPTIONAL on `EventRecord` (older
// projections omit them); `undefined` reads as `null` everywhere here.
//
// NO GRACE WINDOW: the spec's 14-day window for legacy third-party events is
// notification copy in the Phase 2 legacy-request script, not a rendering
// rule (orchestrator decision 2026-09-02 — prod is dark, there is nothing to
// grandfather).
// ─────────────────────────────────────────────────────────────────────────────

/** The event fields the derivation reads. */
export type VenueConfirmationEventFields = Pick<
  EventRecord,
  | "orgId"
  | "humanId"
  | "placeId"
  | "stewardship"
  | "venueConfirmedAt"
  | "venueConfirmationWithdrawnAt"
  | "venueConfirmedPlaceId"
>;

/**
 * The place fields the derivation reads: its verified, unrevoked owners (the
 * owner arm), plus its `id` and standing community consent (the community
 * arm). `id` is carried rather than inferred so the community arm can assert
 * `event.placeId === place.id` — the same "the vouch is for THIS place"
 * binding the stamp arm gets from `venueConfirmedPlaceId`.
 */
export type VenueConfirmationPlaceFields = Pick<
  PlaceRecord,
  "id" | "orgIdsWithAccess" | "humanIdsWithAccess" | "acceptsCommunityListings"
>;

/** Just the owner half — for helpers that classify ownership and nothing else. */
export type VenueConfirmationPlaceOwnerFields = Pick<
  VenueConfirmationPlaceFields,
  "orgIdsWithAccess" | "humanIdsWithAccess"
>;

/**
 * "Confirmed by construction": the event is owned by one of the place's
 * owners (an owning org, or a direct human owner). No stamp needed — the
 * venue cannot fail to vouch for its own show.
 */
export function isVenueOwnedEvent(
  event: Pick<VenueConfirmationEventFields, "orgId" | "humanId">,
  place: VenueConfirmationPlaceOwnerFields,
): boolean {
  const orgId = event.orgId ?? null;
  const humanId = event.humanId ?? null;
  // `?? []`: a row without the owner arrays (a partial projection) has no
  // owners we can see, which is the closed direction, rather than a throw.
  return (
    (orgId !== null && (place.orgIdsWithAccess ?? []).includes(orgId)) ||
    (humanId !== null && (place.humanIdsWithAccess ?? []).includes(humanId))
  );
}

/**
 * The stamp half of the rule: stamped, not withdrawn, and issued for the
 * place the event is CURRENTLY at (`venueConfirmedPlaceId === placeId`, both
 * non-null). A stamp for another place is not this venue's word.
 */
export function hasActiveVenueConfirmationStamp(
  event: Pick<
    VenueConfirmationEventFields,
    | "placeId"
    | "venueConfirmedAt"
    | "venueConfirmationWithdrawnAt"
    | "venueConfirmedPlaceId"
  >,
): boolean {
  const placeId = event.placeId ?? null;
  const stampedFor = event.venueConfirmedPlaceId ?? null;
  return (
    (event.venueConfirmedAt ?? null) !== null &&
    (event.venueConfirmationWithdrawnAt ?? null) === null &&
    placeId !== null &&
    stampedFor === placeId
  );
}

/**
 * The community half of the rule (FR-002): an OWNERLESS community listing at a
 * place whose owner has consented to community listings venue-wide.
 *
 * Four conditions, all load-bearing:
 *   · `stewardship === "COMMUNITY"` — an OWNED third-party event still needs a
 *     stamp; blanket consent is for the ownerless listings only;
 *   · `place.acceptsCommunityListings` — the consent itself, default false;
 *   · `placeId != null AND placeId === place.id` — the same place binding the
 *     stamp arm gets, so consent from venue A never travels to venue B;
 *   · `venueConfirmationWithdrawnAt == null` — FR-003: one bad listing can be
 *     rejected without switching the venue-wide flag off. (This is the arm
 *     withdrawal negates ALONGSIDE the stamp arm; see the module header for
 *     why the OWNER arm is deliberately exempt.)
 *
 * WHAT THIS ARM DOES **NOT** READ, and why that is a real asymmetry rather than
 * an oversight: `place.verificationStatus`. `setPlaceCommunityListingAcceptance`
 * refuses to turn the flag ON unless the place is VERIFIED, but that gate is on
 * GRANTING consent, not on HOLDING it. A place can fall below VERIFIED
 * afterwards — a rejected claim while a verified co-owner stands, a rejected
 * legacy ORG_SUBMISSION — and `review-place-verification`'s FR-006 reset fires
 * on OWNERSHIP revocation, not on verification demotion. So a live `true` can
 * outlive the verification that licensed it, and these listings keep rendering
 * and keep blocking. Folding `verificationStatus` in here would fix that and
 * introduce a worse failure: a venue whose verification lapses would silently
 * UNBLOCK nights its calendar genuinely has shows on. Left as-is deliberately;
 * the owner can always switch it off (disabling is never gated).
 *
 * WHAT ACTUALLY KEEPS THIS SAFE TODAY is not this predicate: a community
 * listing's `placeId` is written only by platform staff. Either
 * `community.createListing` / `community.updateListing` set it (both gated by
 * `requirePlatformStaff` with `COMMUNITY_MODERATION_ROLES`, i.e.
 * COMMUNITY_MODERATOR or ADMIN, on DRAFT and PUBLISHED listings), or the staff
 * backfill script does. It is NOT a public edit-suggestion field:
 * `update-community-listing` takes it out of the diff before
 * `parseSuggestionFields`, which rejects it on every public suggestion. So no
 * untrusted submitter can attach a listing to a venue, and per-listing
 * withdrawal remains the venue's remedy for a bad staff link. The name-only
 * display of an UNCONFIRMED link ({@link mayNameUnconfirmedVenue}) is the
 * owner's ruling B (2026-10-06) and rests on the same staff-only write.
 */
export function isAcceptedCommunityListing(
  event: Pick<
    VenueConfirmationEventFields,
    "placeId" | "stewardship" | "venueConfirmationWithdrawnAt"
  >,
  place: Pick<VenueConfirmationPlaceFields, "id" | "acceptsCommunityListings">,
): boolean {
  const placeId = event.placeId ?? null;
  return (
    event.stewardship === "COMMUNITY" &&
    place.acceptsCommunityListings === true &&
    placeId !== null &&
    placeId === place.id &&
    (event.venueConfirmationWithdrawnAt ?? null) === null
  );
}

/**
 * Whether the venue vouches for this event at this place. See the module
 * header — this is the one derivation, and it is a three-way OR over the three
 * named arms above. Nothing else may re-derive it.
 */
export function isVenueConfirmed(
  event: VenueConfirmationEventFields,
  place: VenueConfirmationPlaceFields,
): boolean {
  return (
    hasActiveVenueConfirmationStamp(event) ||
    isVenueOwnedEvent(event, place) ||
    isAcceptedCommunityListing(event, place)
  );
}

/** The extra place fields {@link mayNameUnconfirmedVenue} reads. */
export type VenueNamingPlaceFields = VenueConfirmationPlaceFields &
  Pick<PlaceRecord, "status" | "listedInDirectory">;

/**
 * Whether an UNCONFIRMED community listing may show its place's NAME as plain
 * text (owner ruling 2026-10-06, option B).
 *
 * This is a DISPLAY permission, separate from confirmation. It grants the name
 * and nothing else: no link to the venue page, no listing on the venue page,
 * no search `venueId`, no availability block, and `venueConfirmed` stays
 * false. {@link isVenueConfirmed} (and its SQL twin) are untouched by it,
 * because confirmation is what drives availability and blocking.
 *
 * All must hold:
 *   · `stewardship === "COMMUNITY"` and `placeId === place.id`;
 *   · NOT confirmed — a confirmed event takes the confirmed path (name + link),
 *     so this returns false there rather than double-granting;
 *   · not withdrawn — a venue that rejected the listing is not named on it;
 *   · `place.status === "ACTIVE"`;
 *   · NOT (owned AND `listedInDirectory === false`) — an owner's directory
 *     opt-out hides the name. An UNOWNED place's `false` is the bulk-import
 *     default nobody chose, so it does not. "Owned" is the owner arm's notion:
 *     a non-empty `orgIdsWithAccess` / `humanIdsWithAccess`.
 */
export function mayNameUnconfirmedVenue(
  event: VenueConfirmationEventFields,
  place: VenueNamingPlaceFields,
): boolean {
  const placeId = event.placeId ?? null;
  if (event.stewardship !== "COMMUNITY") return false;
  if (placeId === null || placeId !== place.id) return false;
  if (isVenueConfirmed(event, place)) return false;
  if ((event.venueConfirmationWithdrawnAt ?? null) !== null) return false;
  if (place.status !== "ACTIVE") return false;
  const owned =
    (place.orgIdsWithAccess ?? []).length > 0 ||
    (place.humanIdsWithAccess ?? []).length > 0;
  if (owned && place.listedInDirectory === false) return false;
  return true;
}

/**
 * The venue name a public CARD may print as its plain-text label.
 *
 * `displayPlaceName` as-is when the venue is confirmed. When it is NOT
 * confirmed (a name-only display from {@link mayNameUnconfirmedVenue}), the
 * name is printed only while the event's PUBLIC location is EXACT and not
 * hidden — the same branches where the event page and the search index name
 * the venue — so naming the venue never undoes an obscured or gated location.
 * `location` is the result of `projectPublicEventLocation` for the event.
 */
export function cardVenueName(
  displayPlaceName: string | null,
  venueConfirmed: boolean,
  location: Pick<PublicEventLocation, "mode" | "hidden">,
): string | null {
  if (displayPlaceName === null) return null;
  if (venueConfirmed) return displayPlaceName;
  return location.mode === "EXACT" && !location.hidden
    ? displayPlaceName
    : null;
}

/**
 * WHICH arm of {@link isVenueConfirmed} holds, for readers whose answer
 * depends on HOW the venue vouched rather than only WHETHER it did.
 *
 * The one such reader today is the holder-address gate
 * (`lib/location/resolve-holder-address.ts`). A venue that withholds its
 * address releases it to an event's ticket holders only when the venue
 * itself stands behind that event, and the arms are not equal for that:
 *   · `owner`     — the venue's own show; the event's reveal schedule applies;
 *   · `stamp`     — the venue explicitly confirmed THIS event; released, but
 *                   never earlier than a day before it starts;
 *   · `community` — blanket consent to ownerless listings; releases NOTHING,
 *                   because anyone could write the listing.
 *
 * PRECEDENCE is owner > stamp > community: the strongest vouch that holds
 * wins. (Owner and community cannot both hold — a COMMUNITY listing is
 * ownerless by DB constraint — but a stamped community listing reads as
 * `stamp`: the venue confirmed that listing by hand.)
 *
 * `place` null/undefined = the row is gone or was never read: nobody can
 * vouch through a venue we cannot see, so this returns null (unconfirmed)
 * even when the event carries a stamp. Same fail-closed posture as
 * `resolveVenueConfirmationByEvent`'s "gone" case.
 *
 * INVARIANT: `venueConfirmationArm(e, p) !== null` iff `isVenueConfirmed(e, p)`
 * for any readable place. `venue-confirmation.test.ts` pins that over a
 * corpus; change both or neither.
 */
export type VenueConfirmationArm = "owner" | "stamp" | "community";

export function venueConfirmationArm(
  event: VenueConfirmationEventFields,
  place: VenueConfirmationPlaceFields | null | undefined,
): VenueConfirmationArm | null {
  if (!place) return null;
  if (isVenueOwnedEvent(event, place)) return "owner";
  if (hasActiveVenueConfirmationStamp(event)) return "stamp";
  if (isAcceptedCommunityListing(event, place)) return "community";
  return null;
}

/** The venue's stance on ONE event, for the venue's own admin surfaces. */
export type VenueConfirmationState = "confirmed" | "withdrawn" | "unconfirmed";

/**
 * The admin-side reading of the rule: the same predicate as
 * {@link isVenueConfirmed}, plus the ONE distinction public readers must not
 * see — a withdrawn stamp reads `withdrawn`, not `unconfirmed`, because the
 * venue's own inbox has to say what it did. `ownerSide` says whose event it
 * is (venue-owned rows are confirmed by construction and refuse withdrawal).
 *
 * `owners === null` = the place row is gone: nobody owns a deleted place, so
 * only the stamp arm can hold. Unlike `resolveVenueConfirmedByEvent` this
 * does NOT strip the stamp — this is the venue's own admin, not a public
 * surface, and a stamp it issued is still its word.
 */
export function describeVenueConfirmationState(
  event: VenueConfirmationEventFields,
  owners: VenueConfirmationPlaceFields | null,
): { state: VenueConfirmationState; ownerSide: "place" | "requester" } {
  const venueOwned = owners !== null && isVenueOwnedEvent(event, owners);
  // The community arm rides here too, so the venue's own admin never reads
  // "unconfirmed" for a listing the public page is already showing at its
  // address. `owners === null` (the place row is gone) drops the arm — a
  // deleted venue consents to nothing.
  const communityAccepted =
    owners !== null && isAcceptedCommunityListing(event, owners);
  const state: VenueConfirmationState =
    venueOwned || hasActiveVenueConfirmationStamp(event) || communityAccepted
      ? "confirmed"
      : (event.venueConfirmationWithdrawnAt ?? null) !== null
        ? "withdrawn"
        : "unconfirmed";
  return { state, ownerSide: venueOwned ? "place" : "requester" };
}

/**
 * The `venueConfirmedFor` value for the events repo's place-scoped reads
 * (`listPublishedByPlace`, `listPublishedByPlaceIds`,
 * `listPublishedOccurrencesByPlace`, `listByCalendar`). The adapter's
 * predicate — `(venueConfirmedAt NOT NULL AND withdrawnAt NULL) OR orgId IN
 * orgIds OR humanId IN humanIds OR (COMMUNITY AND accepted AND not
 * withdrawn)` — is {@link isVenueConfirmed} in SQL, so a SQL read and a TS
 * derivation over the same rows always agree. That agreement is not a hope:
 * `packages/adapters/src/db/prisma/__tests__/venue-confirmed-parity.test.ts`
 * runs one fixture corpus through both. Copies the arrays so a caller cannot
 * mutate the place record through the filter.
 */
export function venueConfirmedFilterFor(
  place: VenueConfirmationPlaceFields,
): VenueConfirmedFor {
  return {
    orgIds: [...place.orgIdsWithAccess],
    humanIds: [...place.humanIdsWithAccess],
    acceptsCommunityListings: place.acceptsCommunityListings === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch derivation — ONE place read per distinct placeId, then the rule per
// event. Shared by the search indexer and the public performer-page
// derivation so the batching (and its swallow) lives in one place.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveVenueConfirmedDeps = {
  repos: { places: Pick<PlacesRepo, "getById"> };
  /**
   * Deliberate-swallow reporter (ReporterPort convention): a failed place
   * read degrades that place's events to NOT confirmed for this call instead
   * of failing the batch, and MUST be visible in Sentry — silently stripping
   * a venue from every event at a place is the failure this guards.
   */
  reportError?: ReporterPort;
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
};

/**
 * The "read THREW" degraded place: everything the derivation could have
 * learned from the row is UNKNOWN, so every arm that needs the row fails
 * CLOSED — no owners (the owner arm cannot hold) and no community consent
 * (the community arm cannot hold). Only the stamp arm, which reads the EVENT
 * alone, can still hold. Keyed per placeId because `id` is part of the shape
 * now: a shared frozen constant could not carry it, and a community arm
 * comparing against the wrong id would be worse than one that simply refuses.
 */
function degradedPlaceFields(placeId: string): VenueConfirmationPlaceFields {
  return {
    id: placeId,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
  };
}

/**
 * Per-event answer from {@link resolveVenueConfirmationByEvent}.
 *
 * `locationFloor` rides along because the caller has already paid for the
 * place read: an event at a venue that withholds its address inherits that
 * obscurity as a FLOOR, and a public projection needs the floor at the same
 * moment it needs the confirmation. Making it a second read would have
 * guaranteed some caller eventually skipped it.
 */
export interface VenueConfirmationResolution {
  confirmed: boolean;
  /** The place's name, ONLY when `confirmed`. Card readers use this. */
  placeName: string | null;
  /**
   * The name a public surface may DISPLAY: `placeName` when confirmed, or the
   * place's name when {@link mayNameUnconfirmedVenue} grants a name-only
   * display (owner ruling 2026-10-06). Never implies a link or a venue id —
   * readers that emit a venue id or link must keep gating on `confirmed`.
   */
  displayPlaceName: string | null;
  /**
   * The venue's address-privacy state, or null when the event has no place.
   * Feed it to `applyPlaceLocationFloor` — do NOT interpret it inline.
   *
   * FAILS CLOSED: a place row that is GONE or could not be READ resolves to
   * `{ OBSCURED, null }` (fully hidden), not to EXACT. A degraded index pass
   * that hides a venue too hard self-heals on the next pass; a published pin
   * does not un-publish.
   */
  locationFloor: {
    locationMode: EventLocationMode;
    locationRadiusMeters: number | null;
  } | null;
  /**
   * The venue's location-privacy fields, for `projectPublicEventLocation`'s
   * `place` option — the same read, so a public projection never needs a
   * second one. Null when the event has no place. FAILS CLOSED exactly like
   * `locationFloor`: a place row that is GONE or could not be READ resolves
   * to `unreadablePlaceLocation` (fully hidden).
   */
  placeLocation: PlaceLocationSource | null;
}

/**
 * `isVenueConfirmed` for a batch: places are read once per distinct
 * `placeId` (never per event). Two degraded cases, deliberately different:
 *   · the place row is GONE (`getById` → null): the event is NOT confirmed,
 *     stamp or not — a deleted venue cannot vouch, and a public surface must
 *     not emit a dead venue id;
 *   · the read THREW: the place presumably exists but could not be read this
 *     call — owners AND community consent are unknown, so both of those arms
 *     fail closed ({@link degradedPlaceFields}) and only the stamp arm can
 *     hold, and the failure is reported. A transient DB error must not strip
 *     a valid stamp from every event at the place.
 * Returns a map keyed by event id.
 */
export async function resolveVenueConfirmationByEvent(
  deps: ResolveVenueConfirmedDeps,
  events: ReadonlyArray<VenueConfirmationEventFields & { id: string }>,
  options: { useCase: string } = { useCase: "resolveVenueConfirmedByEvent" },
): Promise<Map<string, VenueConfirmationResolution>> {
  const placeIds = [
    ...new Set(
      events.map((e) => e.placeId).filter((id): id is string => id != null),
    ),
  ];
  /** Owners per place; `"gone"` = the row does not exist. */
  const owners = new Map<string, VenueConfirmationPlaceFields | "gone">();
  /** Display name per place, for callers allowed to NAME a confirmed venue. */
  const names = new Map<string, string | null>();
  /**
   * Address-privacy floor per place. FAIL-CLOSED default — every placeId is
   * seeded fully-hidden and only an actually-read EXACT row relaxes it, so a
   * `getById` that throws or returns null cannot hand a caller an EXACT floor.
   */
  const floors = new Map<
    string,
    { locationMode: EventLocationMode; locationRadiusMeters: number | null }
  >();
  /** Location-privacy fields per place — absent (→ fail closed) unless READ. */
  const placeLocations = new Map<string, PlaceLocationSource>();
  /**
   * The naming-gate fields per place — present only when the row was READ, so
   * a degraded or gone place can never grant a name-only display.
   */
  const namingFields = new Map<
    string,
    Pick<PlaceRecord, "status" | "listedInDirectory">
  >();
  await Promise.all(
    placeIds.map(async (placeId) => {
      let place: PlaceRecord | null = null;
      let readFailed = false;
      try {
        place = await deps.repos.places.getById(placeId);
      } catch (err) {
        readFailed = true;
        deps.logger?.error("venue_confirmation.place_read_failed", {
          placeId,
          err,
        });
        try {
          deps.reportError?.(err, {
            tags: { useCase: options.useCase, step: "resolveVenueConfirmedByEvent" },
            extra: { placeId },
          });
        } catch {
          // A throwing reporter must never change behaviour.
        }
      }
      names.set(placeId, place ? (place.name ?? null) : null);
      if (place) placeLocations.set(placeId, toPlaceLocationSource(place));
      if (place) {
        namingFields.set(placeId, {
          status: place.status,
          listedInDirectory: place.listedInDirectory,
        });
      }
      floors.set(
        placeId,
        place && place.locationMode === "EXACT"
          ? { locationMode: "EXACT", locationRadiusMeters: null }
          : {
              locationMode: "OBSCURED",
              locationRadiusMeters: place?.locationRadiusMeters ?? null,
            },
      );
      owners.set(
        placeId,
        place
          ? {
              id: place.id,
              orgIdsWithAccess: place.orgIdsWithAccess ?? [],
              humanIdsWithAccess: place.humanIdsWithAccess ?? [],
              acceptsCommunityListings:
                place.acceptsCommunityListings === true,
            }
          : readFailed
            ? degradedPlaceFields(placeId)
            : "gone",
      );
    }),
  );
  return new Map<string, VenueConfirmationResolution>(
    events.map((e): readonly [string, VenueConfirmationResolution] => {
      if (e.placeId == null) {
        return [
          e.id,
          {
            confirmed: false,
            placeName: null,
            displayPlaceName: null,
            locationFloor: null,
            placeLocation: null,
          },
        ] as const;
      }
      const place = owners.get(e.placeId) ?? "gone";
      const confirmed = place === "gone" ? false : isVenueConfirmed(e, place);
      // The name rides the SAME gate as the flag. A caller that is not allowed
      // to say the venue confirmed the event is not allowed to name it either
      // — see build-search-index's `venueName` line and the venue-confirmation
      // spec (docs/specs/2026-08-27).
      const placeName = confirmed ? (names.get(e.placeId) ?? null) : null;
      // `displayPlaceName` adds the name-only arm (owner ruling 2026-10-06):
      // a separate display permission that never touches `confirmed`.
      const naming = place === "gone" ? undefined : namingFields.get(e.placeId);
      const displayPlaceName = confirmed
        ? placeName
        : place !== "gone" &&
            naming !== undefined &&
            mayNameUnconfirmedVenue(e, { ...place, ...naming })
          ? (names.get(e.placeId) ?? null)
          : null;
      return [
        e.id,
        {
          confirmed,
          placeName,
          displayPlaceName,
          // Fail-closed default for a placeId that never made it into `floors`
          // (impossible today — every distinct id is seeded above — but the
          // default must be the private one, not EXACT).
          locationFloor: floors.get(e.placeId) ?? {
            locationMode: "OBSCURED",
            locationRadiusMeters: null,
          },
          placeLocation:
            placeLocations.get(e.placeId) ?? unreadablePlaceLocation(e.placeId),
        },
      ] as const;
    }),
  );
}

/**
 * Boolean-only view of {@link resolveVenueConfirmationByEvent}, kept because
 * most callers only need the flag. One place read per distinct placeId either
 * way — this does not re-read.
 */
export async function resolveVenueConfirmedByEvent(
  deps: ResolveVenueConfirmedDeps,
  events: ReadonlyArray<VenueConfirmationEventFields & { id: string }>,
  options: { useCase: string } = { useCase: "resolveVenueConfirmedByEvent" },
): Promise<Map<string, boolean>> {
  const resolved = await resolveVenueConfirmationByEvent(deps, events, options);
  return new Map([...resolved].map(([id, v]) => [id, v.confirmed] as const));
}
