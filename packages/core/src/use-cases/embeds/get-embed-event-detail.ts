import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { loadTicketTypeAvailability } from "../_helpers/load-ticket-type-availability";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import {
  resolveTicketTypeSellability,
  resolveUpcomingPriceChange,
  ticketTypeSellabilitySchema,
  upcomingPriceChangeSchema,
} from "../../lib/orders/ticket-type-sellability";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import { resolvePlaceLocations } from "../../lib/location/resolve-place-locations";
import { isImageKeyVisible } from "../moderation/gate-image-visibility";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import { assertEventAllowedForEmbed } from "./_shared/is-event-allowed-for-embed";
import {
  embedGateTypeOf,
  embedGateTypeSchema,
  isEventUngatedForEmbed,
} from "./_shared/assert-event-ungated-for-embed";
import { fail } from "@th/errors";
// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getEmbedEventDetailInputSchema = z
  .object({
    embedId: z.uuid(),
    eventId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
  })
  .strict();

const ticketTypeItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  pricingMode: z.enum(["FIXED", "ADJUSTABLE"]),
  minimumCents: z.number().int().nullable(),
  suggestedCents: z.number().int().nullable(),
  /**
   * The AUTHORED capacity column, retained verbatim. NOT an availability
   * signal — no write path decrements it. Sold-out lives on `soldOut` below.
   */
  capacity: z.number().int(),
  /**
   * How many of this tier a buyer can take RIGHT NOW: `capacity - issued -
   * held`, clamped at 0 — the same basis the pre-charge gate refuses on.
   * SAME fields, same meanings, as the public ticket list returns: an embed
   * and the event page showing the same event must not describe its stock in
   * two dialects.
   */
  remainingCapacity: z.number().int().nonnegative(),
  /**
   * `remainingCapacity <= 0`. The widget's sold-out test used to be
   * `capacity <= 0` client-side, which reads the authored column and is
   * therefore essentially never true — a sold-out tier rendered a working
   * +/- stepper inside a partner's iframe and refused the buyer at submit.
   */
  soldOut: z.boolean(),
  status: z.string(),
  seatSection: z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["GA", "RESERVED"]),
    })
    .nullable(),
  /**
   * PER-TIER availability (FR-010). Embeds were a SECOND, INCOMPATIBLE
   * representation of sales state — a bare `salesClosed` boolean at the top of
   * the payload, no reason enum, nothing per tier — so a windowed tier was
   * indistinguishable from an open one inside a partner's iframe. This is the
   * SAME schema the public ticket list returns, deliberately: an embed and the
   * event page showing the same event must not describe it in two dialects.
   *
   * It already folds the event-wide close in (`salesClosed` ⇒ every tier
   * reports `sales_closed`), so reading this alone is correct.
   */
  sellability: ticketTypeSellabilitySchema,
  /**
   * Q-002 urgency copy — "$12 until Fri 3 Oct". Null once the flip has passed.
   * Carried here as well as on the public list because an embed is an online
   * purchase surface with our brand on it; letting it advertise a price without
   * the deadline the site shows is the same disagreement in a different frame.
   */
  upcomingPriceChange: upcomingPriceChangeSchema.nullable(),
});

const eventHumanItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  customRoleLabel: z.string().nullable(),
  profileUrl: z.string().nullable(),
  sortOrder: z.number().int(),
});

const tagItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

const locationCoordsSchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    label: z.string().nullable(),
    isExact: z.boolean(),
    radiusMeters: z.number().nullable(),
    areaLabel: z.string().nullable(),
  })
  .nullable();

