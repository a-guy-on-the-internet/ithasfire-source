import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  eventAttendanceModeSchema,
  eventStewardshipSchema,
  eventVisibilitySchema,
} from "@th/schema";

import { crawlablePageSlug } from "../../lib/entity-page-visibility";
import { isActOnBill } from "../../lib/event-human-roles";
import { isEmailVerified } from "../_helpers/ensure-email-verified";
import { viewerHoldsLiveRsvp } from "../../lib/location/holder-eligibility";
import { parseInput } from "../../lib/io";
import {
  isVenueConfirmed,
  mayNameUnconfirmedVenue,
  venueConfirmationArm,
} from "../../lib/venue-confirmation";
import { isImageKeyVisible } from "../moderation/gate-image-visibility";
import { buildEventSeo } from "./_shared/build-event-seo";
import {
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "../../lib/location/project-public-event-location";
import { resolveTaxImpositions } from "../../lib/pricing/tax-impositions";
import { estimateBuyerTicketPricingForEvent } from "./_shared/estimate-buyer-ticket-pricing";
import { resolveEventTaxSitus } from "./_shared/resolve-event-tax-rate";
import {
  canViewerReadEvent,
  eventNotFoundBySlug,
  type EventStaffReadProbe,
} from "./_shared/event-public-readability";
import { fail } from "@th/errors";

export const getEventSeoInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(255),
    viewerHumanId: z.string().uuid().optional(),
  })
  .strict();

