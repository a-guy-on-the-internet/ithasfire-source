import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { EntitySummary } from "@th/types/repos/entity-pages";
import { fail } from "@th/errors";
import { HUMAN_JOB_VALUES, isHumanJob } from "../../lib/human-jobs";
import { redactPlaceLocation } from "../../lib/location/redact-place-location";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { resolvePlaceClaimState } from "../places/get-place-claim-eligibility";

/**
 * THE single answer to "what is this entity" for an entity page.
 *
 * Both the public render (`get-public-page`) and the owner's editor
 * (`get-my-page`) resolve their entity through {@link loadEntitySummary} and
 * validate it with {@link entitySummarySchema}. That is the whole point of this
 * module: the editor's live preview renders the same block components as the
 * public page, and those components branch on the entity (`entity.type ===
 * "PLACE"` picks the venue booking CTA, `placeAcceptsBookingRequests` gates the
 * request-to-book buttons, …). When the editor fabricated its own summary the
 * two surfaces disagreed — the preview showed the artist CTA and disabled
 * booking buttons for a VERIFIED, booking-accepting venue. Do NOT fork this:
 * a second entity builder re-creates that whole bug class.
 */

// ── Schema ─────────────────────────────────────────────────────────────────

/**
 * Wire shape of the entity summary. Deliberately narrower than the
 * {@link EntitySummary} type: PLACE's `attendeeReviewsPublic` and
 * `communityReviewsEnabled` are NOT listed, so zod strips both from every
 * parsed output. They are internal gates consumed server-side (the
 * `audience_stats` and `venue_stats` derivations) and never shipped to a client.
 */
export const entitySummarySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("HUMAN"),
    id: z.string(),
    name: z.string().nullable(),
    /** Self-declared industry jobs (HumanJob enum values, e.g. MUSICIAN). */
    jobs: z.array(z.enum(HUMAN_JOB_VALUES)).default([]),
    /** Genre tags (relevant when MUSICIAN is in jobs). */
    genreTags: z.array(z.string()).default([]),
    /** Free-text description when OTHER is in jobs. */
    otherJobDescription: z.string().nullable().default(null),
    /**
     * True only when performer-enabled AND accepting organizer booking
     * requests (organizer-booking-requests FR-009) — gates the public
     * "Request to book" CTA via `performerAcceptsBookingRequests`.
     */
    acceptsBookingRequests: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("ORGANIZATION"),
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    trustTier: z.string(),
    trustBadgeLabel: z.string().nullable(),
    /** As on HUMAN — the org-act variant of the FR-009 CTA gate. */
    acceptsBookingRequests: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("PLACE"),
    id: z.string(),
    name: z.string(),
    // NOTE: no `slug`. A PLACE is addressed by `id`, or publicly by the
    // `EntityPage.slug` the caller already holds (this summary hangs off a
    // page). The old `Place.slug` was a multi-segment directory key nothing
    // routed on, and it is deprecated.
    /**
     * ALREADY REDACTED (`redactPlaceLocation`) — null whenever the venue
     * withholds its address. See the loader below for why this module redacts
     * unconditionally rather than per viewer.
     */
    formattedAddress: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    /**
     * True pin for an EXACT venue, obfuscated circle centre for an OBSCURED
     * one with a radius, null when fully hidden. NEVER the raw `Place.lat`.
     */
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    capacity: z.number().int().nullable().optional(),
    /**
     * NULL whenever the venue withholds its address. A home venue's number is
     * very often a personal line, and a reverse phone lookup returns the
     * street the venue chose not to publish. The owner still reads and edits
     * it through `getPlaceForEdit`.
     */
    phone: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    acceptsBookingRequests: z.boolean().optional(),
    verified: z.boolean().optional(),
    /**
     * True when `getPlaceClaimEligibility` would answer `claimable` (same
     * helper, `resolvePlaceClaimState`). The server-rendered hint for the hero
     * "Claim this place" chip until the client query answers.
     */
    claimable: z.boolean().optional(),
    /** False = the address is withheld; render the area, not a street. */
    locationIsExact: z.boolean().optional(),
    /** True = fully hidden: no map, no coordinates, area label only. */
    locationHidden: z.boolean().optional(),
    /** Obfuscation circle radius in metres; null unless a circle is drawn. */
    locationRadiusMeters: z.number().nullable().optional(),
    /** Coarse area label — the only place string a withheld venue publishes. */
    areaLabel: z.string().nullable().optional(),
  }),
]);

// ── Deps ───────────────────────────────────────────────────────────────────

export type LoadEntitySummaryDeps = {
  repos: Pick<
    Repos,
    | "humans"
    | "organizations"
    | "places"
    // Performer booking-acceptance gate for HUMAN/ORG summaries (FR-009).
    | "performerProfiles"
    // Availability-onboarding FR-005: PLACE acceptance folds in "has hours".
    | "calendars"
    // PLACE `claimable` hint: the shared claim-state helper reads active claims.
    | "placeVerificationRequests"
  >;
};

// ── Loader ─────────────────────────────────────────────────────────────────

/**
 * Resolves the canonical summary for an entity page's owner.
 *
 * Returns `null` when the owner row itself is absent. That is a data-absence
 * answer, NOT a swallowed failure: nothing is caught here, so a repo that
 * throws still propagates and lands on the caller's error path (and Sentry's
 * backstop). Each caller applies its own missing-row policy — the public page
 * 404s (`OWNER_NOT_FOUND`), the owner's editor renders without an entity rather
 * than bricking on a data-integrity anomaly the owner cannot fix.
 *
 * An unrecognised `ownerType` still THROWS: that is a code/enum defect, not a
 * missing row, and it must not be silently rendered as "no entity".
 *
 * Query cost: 2 for HUMAN/ORGANIZATION (owner row + performer profile);
 * for PLACE, the place row plus the claim-state reads (verified owner, then
 * the active claim only for an unverified place) and the availability count
 * only when the booking toggle is on. Callers should run it concurrently with their other reads.
 */
