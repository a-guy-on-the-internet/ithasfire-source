import type { EventStatus } from "../repos/events";

export type SeoOfferAvailability =
  | "in_stock"
  | "limited"
  | "sold_out"
  | "preorder";

export interface SeoLocationInput {
  name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Whether the coordinates represent the exact venue location. */
  isExact?: boolean;
  /** Radius in meters for the approximate circle (only when isExact is false). */
  radiusMeters?: number | null;
  /** Human-readable area label (only when isExact is false). */
  areaLabel?: string | null;
  /**
   * Slug of the linked, directory-listed Place — only populated when the
   * location is in its exact/revealed state (see `buildEventSeo`).
   */
  placeSlug?: string | null;
}

export interface SeoOrganizerInput {
  name?: string | null;
  url?: string | null;
}

export interface SeoPricingInput {
  currency: string;
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  minBuyerTotalCents?: number | null;
  maxBuyerTotalCents?: number | null;
  availability?: SeoOfferAvailability | null;
  validFrom?: Date | null;
}

export interface SeoPerformer {
  eventHumanId: string;
  name: string;
  role: string;
  url?: string;
}

export interface SeoEventInput {
  event: {
    id: string;
    slug: string;
    title: string;
    description?: string | null;
    startsAt: Date;
    endsAt?: Date | null;
    status: EventStatus;
    updatedAt?: Date | null;
    /**
     * schema.org Event subtype for the JSON-LD `@type`, resolved from the
     * event's category (`Category.seoType`). Validated against the shared
     * allowlist at the sink; an unknown/absent value falls back to `Event`.
     */
    seoType?: string | null;
    /** When the event went live; see {@link SeoEvent.publishedAt}. */
    publishedAt?: Date | null;
  };
  canonicalUrl: string;
  ticketingUrl?: string | null;
  images?: Iterable<string | null | undefined> | null;
  location?: SeoLocationInput | null;
  organizer?: SeoOrganizerInput | null;
  pricing?: SeoPricingInput | null;
  performers?: SeoPerformer[] | null;
}

export interface SeoLocation {
  name?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  /** Whether the coordinates represent the exact venue location. */
  isExact?: boolean;
  /** Radius in meters for the approximate circle (only when isExact is false). */
  radiusMeters?: number | null;
  /** Human-readable area label (only when isExact is false). */
  areaLabel?: string | null;
  /**
   * Slug of the linked, directory-listed Place — only populated when the
   * location is in its exact/revealed state (see `buildEventSeo`).
   */
  placeSlug?: string | null;
}

export interface SeoOrganizer {
  name?: string;
  url?: string;
}

export interface SeoPricing {
  currency: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  minBuyerTotalCents?: number;
  maxBuyerTotalCents?: number;
  availability: SeoOfferAvailability;
  validFrom?: Date | null;
}

export interface SeoEvent {
  id: string;
  slug: string;
  url: string;
  name: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  addressRevealAt?: Date | null;
  timezone?: string | null;
  viewerHasTicket?: boolean;
  status: EventStatus;
  updatedAt?: Date | null;
  /**
   * When the event went live. The fallback `Offer.validFrom` in the JSON-LD
   * when `pricing.validFrom` is absent (an RSVP listing has no pricing block,
   * and its free Offer has been available since it went live). Optional:
   * an event built without it emits no `validFrom` when its pricing has none
   * either.
   */
  publishedAt?: Date | null;
  /**
   * schema.org Event subtype for the JSON-LD `@type` (e.g. `MusicEvent`),
   * data-driven per category. `buildEventJsonLd` emits it when it is a known
   * subtype (see `isValidEventSchemaType`), else falls back to `Event`.
   */
  seoType?: string | null;
  /**
   * Display name of the event's category (e.g. "Open Mic"), used in the
   * description fallback. Not mapped by `mapEventToSeo`; the caller adds it.
   */
  categoryName?: string | null;
  ticketingUrl?: string | null;
  images: string[];
  location?: SeoLocation;
  organizer?: SeoOrganizer;
  pricing?: SeoPricing;
  performers: SeoPerformer[];
}

// ── Place SEO types ──────────────────────────────────────────────────────────

export interface SeoPlace {
  placeId: string;
  url: string;
  name: string;
  /**
   * MUST ALREADY BE REDACTED. Every producer of this shape reads a core use
   * case (`getPlacePublic` / `loadEntitySummary`) that runs the row through
   * `redactPlaceLocation` first, so a venue that withholds its address arrives
   * here with nulls. Do NOT build one of these straight off a `PlaceRecord`.
   */
  formattedAddress?: string | null;
  city?: string | null;
  region?: string | null;
  countryCode?: string | null;
  /**
   * True pin for an EXACT venue, obfuscated circle CENTRE for a withheld one
   * with a radius, absent/null when fully hidden. Read together with
   * {@link SeoPlace.isExact}: `buildPlaceJsonLd` emits a `GeoCircle` rather
   * than sharp `GeoCoordinates` when this is not an exact point.
   */
  lat?: number | null;
  lng?: number | null;
  /**
   * False when the venue withholds its address.
   *
   * DEFAULTS TO EXACT WHEN OMITTED, and that is on purpose rather than an
   * oversight: this flag is a RENDERING hint (pin vs circle), not the privacy
   * gate. The gate is upstream — a withheld venue reaches this type with a
   * null `formattedAddress` and either an offset centre or no coordinates at
   * all, so `buildPlaceJsonLd` emits nothing sensitive even for a caller that
   * never sets this. Making it default-closed would instead have silently
   * turned every existing EXACT venue's JSON-LD into a GeoCircle.
   */
  isExact?: boolean;
  /** Circle radius in metres; emitted as `geoRadius` on the GeoCircle. */
  radiusMeters?: number | null;
  capacity?: number | null;
}