export const getEventSeoOutputSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    startsAt: z.string(),
    endsAt: z.string().nullable().optional(),
    addressRevealAt: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    viewerHasTicket: z.boolean().optional(),
    /**
     * TRUE when `location` is exact for THIS viewer only: a per-viewer rule
     * released it (a ticket holder or live RSVP-er past the reveal, or an act on the bill
     * while the `arrivalAreas` gate is on, arrival-areas FR-009). False for
     * an address that is public anyway. Viewer-scoped: never in a cached
     * document.
     */
    viewerAddressReleased: z.boolean().optional(),
    /**
     * Community-managed-event-listings spec (UI request #3): the public event
     * page branches its ticket section vs RSVP button on these two enums.
     */
    attendanceMode: eventAttendanceModeSchema,
    stewardship: eventStewardshipSchema,
    /**
     * Whether the signed-in viewer has RSVPed ("I'm going") — only computed
     * for RSVP events with a known viewer; never a public count (FR-004).
     */
    viewerRsvped: z.boolean().optional(),
    /**
     * Edit suggestions (FR-006) are only accepted on PUBLIC published
     * events, so the page needs visibility to gate the "Suggest an edit"
     * CTA — otherwise PRIVATE events would offer a dead-end submission.
     */
    visibility: eventVisibilitySchema,
    status: z.string(),
    updatedAt: z.string().nullable().optional(),
    /**
     * schema.org Event `@type` for the event's JSON-LD, resolved from the
     * event's category (`Category.seoType`). Music categories emit
     * "MusicEvent" (a schema.org/Event subtype — additive for SEO). Null /
     * unknown values fall back to "Event" at the JSON-LD sink.
     */
    seoType: z.string().nullable().optional(),
    /** Category display name, for the page description fallback. */
    categoryName: z.string().nullable().optional(),
    ticketingUrl: z.string().nullable().optional(),
    images: z.array(z.string()).optional(),
    /**
     * Pixel size of `images[0]` (the hero), as the browser displays it.
     * Lets the page set `width`/`height` on the poster so the box is reserved
     * before the bytes arrive. Null when unknown or when there is no hero;
     * never present for a hero the moderation gate hid.
     */
    heroImageSize: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .nullable()
      .optional(),
    location: z
      .object({
        name: z.string().nullable().optional(),
        addressLine1: z.string().nullable().optional(),
        addressLine2: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
        countryCode: z.string().nullable().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        isExact: z.boolean().optional(),
        /**
         * FULLY-HIDDEN pre-reveal state (OBSCURED + null radius): no
         * coordinates or radius at all — only `areaLabel`. The page renders
         * a "location revealed on {date}" notice instead of a map.
         */
        hidden: z.boolean().optional(),
        radiusMeters: z.number().nullable().optional(),
        areaLabel: z.string().nullable().optional(),
        /**
         * ENTITY PAGE slug of the linked, directory-listed Place — the value
         * `/places/[slug]` resolves on, and the one clients build the "At
         * {venue}" link from. NOT `Place.slug` (a multi-segment directory key
         * no route resolves).
         *
         * Null when the venue has no entity page, or that page is not PUBLIC.
         * `name` may still be present in that case — the two are gated
         * separately (see buildEventSeo): the name is a DISCLOSURE decision,
         * this is a REACHABILITY one. Clients render an unlinked badge.
         *
         * Only ever populated when the location is in its exact/revealed
         * state — see `buildEventSeo` for the redaction-gated logic. Never
         * present alongside `isExact: false`.
         */
        placeSlug: z.string().nullable().optional(),
        /**
         * Venue-confirmation spec (docs/specs/2026-08-27): true when the
         * venue vouches for this event at its place (venue-owned, or stamped
         * and not withdrawn — `isVenueConfirmed`). Gates `placeSlug` (and,
         * with the directory-listed rule, the confirmed `name`). `name` MAY
         * still be present while this is false: an unconfirmed community
         * listing may name its venue as plain text (owner ruling 2026-10-06,
         * `mayNameUnconfirmedVenue`) — no slug, no endorsement implied.
         * Always false for an event with no place. `placeId` never leaves
         * the server on this shape either way.
         */
        venueConfirmed: z.boolean(),
      })
      .nullable()
      .optional(),
    organizer: z
      .object({
        name: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    /**
     * Plain "Presented by {name}" attribution for the visible event-detail
     * badge. The web app also builds the schema.org JSON-LD organizer from
     * these two (absolute `<site>/orgs/{slug}`), since only it knows its site
     * URL; `organizer` above stays null from this use case.
     * `organizerSlug` resolves to the site's own `/orgs/{slug}` page, not an
     * external URL. Both null for ownerless COMMUNITY listings.
     */
    organizerName: z.string().nullable().optional(),
    organizerSlug: z.string().nullable().optional(),
    /**
     * The event's real, absolute self-serve refund deadline (calm-honest-ux
     * FR-004), as an ISO datetime — mirrors `EventRecord.refundCutoffAt`
     * exactly. `null` means the organizer never overrode it, so the actual
     * enforced deadline defaults to `startsAt` (see
     * `get-refund-eligibility.ts`: `event.refundCutoffAt ?? eventStartsAt`).
     * This is NOT an hours-before-event window — display code must compare
     * it against `startsAt` to render the correct copy.
     */
    refundCutoffAt: z.string().nullable().optional(),
    pricing: z
      .object({
        currency: z.string().nullable().optional(),
        minPriceCents: z.number().nullable().optional(),
        maxPriceCents: z.number().nullable().optional(),
        minBuyerTotalCents: z.number().nullable().optional(),
        maxBuyerTotalCents: z.number().nullable().optional(),
        availability: z.string().nullable().optional(),
        /**
         * ISO datetime tickets went on sale: the earliest ticket type
         * opening, where a type with no `salesOpenAt` opens at
         * `publishedAt` (see `offersValidFrom` in build-event-seo).
         */
        validFrom: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    /**
     * ISO datetime the event went live (`Event.publishedAt`); null for an
     * event never published. The fallback JSON-LD `Offer.validFrom` for an
     * event with no `pricing` block (an RSVP listing's free Offer).
     */
    publishedAt: z.string().nullable().optional(),
    performers: z
      .array(
        z.object({
          eventHumanId: z.string(),
          name: z.string(),
          role: z.string(),
          url: z.string().nullable().optional(),
        }),
      )
      .optional(),
  })
  .strict();

export type GetEventSeoInput = z.infer<typeof getEventSeoInputSchema>;
export type GetEventSeoOutput = z.infer<typeof getEventSeoOutputSchema>;

export type GetEventSeoDeps = {
  repos: Repos;
  /**
   * The staff probe behind a community moderator's read of a hidden
   * COMMUNITY listing.
   */
  authz: EventStaffReadProbe;
  /**
   * Required (FR-003) — feeds the shared buyer-pricing estimator and the
   * JSON-LD `offers.price` built by `buildEventSeo`.
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Whether an act on the bill sees the exact address on this page
   * (arrival-areas FR-009), which ships behind the `arrivalAreas` feature
   * gate (FR-017). The composition root / transport sets it from the gate.
   * Absent or false = off: acts get only what any viewer gets. A dep, not an
   * input field, because the transport spreads its client input into the
   * use case's input, so a client could switch an input flag on itself.
   */
  actAddressEnabled?: boolean;
};

export async function getEventSeo(
  deps: GetEventSeoDeps,
  rawInput: unknown,
): Promise<GetEventSeoOutput> {
  const input = parseInput(getEventSeoInputSchema, rawInput);

  // Resolve slug -> eventId
  const resolution = await deps.repos.events.resolveBySlug(input.slug);
  if (!resolution) {
    throw eventNotFoundBySlug();
  }

  const event = await deps.repos.events.getById(resolution.eventId, {
    withOwnerStanding: true,
  });
  if (!event) {
    throw eventNotFoundBySlug();
  }

  // N3: a page that was never public is not readable by slug. A DRAFT (or an
  // event cancelled / archived without ever going live) answers exactly like
  // a missing event unless the viewer can edit it — the same error, `meta`
  // and all, so the response cannot confirm that a guessed slug exists. This
  // runs BEFORE the redirect check: `EVENT_SLUG_REDIRECT` for a hidden event's
  // OLD slug would itself say "this was a real event". See
  // `event-public-readability`.
  if (
    !(await canViewerReadEvent(
      deps.repos.authz,
      event,
      input.viewerHumanId,
      deps.repos.tickets,
      deps.authz,
    ))
  ) {
    throw eventNotFoundBySlug();
  }

  // An old slug of an event the caller may read: not found HERE — callers
  // resolve first (`resolveEventBySlug`) and ask with the current slug.
  if (resolution.redirect) {
    throw fail("EVENT_SLUG_REDIRECT");
  }

  const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
  const eventHumans = await deps.repos.eventHumans.listByEvent(event.id);

  const place = event.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;

  // The venue's PUBLIC page slug. `/places/[slug]` resolves on
  // `EntityPage.slug`, never on `Place.slug` (a multi-segment directory key),
  // so the "At {venue}" link on every public event page has to come from here.
  // Deliberately NOT swallowed: a failing read is a real fault and belongs in
  // the thrown-error backstop, not silently degraded into a missing link.
  //
  // Gated on the two predicates `buildEventSeo` applies to the result anyway,
  // both computable without IO (`isVenueConfirmed` is pure; `listedInDirectory`
  // is already on the record). An OBSCURED or unconfirmed event, or an unlisted
  // venue, would discard the row — so it does not pay for a round trip in a
  // fully serial chain on a crawler-visible page.
  const venueConfirmedForSeo = place ? isVenueConfirmed(event, place) : false;
  const placePage =
    place && venueConfirmedForSeo && place.listedInDirectory
      ? await deps.repos.entityPages.getByOwner("PLACE", place.id)
      : null;

  // Org attribution for the "Presented by" badge (calm-honest-ux FR-003).
  // Ownerless COMMUNITY listings have no orgId, so this stays null there.
  const org = event.orgId
    ? await deps.repos.organizations.getById(event.orgId)
    : null;

  // Viewer's own "I'm going" state (community-managed-event-listings FR-004):
  // only queried for RSVP events with a signed-in viewer; never a count.
  // Read first so the RSVP address check below reuses it.
  let viewerRsvped: boolean | undefined;
  if (input.viewerHumanId && event.attendanceMode === "RSVP") {
    viewerRsvped = await deps.repos.eventRsvps.existsForUser({
      eventId: event.id,
      humanId: input.viewerHumanId,
    });
  }

  // Ticket-holder lookup only matters for OBSCURED events (the reveal gate);
  // EXACT events skip the query entirely.
  //
  // NOTE on the ceiling: an event stored EXACT at a venue that has SINCE been
  // withheld does not stay EXACT. Withholding a venue cascades inside
  // `upsertPlace`'s transaction: every event at the place is re-projected to
  // the venue's public projection (OBSCURED), and an event that had no reveal
  // schedule is given DAY_BEFORE (`startsAt − 24h`). So by the time this
  // reads the row it is OBSCURED with a date, the holder lookup below runs,
  // and holders unlock on that schedule (for a third party's event, only
  // once the venue has vouched — see `resolveHolderAddress`). A row the
  // cascade has not reached yet still renders withheld on this read, because
  // `buildEventSeo` floors the event by the venue's CURRENT state.
  //
  // A live RSVP-er counts like a holder for the street (arrival-areas owner
  // ruling Q16, 2026-10-17), through the one RSVP predicate the arrival-area
  // access uses too. Not behind the `arrivalAreas` gate: list-my-rsvps, the
  // RSVP confirmation and reminders already hand RSVP-ers the street on the
  // same schedule; this makes the event page agree with them. Read only
  // when the viewer holds no ticket (it adds nothing then); it reuses the
  // `viewerRsvped` read, and a CANCELLED event releases nothing to RSVP-ers.
  let callerIsTicketHolder = false;
  let callerHoldsLiveRsvp = false;
  if (input.viewerHumanId && event.locationMode === "OBSCURED") {
    callerIsTicketHolder = await deps.repos.tickets.viewerHoldsActiveTicketForEvent(
      event.id,
      input.viewerHumanId,
    );
    if (!callerIsTicketHolder) {
      callerHoldsLiveRsvp = await viewerHoldsLiveRsvp(
        deps.repos,
        event,
        input.viewerHumanId,
        { eventRsvpExists: viewerRsvped },
      );
    }
  }

  // Tax-unresolved rule (same as `ticketTiersForCard` and the search index's
  // `buyerTotalForIndex`): with no stamped admission-tax rate, checkout
  // resolves tax LIVE, so a buyer total built at 0% would understate the
  // charge. Skip the estimate; `buildEventSeo` then reports the face-value
  // range, its existing fallback when no estimate is given. `== null` also
  // catches `undefined` (the field is optional on EventRecord).
  const buyerPricing =
    event.admissionTaxRateBps == null
      ? undefined
      : await estimateBuyerTicketPricingForEvent(deps, event, ticketTypes, {
          // The buyer totals are all-in numbers a buyer reads as the price.
          // They have to be built from the venue's taxable base, or a
          // Tennessee event advertises below what checkout charges.
          taxImpositions: resolveTaxImpositions({
            situs: await resolveEventTaxSitus(deps.repos, event),
            salesTaxRateBps: event.admissionTaxRateBps,
          }),
        });

  // Read-time moderation gate (FR-005): hide the hero (from the page hero AND
  // the og:image) unless its moderation record is APPROVED. Absent record
  // (legacy) = visible. Owner/admin edit reads use a different use case and are
  // deliberately NOT gated, so an uploader still sees their pending image.
  const heroVisible = await isImageKeyVisible(deps.repos, event.heroImageKey);
  const gatedEvent = heroVisible
    ? event
    : { ...event, heroImageUrl: null, heroImageSize: null };

  const output = buildEventSeo({
    event: gatedEvent,
    ticketTypes,
    eventHumans,
    callerIsTicketHolder,
    callerHoldsLiveRsvp,
    // Acts on the bill (arrival-areas FR-009): a viewer listed on this
    // event's lineup with an act role sees the exact address through
    // `resolveHolderAddress`'s act path, only while the `arrivalAreas` gate
    // is on (`deps.actAddressEnabled`). B2: the lineup row may have been
    // linked BY EMAIL (`inviteLineupHumanToRegister`) onto an unverified
    // account someone else opened under that address, so the act path also
    // needs the viewer's verified email: one read, only for an act.
    callerIsActOnBill:
      deps.actAddressEnabled === true &&
      input.viewerHumanId !== undefined &&
      isActOnBill(eventHumans, input.viewerHumanId) &&
      (await isEmailVerified(deps.repos.humans, input.viewerHumanId)),
    buyerPricing,
    place: place
      ? {
          // PUBLIC only. The event page is crawler-visible, so linking an
          // UNLISTED venue page would create exactly the discovery its owner
          // opted out of ("it stays out of search and browse"), and a PRIVATE
          // one 404s. Same gate the search index and sitemap use — and the
          // same one `humans.listForSearchIndex` already applies to human
          // pages. See lib/entity-page-visibility.
          pageSlug: crawlablePageSlug(placePage),
          name: place.name,
          listedInDirectory: place.listedInDirectory,
          // THE derivation (lib/venue-confirmation): venue-owned, or stamped
          // and not withdrawn. Address-only otherwise. Hoisted above so the
          // entity-page read can skip the cases that discard its result.
          venueConfirmed: venueConfirmedForSeo,
          // Owner ruling 2026-10-06 (option B): an unconfirmed community
          // listing may show the venue's NAME as plain text. Display only —
          // no slug (the entity-page read above stays confirmed-only), and
          // `venueConfirmed` stays false.
          nameOnlyDisplay: mayNameUnconfirmedVenue(event, place),
          // WHICH arm vouched, from the same row: a withheld venue releases
          // its address to holders only for its own show or one it
          // confirmed by hand, never for a community listing.
          venueConfirmationArm: venueConfirmationArm(event, place),
          // The venue's own address privacy. `buildEventSeo` clamps the
          // event's public precision to it, so flipping a venue to withheld
          // hides the events ALREADY published there on the very next read.
          locationMode: place.locationMode,
          locationRadiusMeters: place.locationRadiusMeters,
          // The venue's full privacy row: a withheld venue's events draw the
          // VENUE's keyed circle, and a holder's reveal reads its address.
          location: toPlaceLocationSource(place),
        }
      : event.placeId
        ? {
            // The place row is GONE: nothing to name or link, and its
            // address privacy is unknown — fail closed (fully hidden).
            pageSlug: null,
            name: null,
            listedInDirectory: false,
            venueConfirmed: false,
            venueConfirmationArm: null,
            location: unreadablePlaceLocation(event.placeId),
          }
        : null,
    org: org ? { name: org.name, slug: org.slug } : null,
    now: deps.clock.now(),
  });

  deps.logger?.info("events.get_seo", { slug: input.slug, eventId: event.id });

  return getEventSeoOutputSchema.parse({
    ...output,
    ...(viewerRsvped !== undefined ? { viewerRsvped } : {}),
  });
}
