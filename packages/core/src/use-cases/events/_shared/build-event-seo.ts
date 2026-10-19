import type { EventsRepo } from "@th/ports/repos/events";
import type { EventRecord, EventHumanRecord } from "@th/types";

import { projectPublicEventLocation } from "../../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../../lib/location/redact-place-location";
import {
  holderRevealSchedule,
  resolveHolderAddress,
} from "../../../lib/location/resolve-holder-address";
import type { VenueConfirmationArm } from "../../../lib/venue-confirmation";
import { resolveListingPriceCents } from "../../../lib/pricing/pay-what-you-want";
import type { GetEventSeoOutput } from "../get-event-seo";
import type { BuyerTicketPricingEstimateResult } from "./estimate-buyer-ticket-pricing";
import { offersValidFrom } from "./offers-valid-from";

type BuildEventSeoInput = {
  event: EventRecord;
  ticketTypes: Awaited<ReturnType<EventsRepo["listTicketTypes"]>>;
  /**
   * Evaluation instant from the caller's injected ClockPort (FR-003).
   * REQUIRED: `offers.price` in the emitted JSON-LD is a public, machine-read
   * price claim that Google surfaces directly in results. A stale low price
   * there is a search engine advertising a price nobody can buy — the same
   * quote-one-charge-another failure R-001 describes, on the surface with the
   * widest reach. This stays a pure function; it never reads a clock itself.
   */
  now: Date;
  eventHumans: EventHumanRecord[];
  callerIsTicketHolder?: boolean;
  /**
   * Whether the signed-in viewer holds a live RSVP for this event
   * (`viewerHoldsLiveRsvp`). An RSVP-er gets the street exactly like a
   * ticket holder (arrival-areas owner ruling Q16, 2026-10-17: "like
   * holders"): `resolveHolderAddress`'s `activeHolder`, so the same reveal
   * timing and place gates. Never sets `viewerHasTicket`. Defaults to false.
   */
  callerHoldsLiveRsvp?: boolean;
  /**
   * Whether the signed-in viewer is an ACT ON THE BILL of this event
   * (arrival-areas FR-009): computed by the caller with `isActOnBill` from
   * the event's lineup rows. Fed to `resolveHolderAddress`'s `actOnBill`, so
   * an act sees the exact address on their own view of the event page under
   * the same place gates a holder does. Defaults to false.
   */
  callerIsActOnBill?: boolean;
  buyerPricing?: Pick<
    BuyerTicketPricingEstimateResult,
    "minBuyerUnitTotalCents" | "maxBuyerUnitTotalCents"
  >;
  /**
   * The Place linked via `event.placeId`, when one exists. Only surfaced
   * downstream as `location.placeSlug` + `location.name` when the location
   * is in its exact/revealed state (see redaction branches below) AND the
   * place is confirmed and directory-listed — or, for `location.name` only,
   * when `nameOnlyDisplay` grants an unconfirmed community listing its
   * venue's name as plain text (owner ruling 2026-10-06; never a slug, never
   * an endorsement). An org's private/unlisted venue has no
   * public page to link to, and a hidden/approximate event must not leak a
   * click-through (or a recognizable venue name) that reveals the exact
   * address via the venue directory.
   */
  place?: {
    /**
     * The place's `EntityPage.slug` — the ONLY identifier `/places/[slug]`
     * resolves on, and therefore the only value that may be emitted as
     * `location.placeSlug`.
     *
     * Deliberately NOT `Place.slug`: that was a multi-segment DIRECTORY key
     * (`us/tn/backstage--a1b2c3d4e5`, literal `/` included), and
     * `/places/[slug]` is a single non-catch-all segment resolving on the
     * ENTITY PAGE column. Passing `Place.slug` here put a dead link on every
     * public event page, crawler-visible; the seed scripts happened to make
     * the two slugs identical locally, which is what hid it. That column is
     * now deprecated and unminted. Null when the venue has no entity page —
     * the caller must not substitute anything.
     */
    pageSlug: string | null;
    name?: string | null;
    listedInDirectory: boolean;
    /**
     * Venue-confirmation spec (docs/specs/2026-08-27): whether the venue
     * vouches for this event at this place — `isVenueConfirmed(event, place)`
     * (venue-owned, or stamped and not withdrawn), computed by the caller.
     * When false the event renders ADDRESS-ONLY: no `placeSlug` and no venue
     * `name` (the address fields are untouched — the location is still real,
     * it just is not the venue's word) — EXCEPT that `nameOnlyDisplay` below
     * may add the name as plain text, which still implies no endorsement.
     * Unconfirmed and withdrawn are indistinguishable here by design.
     */
    venueConfirmed: boolean;
    /**
     * Owner ruling 2026-10-06 (option B): `mayNameUnconfirmedVenue(event,
     * place)`, computed by the caller. When true and `venueConfirmed` is
     * false, the place's `name` renders as PLAIN TEXT — never `placeSlug`,
     * and `venueConfirmed` stays false. Absent = false. The hidden and
     * approximate location branches still emit no name.
     */
    nameOnlyDisplay?: boolean;
    /**
     * HOW the venue vouched (`venueConfirmationArm(event, place)`), computed
     * by the caller from the same place row. The holder reveal reads it: a
     * venue that withholds its address releases it only for its own show
     * (`owner`) or one it confirmed (`stamp`, not before a day ahead), never
     * for a community listing or an unconfirmed claim. Absent = unconfirmed
     * (fail closed).
     */
    venueConfirmationArm?: VenueConfirmationArm | null;
    /**
     * The VENUE's own address privacy (place-address-withholding). Fed to
     * `projectPublicEventLocation` below (which floors the event by it) so an
     * event at a withheld venue renders withheld — read-time, against the
     * venue's CURRENT state.
     *
     * `save-event-shared` already clamps on write, so a correctly-saved event
     * needs nothing here. What needs it is the event that was published while
     * the venue was still public: flipping the venue to hidden must take that
     * event with it IMMEDIATELY, not on its next save. For a house that has
     * just decided it needs to disappear, "on next save" is not an answer.
     *
     * OPTIONAL only so pre-existing callers/fakes compile; absent means "no
     * venue constraint", which is correct for an event with no place. Callers
     * that HAVE a place must pass it — `getEventSeo` does.
     */
    locationMode?: "EXACT" | "OBSCURED" | string | null;
    locationRadiusMeters?: number | null;
    /**
     * The venue's full location-privacy row (id, mode, radius, label,
     * coordinates, address). When the venue withholds its address, the
     * anonymous view is the VENUE's keyed circle (the event row is not
     * trusted for position — see `projectPublicEventLocation`), and a
     * ticket holder's reveal reads the venue's address, because the event
     * row at a withheld venue stores only the public projection.
     *
     * Absent → built from the two flat fields above, with no id or
     * coordinates: a withheld venue then renders fully hidden (fail closed).
     */
    location?: PlaceLocationSource | null;
  } | null;
  /**
   * The Organization linked via `event.orgId`, when one exists. Feeds the
   * plain "Presented by {name}" attribution badge on the public event page,
   * and is ALSO the source of the schema.org JSON-LD `organizer`: the web
   * app builds `{ "@type": "Organization", name, url: <site>/orgs/<slug> }`
   * from `organizerName`/`organizerSlug` at its JSON-LD sink
   * (`apps/web/src/server/event-json-ld-enrichment.ts`), because only the
   * web app knows its own absolute site URL. This compiler therefore leaves
   * the `organizer` output field null; it does not learn the site URL.
   * No org (an ownerless COMMUNITY listing) means no organizer anywhere.
   */
  org?: { name: string; slug: string } | null;
};