export async function loadEntitySummary(
  deps: LoadEntitySummaryDeps,
  ownerType: string,
  ownerId: string,
): Promise<EntitySummary | null> {
  switch (ownerType) {
    case "HUMAN": {
      const human = await deps.repos.humans.getById(ownerId);
      if (!human) return null;
      return {
        type: "HUMAN",
        id: human.id,
        name: human.name,
        // Whitelist against the known HumanJob values so a future enum drift
        // (new Prisma value not yet in HUMAN_JOB_VALUES) can never fail the
        // whole-page output parse — the unknown job is dropped, not fatal.
        jobs: (human.jobs ?? []).filter(isHumanJob),
        genreTags: human.genreTags ?? [],
        otherJobDescription: human.otherJobDescription ?? null,
        acceptsBookingRequests: await resolvePerformerAcceptance(
          deps,
          "human",
          human.id,
        ),
      };
    }
    case "ORGANIZATION": {
      const org = await deps.repos.organizations.getById(ownerId);
      if (!org) return null;
      return {
        type: "ORGANIZATION",
        id: org.id,
        name: org.name,
        slug: org.slug,
        trustTier: org.trustTier,
        trustBadgeLabel: org.trustBadgeLabel,
        acceptsBookingRequests: await resolvePerformerAcceptance(
          deps,
          "organization",
          org.id,
        ),
      };
    }
    case "PLACE": {
      const place = await deps.repos.places.getById(ownerId);
      if (!place) return null;
      // ADDRESS PRIVACY — redacted UNCONDITIONALLY, with no viewer unlock.
      //
      // That is not an oversight, it is this module's whole contract: the
      // owner's editor preview renders the SAME summary the public page does,
      // precisely so the two cannot disagree. A viewer-dependent address here
      // would reintroduce the disagreement the module exists to prevent — and
      // in the direction that matters least (the owner already sees and edits
      // the real address through `getPlaceForEdit`) at the cost of the one
      // that matters most (a leak).
      //
      // Practical upside: the owner of a withheld venue sees, in their own
      // preview, exactly what a stranger sees. For someone hiding their house,
      // that is the only trustworthy confirmation the setting worked.
      const location = redactPlaceLocation(place);
      return {
        type: "PLACE",
        id: place.id,
        name: place.name,
        formattedAddress: location.formattedAddress,
        city: location.city,
        region: location.region,
        lat: location.lat,
        lng: location.lng,
        locationIsExact: location.isExact,
        locationHidden: location.hidden,
        locationRadiusMeters: location.radiusMeters,
        areaLabel: location.areaLabel,
        capacity: place.capacity,
        // Withheld with the address — a phone number reverse-looks-up to one.
        phone: location.isExact ? place.phone : null,
        website: place.website,
        // Availability-onboarding FR-005 (docs/specs/2026-08-31): a place
        // with ZERO CalendarAvailability rows has never stated hours, so its
        // public projection reads as NOT accepting — the booking CTA/form the
        // flag gates would be a dead end (every date computes `closed`).
        // Folded HERE, in the shared loader, so the public page and the
        // editor preview cannot disagree (the module's whole point), and the
        // create mutations refuse the same venues (`createBookingRequest` /
        // `createBookingInquiry`, `booking_requests_unconfigured`) so button
        // and mutation cannot drift. Short-circuited: the count only runs for
        // a venue whose toggle is ON, and this loader serves single-entity
        // page reads (get-public-page / get-my-page) — never list rows.
        acceptsBookingRequests:
          place.acceptsBookingRequests &&
          (await deps.repos.calendars.countAvailabilityForPlace(place.id)) > 0,
        // Consumers only need a boolean — never expose PENDING/REJECTED.
        verified: place.verificationStatus === "VERIFIED",
        // `!verified` is NOT "claimable": a place with a verified owner, a
        // PENDING status or a claim in review is none of those things. Same
        // helper as `getPlaceClaimEligibility`, so the hero chip's server
        // render matches what the client query will say. Not caught: a failed
        // read fails the page load like every other read here.
        claimable:
          (await resolvePlaceClaimState(deps, place)).state === "claimable",
        // FR-005 opt-in: gates the audience_stats aggregate. Server-internal —
        // `entitySummarySchema` strips it before the payload leaves core.
        attendeeReviewsPublic: place.attendeeReviewsPublic,
        // FR-003 (2026-09-24): gates the performer venue_stats block. Same
        // server-internal treatment — the schema strips it.
        communityReviewsEnabled: place.communityReviewsEnabled,
      };
    }
    default:
      throw fail("UNKNOWN_OWNER_TYPE", { category: "NOT_FOUND" });
  }
}

/**
 * Booking CTA gate (organizer-booking-requests FR-009): true only when the
 * entity is performer-enabled AND opted in to receiving organizer booking
 * requests — the same double gate `createOrganizerBookingRequest` enforces,
 * so a rendered button can never invite a request the create path rejects.
 */
async function resolvePerformerAcceptance(
  deps: LoadEntitySummaryDeps,
  ownerType: "human" | "organization",
  ownerId: string,
): Promise<boolean> {
  const profile = await deps.repos.performerProfiles.getByOwner({
    ownerType,
    ownerId,
  });
  return isPerformerEnabled(profile) && profile?.acceptsBookingRequests === true;
}