export const getEmbedEventDetailOutputSchema = z
  .object({
    event: z.object({
      id: z.string(),
      title: z.string(),
      slug: z.string().nullable(),
      startsAt: z.date(),
      endsAt: z.date().nullable(),
      /**
       * IANA zone of the EVENT. Added by FR-010: the widget now renders
       * per-tier sales-window instants ("On sale Fri, Oct 9, 10:00 AM CDT"),
       * and a sales window is an organizer's wall-clock decision about their
       * venue. Rendering it in the READER's zone — which is what an embed on a
       * third-party site would otherwise do — tells a buyer in London that a
       * Nashville tier opens at 2 AM. True, and useless.
       */
      timezone: z.string(),
      currency: z.string(),
      heroImageUrl: z.string().nullable(),
      addressText: z.string().nullable(),
      locality: z.string().nullable(),
      region: z.string().nullable(),
      locationLabel: z.string().nullable(),
      locationCoords: locationCoordsSchema,
      waitlistStatus: z.enum(["DISABLED", "SCHEDULED", "OPEN"]),
      waitlistDescription: z.string().nullable(),
      /**
       * The event's gate (owner ruling 2026-10-12). Anything but "NONE" is a
       * GATED PREVIEW: title, date, hero and `slug` (the widget links out to
       * `/events/{slug ?? id}` on Ithas Fire), with location, waitlist,
       * `body`, `imageMap`, `ticketTypes`, `eventHumans` and `tags` all empty.
       * The embed can never unlock it — see `assert-event-ungated-for-embed`.
       */
      gateType: embedGateTypeSchema,
    }),
    ticketTypes: z.array(ticketTypeItemSchema),
    /**
     * True when the sales window has closed — same rule as the canonical
     * purchase guard `ensureEventOnSale` (checkout-helpers), so the widget can
     * suppress buyable UI up front instead of failing at submit with
     * EVENT_SALES_CLOSED.
     */
    salesClosed: z.boolean(),
    /** Opaque body JSON (EventBody). Null when no body has been saved. */
    body: z.unknown().nullable(),
    /** Map of image-asset-id → publicUrl for rendering body image blocks. */
    imageMap: z.record(z.string(), z.string()),
    eventHumans: z.array(eventHumanItemSchema),
    tags: z.array(tagItemSchema),
  })
  .strict();

export type GetEmbedEventDetailInput = z.infer<
  typeof getEmbedEventDetailInputSchema
>;
export type GetEmbedEventDetailOutput = z.infer<
  typeof getEmbedEventDetailOutputSchema
>;