/**
 * `addressRevealAt` for the public payload: when this event's holders get the
 * address, from the SAME schedule `resolveHolderAddress` enforces. An event
 * with nothing withheld keeps its column as before; NEVER, a venue that could
 * not be read, and a withheld venue that has not vouched for the event
 * promise no date.
 */
function publicRevealAtIso(
  event: EventRecord,
  place: BuildEventSeoInput["place"],
): string | null {
  const schedule = holderRevealSchedule({
    event,
    place: place
      ? (place.location ?? {
          locationMode: place.locationMode ?? undefined,
          locationRadiusMeters: place.locationRadiusMeters ?? null,
        })
      : null,
    venueConfirmationArm: place?.venueConfirmationArm ?? null,
  });
  switch (schedule.kind) {
    case "open":
      return event.addressRevealAt ? event.addressRevealAt.toISOString() : null;
    case "scheduled":
      return schedule.revealAt ? schedule.revealAt.toISOString() : null;
    default:
      return null;
  }
}

// Pure “SEO compiler” for event pages.
//
// Keep this free of framework/runtime dependencies (no Next/React) so BOTH:
// - API transport (tRPC)
// - SSR metadata generation
// can share consistent rules for titles/descriptions/image selection.
//
// For now this matches the existing behavior (minimal public payload), but putting
// it behind a compiler makes it easy to evolve formatting rules without touching
// the IO/use-case plumbing.
export function buildEventSeo({
  event,
  ticketTypes,
  eventHumans,
  callerIsTicketHolder = false,
  callerHoldsLiveRsvp = false,
  callerIsActOnBill = false,
  buyerPricing,
  place,
  org,
  now,
}: BuildEventSeoInput): GetEventSeoOutput {
  const prices = ticketTypes
    // PWYW at its floor, not its stored $0 (see `resolveListingPriceCents`).
    .map((t) => resolveListingPriceCents(t, now))
    .filter((p): p is number => typeof p === "number");
  const minPrice = prices.length > 0 ? Math.min(...prices) : undefined;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : undefined;
  const salesValidFrom = offersValidFrom(event, ticketTypes);

  // Include hero image when available so the public event page renders it.
  const images: string[] = [];
  if (event.heroImageUrl) {
    images.push(event.heroImageUrl);
  }
  // The size of `images[0]`, so the page can reserve the poster's box. Tied to
  // the url: a hero the moderation gate hid (url nulled) exposes no size.
  const heroImageSize = event.heroImageUrl
    ? (event.heroImageSize ?? null)
    : null;

  // Build location, redacting coordinates based on locationMode.
  // Public viewers stay redacted; ticket holders can see the exact address once
  // the reveal time has passed.
  const hasLocation = Boolean(event.placeId || event.addressText);
  let location: GetEventSeoOutput["location"] = null;
  // Whether a PER-VIEWER rule (a holder's reveal, an act on the bill) is
  // what released the exact address below. Never true for an address that
  // is public anyway: the viewer half of the page keys on it.
  let viewerAddressReleased = false;

  // Public venue attribution, shared by both exact/revealed branches below.
  //
  // TWO gates, deliberately NOT the same one:
  //
  //   NAME — directory-listed AND venue-confirmed. This is the disclosure
  //     decision, and it is the only one the venue-confirmation spec is about:
  //     an org's private/unlisted venue is not named, and neither is a claim
  //     the venue has not vouched for (address-only until confirmed). ONE
  //     exception: `nameOnlyDisplay` (owner ruling 2026-10-06, option B) lets
  //     an unconfirmed community listing name its venue as plain text. That
  //     grants the name ONLY: no link, `venueConfirmed` false, no endorsement.
  //
  //   LINK — the name's gate PLUS a usable public page slug. This is a
  //     REACHABILITY decision and nothing more.
  //
  // They were briefly folded together, which cost the name whenever the link
  // was missing. That is backwards: the venue name is public directory data
  // that was never the broken part, while `/places/[slug]` resolves ONLY on
  // the entity-page slug. Folding them meant a confirmed, directory-listed,
  // bulk-imported venue — the population that has no EntityPage and no
  // backfill — silently lost its name AND its schema.org `location.name`,
  // having previously rendered the name with a dead link beside it.
  //
  // So: a page-less venue renders "At The Basement East" as plain text. A
  // reachable one renders it as a link. Neither ever falls back to
  // `Place.slug` — that is a directory key, not a URL.
  const venueConfirmed = place?.venueConfirmed === true;
  const venueIsPublic = venueConfirmed && place?.listedInDirectory === true;
  // Name-only display (owner ruling 2026-10-06): an unconfirmed community
  // listing may NAME its venue as plain text. It never feeds the slug below
  // and never touches `venueConfirmed`.
  const nameOnly = !venueConfirmed && place?.nameOnlyDisplay === true;
  const publicPlaceName =
    venueIsPublic || nameOnly ? place?.name?.trim() || null : null;
  const publicPlaceSlug =
    venueIsPublic && place?.pageSlug ? place.pageSlug : null;

  if (hasLocation) {
    // THE public projection (`projectPublicEventLocation`): the venue is a
    // floor (a withheld venue withholds the events inside it, read-time,
    // against its CURRENT state), a withheld venue's events draw the VENUE's
    // keyed circle, and anything non-EXACT carries no street and no postcode.
    // Fail closed throughout: only the literal "EXACT" is exact.
    const placeLocation: PlaceLocationSource | null = place
      ? (place.location ?? {
          locationMode: place.locationMode ?? undefined,
          locationRadiusMeters: place.locationRadiusMeters ?? null,
        })
      : null;
    const projected = projectPublicEventLocation(event, {
      place: placeLocation,
      // This IS the gated-access path. `buildEventSeo` compiles the FULL
      // event page (description, schedule, tickets, location) and its only
      // caller, `getEventSeo`, is served behind
      // `ensureFullEventReadAccessBySlug` — a viewer who has not passed a
      // password/application gate is refused before this runs. So the gate
      // rule of the public projector (label only for gated events, on lists,
      // embeds and the search index) does not apply here: a gate-granted
      // viewer sees exactly what they saw before it existed.
      gateAccessGranted: true,
    });

    // A ticket holder's (or live RSVP-er's, Q16) reveal is
    // `resolveHolderAddress` — THE holder
    // decision (reveal date, NEVER, the venue floor, and whether a withheld
    // venue vouched for this event at all) — and it reads the truth from
    // where it lives: the Place row for an event at a withheld venue (whose
    // Event row holds only the public projection — revealing THAT would hand
    // the holder the circle centre dressed up as a pin), the Event row
    // otherwise. A null reveal date stays locked; NEVER stays locked forever;
    // an unconfirmed event at a withheld venue stays locked for good.
    const activeHolder = callerIsTicketHolder || callerHoldsLiveRsvp;
    const holderAddress =
      projected.mode !== "EXACT" && (activeHolder || callerIsActOnBill)
        ? resolveHolderAddress({
            event,
            place: placeLocation,
            venueConfirmationArm: place?.venueConfirmationArm ?? null,
            activeHolder,
            // An act on the bill skips the event's own reveal schedule but
            // not the place's gates (FR-009; see `resolveHolderAddress`).
            actOnBill: callerIsActOnBill,
            // The injected clock (`input.now`), never a fresh `new Date()`:
            // the reveal edge must be the one the caller and its tests
            // control.
            now,
          })
        : null;

    if (projected.mode === "EXACT") {
      location = {
        name: publicPlaceName,
        addressLine1: event.addressText ?? null,
        addressLine2: null,
        city: event.locality ?? null,
        region: event.region ?? null,
        postalCode: event.postalCode ?? null,
        countryCode: event.countryCode ?? null,
        latitude: event.lat ?? null,
        longitude: event.lng ?? null,
        isExact: true,
        placeSlug: publicPlaceSlug,
        venueConfirmed,
      };
    } else if (holderAddress && !holderAddress.locked) {
      viewerAddressReleased = true;
      const fromPlace =
        holderAddress.source === "PLACE" ? placeLocation : null;
      location = {
        name: publicPlaceName,
        addressLine1: holderAddress.addressText,
        addressLine2: null,
        city: fromPlace ? (fromPlace.city ?? null) : (event.locality ?? null),
        region: fromPlace ? (fromPlace.region ?? null) : (event.region ?? null),
        postalCode: holderAddress.postalCode,
        countryCode: fromPlace
          ? (fromPlace.countryCode ?? null)
          : (event.countryCode ?? null),
        latitude: holderAddress.lat,
        longitude: holderAddress.lng,
        isExact: true,
        placeSlug: publicPlaceSlug,
        venueConfirmed,
      };
    } else if (projected.hidden) {
      // Fully hidden pre-reveal: only the coarse area label — no coordinates
      // or radius ever reach the public page / JSON-LD.
      location = {
        name: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
        latitude: null,
        longitude: null,
        isExact: false,
        hidden: true,
        radiusMeters: null,
        areaLabel: projected.areaLabel,
        venueConfirmed,
      };
    } else {
      location = {
        name: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
        latitude: projected.lat,
        longitude: projected.lng,
        isExact: false,
        radiusMeters: projected.radiusMeters,
        areaLabel: projected.areaLabel,
        venueConfirmed,
      };
    }
  }

  return {
    id: event.id,
    slug: event.slug ?? "",
    title: event.title,
    // EventRecord does not include a free-form `description` field; set to null for SEO by default.
    description: null,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    // The date the page PROMISES ("shared with ticket holders on …"), so it
    // is the holder gate's schedule, not the raw column: a withheld venue's
    // confirmed third-party event reveals no earlier than a day ahead, and
    // one the venue has not confirmed promises nothing.
    addressRevealAt: publicRevealAtIso(event, place),
    timezone: event.timezone ?? "America/Chicago",
    viewerHasTicket: callerIsTicketHolder,
    viewerAddressReleased,
    // Community-managed-event-listings (UI request #3): the public event page
    // branches ticket section vs RSVP button on these enums. Defaults cover
    // fixtures/records predating the columns (DB defaults are TICKETED/OWNED).
    attendanceMode: event.attendanceMode ?? "TICKETED",
    stewardship: event.stewardship ?? "OWNED",
    // Gates the "Suggest an edit" CTA (COMMUNITY-only as of 2026-07-20,
    // and PUBLIC-only per FR-006).
    visibility: event.visibility ?? "PUBLIC",
    status: event.status,
    updatedAt: event.updatedAt ? event.updatedAt.toISOString() : null,
    // schema.org Event @type inherited from the category (Category.seoType).
    // Null for uncategorised events; the JSON-LD builder falls back to "Event"
    // for null / unknown values (see isValidEventSchemaType).
    seoType: event.categorySeoType ?? null,
    categoryName: event.categoryName ?? null,
    ticketingUrl: null,
    images,
    heroImageSize,
    location,
    // Null here on purpose: the web app derives the schema.org organizer
    // from `organizerName`/`organizerSlug` below, where it knows its own
    // absolute site URL. See the `org` param doc comment.
    organizer: null,
    // Plain "Presented by" attribution data, and the source of the JSON-LD
    // organizer (web layer). See the `org` param doc comment.
    organizerName: org?.name ?? null,
    organizerSlug: org?.slug ?? null,
    // Real, absolute refund deadline (calm-honest-ux FR-004) — null means no
    // organizer override, so the enforced deadline defaults to `startsAt`
    // (see get-refund-eligibility.ts). Never derived from the dead
    // INSTANT_REFUND_CUTOFF_HOURS constant.
    refundCutoffAt: event.refundCutoffAt
      ? event.refundCutoffAt.toISOString()
      : null,
    pricing:
      minPrice !== undefined
        ? {
            currency: event.currency ?? null,
            minPriceCents: minPrice,
            maxPriceCents: maxPrice ?? minPrice,
            minBuyerTotalCents:
              buyerPricing?.minBuyerUnitTotalCents ?? minPrice,
            maxBuyerTotalCents:
              buyerPricing?.maxBuyerUnitTotalCents ?? maxPrice ?? minPrice,
            availability: null,
            // When tickets went on sale (see `offersValidFrom`).
            validFrom: salesValidFrom ? salesValidFrom.toISOString() : null,
          }
        : null,
    // The go-live stamp. Carried separately from `pricing` because an RSVP
    // listing has no pricing block at all, and its free JSON-LD `Offer`
    // still needs a `validFrom`: it was available from the moment it went
    // live.
    publishedAt: event.publishedAt ? event.publishedAt.toISOString() : null,
    performers: eventHumans
      .filter(
        (eh) =>
          eh.role === "PERFORMER" ||
          eh.role === "DJ" ||
          eh.role === "HOST" ||
          eh.role === "SPEAKER" ||
          eh.role === "INSTRUCTOR",
      )
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((eh) => ({
        eventHumanId: eh.id,
        name: eh.externalName ?? "Unknown",
        role: eh.role,
        url: eh.externalUrl ?? null,
      })),
  };
}