export type GetEmbedEventDetailDeps = {
  repos: Pick<
    Repos,
    | "embeds"
    | "events"
    | "organizations"
    | "seats"
    | "eventHumans"
    | "humans"
    | "images"
    | "tags"
    | "seriesOccurrences"
    | "imageModerationRecords"
    /** The venue's address privacy floors the event's public location. */
    | "places"
    /**
     * Per-tier availability only, through the LOCK-FREE batch read. The
     * locking counter must never be reached from this path — an embed is a
     * public read surface and would queue behind live checkouts.
     */
    | "tickets"
  >;
  /**
   * Required (FR-003). An embed is a third-party-hosted checkout entry point —
   * a stale price here is a partner site advertising one number while our
   * checkout charges another, with our brand on both.
   */
  clock: ClockPort;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter: a failed venue read renders the event's
   * location fully hidden (fail closed) instead of failing the embed.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function getEmbedEventDetail(
  deps: GetEmbedEventDetailDeps,
  rawInput: unknown,
): Promise<GetEmbedEventDetailOutput> {
  const logger = deps.logger?.child({ useCase: "getEmbedEventDetail" });

  /** Enrich ticket types with optional seatSection summary. */
  const mapTicketTypes = async (
    ticketTypes: Array<{
      id: string;
      name: string;
      priceCents: number;
      pricingMode?: string;
      minimumCents?: number | null;
      suggestedCents?: number | null;
      capacity: number;
      status: string;
      seatSectionId?: string | null;
      scheduledPriceCents?: number | null;
      scheduledPriceAt?: Date | null;
      salesOpenAt?: Date | null;
      salesCloseAt?: Date | null;
    }>,
    eventId: string,
    /**
     * ONE instant and ONE event-wide verdict for the whole response. Hoisted
     * out of this helper by FR-010: per-tier sellability folds the event-level
     * close in, so resolving the two against different clocks would let the
     * payload contradict itself — a tier reporting `sales_closed` next to a
     * top-level `salesClosed: false`, or the reverse.
     */
    context: { now: Date; salesClosed: boolean },
  ) => {
    // FR-004: one instant for the whole mapped list.
    const { now } = context;
    const eventLevel = context.salesClosed
      ? ({ available: false, reason: "sales_closed" } as const)
      : ({ available: true, reason: "ok" } as const);
    // Bulk-load all sections for the event in one query, then look up by id
    const hasSeatSections = ticketTypes.some((tt) => tt.seatSectionId);
    const sectionMap = new Map<
      string,
      { id: string; name: string; type: "GA" | "RESERVED" }
    >();
    if (hasSeatSections) {
      const sections = await deps.repos.seats.listSectionsByEvent(eventId);
      for (const sec of sections) {
        sectionMap.set(sec.id, { id: sec.id, name: sec.name, type: sec.type });
      }
    }

    // Per-tier stock at the SAME instant as the prices below. ONE batched,
    // LOCK-FREE query for every tier — see
    // `_helpers/load-ticket-type-availability.ts`, including why holds count
    // here and not at the door.
    const availabilityById = await loadTicketTypeAvailability(deps.repos, {
      ticketTypes,
      now,
    });

    return ticketTypes.map((tt) => {
      // Unreachable fallback (the helper fills every tier it is handed), and
      // it fails CLOSED: an unknown stock level must not become an offer.
      const availability = availabilityById.get(tt.id);
      return {
        id: tt.id,
        name: tt.name,
        // Effective price at `now` — the one price every surface charges.
        priceCents: resolveUnitPriceCents(tt, { now }),
        pricingMode: tt.pricingMode ?? "FIXED",
        minimumCents: tt.minimumCents ?? null,
        suggestedCents: tt.suggestedCents ?? null,
        capacity: tt.capacity,
        remainingCapacity: availability?.remainingCapacity ?? 0,
        soldOut: availability?.soldOut ?? true,
        status: tt.status,
        seatSection: tt.seatSectionId
          ? (sectionMap.get(tt.seatSectionId) ?? null)
          : null,
        sellability: resolveTicketTypeSellability(tt, now, eventLevel),
        upcomingPriceChange: resolveUpcomingPriceChange(tt, now),
      };
    });
  };

  const buildEventPayload = (
    event: {
      id: string;
      orgId?: string | null;
      humanId?: string | null;
      title: string;
      slug: string | null;
      startsAt: Date;
      endsAt: Date | null;
      timezone?: string | null;
      currency?: string | null;
      heroImageUrl?: string | null;
      addressText: string | null;
      locality?: string | null;
      region?: string | null;
      locationLabel?: string | null;
      lat?: number | null;
      lng?: number | null;
      locationMode?: string | null;
      locationRadiusMeters?: number | null;
      /** Required (N5): a missing gate projects as gated (label only). */
      gateType: string | null | undefined;
      waitlistStatus?: string | null;
      waitlistDescription?: string | null;
    },
    place: PlaceLocationSource | null,
  ) => {
    const location = buildPublicEmbedLocationFields(event, place);

    return {
      id: event.id,
      title: event.title,
      slug: event.slug,
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? null,
      timezone: resolveTimeZone(event.timezone),
      currency: event.currency ?? "usd",
      heroImageUrl: event.heroImageUrl ?? null,
      addressText: location.addressText,
      locality: location.locality,
      region: location.region,
      locationLabel: location.locationLabel,
      locationCoords: location.locationCoords,
      waitlistStatus:
        (event.waitlistStatus as "DISABLED" | "SCHEDULED" | "OPEN") ??
        "DISABLED",
      waitlistDescription: event.waitlistDescription ?? null,
      gateType: embedGateTypeOf(event),
    };
  };

  /**
   * The GATED PREVIEW (owner ruling 2026-10-12): the card the widget shows
   * for a gated event (title, date, hero) plus the slug it links out with.
   * Built from the event row alone — the caller returns this BEFORE reading
   * tiers, body, people, tags or the venue, so none of them is fetched for a
   * gated event.
   *
   * It DIFFERS from the main-site gate (`getEventGatedPreview`) on purpose:
   * that one sends only a zone-free local day, because there the IANA zone
   * would be the first hint of WHERE. Here the event's `timezone` is kept
   * (orchestrator ruling, round 2) because the city is already public: rule
   * 5 of `projectPublicEventLocation` keeps a gated event's locality and
   * region, and its "locality, region" label, on every public surface. A
   * zone discloses nothing beyond that city, and the card needs it to print
   * the date and time in the event's zone. This holds for a pinned
   * single-event embed too, which has no list card.
   *
   * - Location: address, place label and coordinates are all null. The
   *   preview adds nothing about WHERE beyond the public city.
   * - Waitlist: DISABLED with no description — its copy is organiser free
   *   text and joining it is a step toward buying, which the widget does not
   *   offer for a gated event.
   * - `salesClosed`: the same date rule as an ungated event; with no tiers it
   *   offers nothing either way.
   */
  const buildGatedPreview = (
    event: Parameters<typeof buildEventPayload>[0],
    now: Date,
  ): GetEmbedEventDetailOutput => ({
    event: {
      id: event.id,
      title: event.title,
      slug: event.slug,
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? null,
      timezone: resolveTimeZone(event.timezone),
      currency: event.currency ?? "usd",
      heroImageUrl: event.heroImageUrl ?? null,
      addressText: null,
      locality: null,
      region: null,
      locationLabel: null,
      locationCoords: null,
      waitlistStatus: "DISABLED",
      waitlistDescription: null,
      gateType: embedGateTypeOf(event),
    },
    ticketTypes: [],
    salesClosed: isEmbedSalesClosed(event.startsAt, event.endsAt ?? null, now),
    body: null,
    imageMap: {},
    eventHumans: [],
    tags: [],
  });

  /**
   * Moderation visibility gate (FR-005): the embed is a fully public surface,
   * so a pending/flagged hero must not render. Absent record = legacy = visible.
   * Returns the event with its hero url nulled when the hero isn't APPROVED.
   */
  const gateHero = async <
    T extends { heroImageUrl?: string | null; heroImageKey?: string | null },
  >(
    event: T,
  ): Promise<T> => {
    const visible = await isImageKeyVisible(deps.repos, event.heroImageKey);
    return visible ? event : { ...event, heroImageUrl: null };
  };

  /** Resolve event humans for public display. */
  const resolveEventHumans = async (eventId: string) => {
    const records = await deps.repos.eventHumans.listByEvent(eventId);
    if (records.length === 0) return [];

    const linkedHumanIds = records
      .map((r) => r.humanId)
      .filter((id): id is string => id !== null);

    const humanNames = new Map<string, string>();
    if (linkedHumanIds.length > 0) {
      const humans = await deps.repos.humans.getByIds(linkedHumanIds);
      for (const human of humans) {
        if (human.name) humanNames.set(human.id, human.name);
      }
    }

    return records.map((r) => ({
      id: r.id,
      name:
        (r.humanId && humanNames.get(r.humanId)) || r.externalName || "Unknown",
      role: r.role,
      customRoleLabel: r.customRoleLabel ?? null,
      profileUrl: r.externalUrl ?? null,
      sortOrder: r.sortOrder,
    }));
  };

  /** Resolve tags for an event. */
  const resolveEventTags = async (eventId: string) => {
    const eventTags = await deps.repos.tags.getEventTags(eventId);
    return eventTags.map((et) => ({
      id: et.tag.id,
      slug: et.tag.slug,
      name: et.tag.name,
    }));
  };

  /** Resolve body content + image map for an event. */
  const resolveBody = async (eventId: string) => {
    const body = await deps.repos.events.getContent({ eventId });
    const imageMap = await resolveBodyImageMap(deps, eventId, body);
    return { body: body ?? null, imageMap };
  };

  /**
   * The venue's privacy row for the public projection, or null for an event
   * with no venue. A gone/unreadable venue fails closed (fully hidden).
   */
  const resolveEventPlaceLocation = async (
    placeId: string | null | undefined,
  ): Promise<PlaceLocationSource | null> => {
    if (!placeId) return null;
    const locations = await resolvePlaceLocations(deps, [placeId], {
      useCase: "getEmbedEventDetail",
    });
    return locations.get(placeId) ?? null;
  };

  const execute = async () => {
    const input = parseInput(getEmbedEventDetailInputSchema, rawInput);

    const embed = await deps.repos.embeds.getById(input.embedId);
    if (!embed || embed.status !== "ACTIVE") {
      throw fail("EMBED_NOT_FOUND");
    }

    assertEmbedOriginAllowed({
      embed,
      hostOrigin: input.hostOrigin,
      publicAppUrl: deps.publicAppUrl,
      logger,
    });

    // For organization embeds: verify the event belongs to this org
    if (embed.subjectType === "organization") {
      const event = await deps.repos.events.getById(input.eventId, {
        withOwnerStanding: true,
      });
      // A banned owner's event is withheld (ban-that-sticks).
      if (
        !event ||
        event.status !== "PUBLISHED" ||
        event.ownerBanned === true
      ) {
        throw fail("EVENT_NOT_FOUND");
      }

      await assertEventAllowedForEmbed(deps, embed, event);

      // Gated: the preview only, before any tier/body/people/tag/venue read.
      if (!isEventUngatedForEmbed(event)) {
        return buildGatedPreview(await gateHero(event), deps.clock.now());
      }

      const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
      const activeTicketTypes = ticketTypes.filter(
        (tt) => tt.status === "ACTIVE",
      );

      // ONE instant for the whole response — see the note on `mapTicketTypes`.
      // This deliberately reads the INJECTED clock; it used to be a bare
      // `new Date()` while the prices beside it resolved against
      // `deps.clock.now()`, which is a contradiction waiting to happen now that
      // per-tier sellability folds the event-level close in. No production
      // behaviour change (the injected clock IS the wall clock there).
      const now = deps.clock.now();
      const salesClosed = isEmbedSalesClosed(
        event.startsAt,
        event.endsAt ?? null,
        now,
      );

      const [mappedTicketTypes, { body, imageMap }, eventHumans, tags] =
        await Promise.all([
          mapTicketTypes(activeTicketTypes, event.id, { now, salesClosed }),
          resolveBody(event.id),
          resolveEventHumans(event.id),
          resolveEventTags(event.id),
        ]);

      return {
        event: buildEventPayload(
          await gateHero(event),
          await resolveEventPlaceLocation(event.placeId),
        ),
        ticketTypes: mappedTicketTypes,
        salesClosed,
        body,
        imageMap,
        eventHumans,
        tags,
      };
    }

    // For event embeds: verify the eventId matches the pinned event or a
    // PUBLISHED sibling date of its series.
    if (embed.subjectType === "event") {
      const event = await deps.repos.events.getById(input.eventId, {
        withOwnerStanding: true,
      });
      // A banned owner's event is withheld (ban-that-sticks).
      if (
        !event ||
        event.status !== "PUBLISHED" ||
        event.ownerBanned === true
      ) {
        throw fail("EVENT_NOT_FOUND");
      }

      await assertEventAllowedForEmbed(deps, embed, event);

      // Gated: the preview only — see the organization branch.
      if (!isEventUngatedForEmbed(event)) {
        return buildGatedPreview(await gateHero(event), deps.clock.now());
      }

      const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
      const activeTicketTypes = ticketTypes.filter(
        (tt) => tt.status === "ACTIVE",
      );

      // ONE instant for the whole response — see the organization branch.
      const now = deps.clock.now();
      const salesClosed = isEmbedSalesClosed(
        event.startsAt,
        event.endsAt ?? null,
        now,
      );

      const [mappedTicketTypes, { body, imageMap }, eventHumans, tags] =
        await Promise.all([
          mapTicketTypes(activeTicketTypes, event.id, { now, salesClosed }),
          resolveBody(event.id),
          resolveEventHumans(event.id),
          resolveEventTags(event.id),
        ]);

      return {
        event: buildEventPayload(
          await gateHero(event),
          await resolveEventPlaceLocation(event.placeId),
        ),
        ticketTypes: mappedTicketTypes,
        salesClosed,
        body,
        imageMap,
        eventHumans,
        tags,
      };
    }

    throw fail("UNSUPPORTED_SUBJECT_TYPE");
  };

  if (logger) {
    return logger.withTime(
      "getEmbedEventDetail",
      execute,
    ) as unknown as Promise<GetEmbedEventDetailOutput>;
  }
  return execute() as unknown as Promise<GetEmbedEventDetailOutput>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the canonical purchase guard `ensureEventOnSale` (checkout-helpers):
 * sales close at `endsAt`, falling back to `startsAt` when endsAt is missing.
 */
export function isEmbedSalesClosed(
  startsAt: Date,
  endsAt: Date | null,
  now: Date,
): boolean {
  return now.getTime() >= (endsAt ?? startsAt).getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public location redaction (FR-013)
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicEmbedLocationInput {
  /** With the owner + address, keys the event's circle (`eventCircleSubject`). */
  id: string;
  orgId?: string | null;
  humanId?: string | null;
  addressText: string | null;
  locality?: string | null;
  region?: string | null;
  locationLabel?: string | null;
  lat?: number | null;
  lng?: number | null;
  locationMode?: string | null;
  locationRadiusMeters?: number | null;
  /**
   * A gated event is label only on the embed (`projectPublicEventLocation`
   * rule 5). REQUIRED (N5): a missing gate projects as gated.
   */
  gateType: string | null | undefined;
}

export interface PublicEmbedLocationFields {
  addressText: string | null;
  locality: string | null;
  region: string | null;
  locationLabel: string | null;
  locationCoords: {
    latitude: number;
    longitude: number;
    label: string | null;
    isExact: boolean;
    radiusMeters: number | null;
    areaLabel: string | null;
  } | null;
}

/**
 * FR-013: the embed is a fully public surface — a non-EXACT event must never
 * leak its true pin or street address here. EXACT events are unchanged (true
 * coords + isExact:true + full addressText).
 *
 * Routed through THE public projection (`projectPublicEventLocation`): the
 * venue (`place`) is a floor, a withheld venue's events draw the venue's
 * keyed circle, and an event-level OBSCURED event draws its own keyed circle.
 * Fail closed: only the literal "EXACT" is exact.
 *
 * For non-EXACT events the operator-authored free-text `locationLabel` (which
 * can name a specific venue/address) and the precise `region` are dropped;
 * the coarse "locality, region" label is the only public label exposed.
 */
export function buildPublicEmbedLocationFields(
  event: PublicEmbedLocationInput,
  place: PlaceLocationSource | null = null,
): PublicEmbedLocationFields {
  const projected = projectPublicEventLocation(event, { place });
  const isExact = projected.mode === "EXACT";
  const areaLabel = isExact ? null : projected.label;

  return {
    addressText: isExact ? (event.addressText ?? null) : null,
    locality: isExact ? (event.locality ?? null) : null,
    region: isExact ? (event.region ?? null) : null,
    locationLabel: isExact ? (event.locationLabel ?? null) : areaLabel,
    locationCoords:
      projected.lat !== null && projected.lng !== null
        ? {
            latitude: projected.lat,
            longitude: projected.lng,
            label: isExact ? (event.locationLabel ?? null) : areaLabel,
            isExact,
            // Non-null exactly when a circle is drawn; null for EXACT.
            radiusMeters: projected.radiusMeters,
            areaLabel,
          }
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Image map resolution (mirrors get-public-event-body.ts logic)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveBodyImageMap(
  deps: GetEmbedEventDetailDeps,
  eventId: string,
  body: unknown,
): Promise<Record<string, string>> {
  if (!body || typeof body !== "object") return {};

  const imageIds = extractImageAssetIds(body);
  if (imageIds.length === 0) return {};

  const images = await deps.repos.images.resolveByIds(imageIds);
  const map: Record<string, string> = {};
  for (const img of images) {
    if (img.ownerId === eventId && img.uploadedAt) {
      map[img.id] = img.publicUrl;
    }
  }
  return map;
}

function extractImageAssetIds(body: unknown): string[] {
  const ids = new Set<string>();
  if (!body || typeof body !== "object") return [];

  const bodyObj = body as Record<string, unknown>;

  // v1: sections[].layout.columns[].blocks[]
  if (Array.isArray(bodyObj.sections)) {
    for (const section of bodyObj.sections) {
      const layout = (section as Record<string, unknown>)?.layout as
        | Record<string, unknown>
        | undefined;
      const columns = Array.isArray(layout?.columns)
        ? (layout.columns as Array<Record<string, unknown>>)
        : [];
      for (const col of columns) {
        const blocks = Array.isArray(col?.blocks)
          ? (col.blocks as Array<Record<string, unknown>>)
          : [];
        for (const block of blocks) {
          collectImageId(block, ids);
        }
      }
    }
  }

  // Flat blocks array (v0 body format)
  if (Array.isArray(bodyObj.blocks)) {
    for (const block of bodyObj.blocks) {
      collectImageId(block as Record<string, unknown>, ids);
    }
  }

  return [...ids];
}

function collectImageId(block: unknown, ids: Set<string>): void {
  if (!block || typeof block !== "object") return;
  const b = block as Record<string, unknown>;
  if (b.type !== "image") return;

  const asset = b.asset as Record<string, unknown> | undefined;
  if (asset?.assetId && typeof asset.assetId === "string") {
    ids.add(asset.assetId);
  }
}
