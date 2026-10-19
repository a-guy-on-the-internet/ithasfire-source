// ─────────────────────────────────────────────────────────────────────────────
// Types (pure — no runtime deps)
// ─────────────────────────────────────────────────────────────────────────────

import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";
import type { ReactNode } from "react";

import type { CalendarRecurrence } from "@/lib/calendar/recurrence";
import type { PlatformFeeRateParts } from "@/lib/pricing/fee-rate-label";

import type { TicketTierSellability } from "./ticket-tier-state";

export type EventContentTicketType = {
  id: string;
  name: string;
  priceCents: number;
  /**
   * Pay-what-you-want tier (`ADJUSTABLE`): `priceCents` is then always 0 and
   * the row is quoted "From" its minimum (or its suggestion when there is no
   * minimum) — never "Free". Straight off `listEventTicketTypes`, which has
   * always sent these; optional so a story fixture may omit them.
   */
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  suggestedCents?: number | null;
  /**
   * The AUTHORED capacity column — the tier's configured size, NOT its
   * availability: no write path decrements it.
   */
  capacity: number;
  /**
   * TRUE availability from the server (`capacity - issued - held`), the same
   * basis checkout refuses on. Optional so a story fixture may state only the
   * authored size; the real payload always carries it, and when it is absent
   * the row falls back to `capacity` exactly as it behaved before.
   */
  remainingCapacity?: number;
  /** The server's sold-out verdict (`remainingCapacity <= 0`). */
  soldOut?: boolean;
  /**
   * PER-TIER availability (FR-010), as core resolved it. The reason union is
   * IMPORTED from `ticket-tier-state`, the canonical client-side mirror of
   * core's `TICKET_TYPE_SELLABILITY_REASONS`, rather than re-spelled here: the
   * only consumer of this field is `deriveTicketTierState`, so a private copy
   * could only ever drift away from the function that reads it. (The wire
   * contract in `@/server/events` keeps its own, deliberately stricter copy —
   * non-optional `opensAt`/`closedAt`.)
   *
   * Optional: omitted ⇒ the row renders exactly as it did before FR-010, which
   * is what every unwindowed tier gets anyway.
   *
   * SOLD-OUT IS STILL NOT IN HERE, and still deliberately: the two are
   * separate facts, and a sold-out tier that is also not yet on sale is not a
   * contradiction. What CHANGED is where sold-out comes from — no longer the
   * client's `capacity <= 0` test (the authored column, which no write path
   * decrements, so it was essentially never true) but the server's
   * `soldOut` / `remainingCapacity`, on the same `capacity - issued - held`
   * basis the pre-charge gate refuses on.
   */
  sellability?: TicketTierSellability;
  /** Pending scheduled price change (Q-002). Null/absent once it has passed. */
  upcomingPriceChange?: {
    toPriceCents: number;
    at: Date | string;
  } | null;
};

export type EventContentHuman = {
  id: string;
  name: string;
  role: string;
  /** Custom label when role is "OTHER" (e.g. "Stage Manager"). */
  customRoleLabel?: string | null;
  /** Optional profile image URL. Falls back to initial-letter avatar. */
  imageUrl?: string | null;
  /**
   * Server-derived music URL for this act (lineup-listen-embeds spec).
   * The server ships the URL ONLY — the client re-derives the embed attrs
   * via `parseEmbedUrl` (EpkEmbed discipline; raw iframe src never crosses
   * the wire). Rows render a "Listen" chip iff this parses to an iframe
   * embed client-side. Missing/undefined is treated exactly like null.
   */
  listenUrl?: string | null;
};

/** Per-ticket fee estimate keyed by ticketTypeId */
export type TicketFeeEstimate = {
  platformFeeCents: number;
  processorFeeCents: number;
  taxEstimateCents: number;
  buyerUnitTotalCents: number;
  /** The face the server priced this row at (effective price at its instant). */
  unitPriceCents?: number;
};

export type EventContentLocationCoords = {
  latitude: number;
  longitude: number;
  label?: string | null;
  isExact?: boolean;
  radiusMeters?: number | null;
  areaLabel?: string | null;
};

/**
 * Describes the current ticket-purchasing state for an event.
 *
 * - `on_sale`    — Tickets are available for purchase (default when ticket types exist).
 * - `sold_out`   — All ticket capacity is exhausted.
 * - `coming_soon` — Event is published but no active ticket types exist yet.
 */
export type TicketAvailability = "on_sale" | "sold_out" | "coming_soon";

/**
 * A single published, public date of an event series, used by the buyer-facing
 * date-selection overlay. Structurally matches `PublicSeriesDate` from
 * `@/server/events`.
 */
export type EventContentSeriesDate = {
  occurrenceId: string;
  eventId: string;
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  isCurrent: boolean;
};

export type EventContentProps = {
  title: string;
  /**
   * Organizer name for the plain "Presented by {name}" attribution badge
   * (calm-honest-ux spec FR-003). Rendered as its own row below the
   * title/share row. Hidden entirely when absent — never shown for
   * ownerless COMMUNITY listings.
   */
  organizerName?: string | null;
  /**
   * Internal `/orgs/{slug}` link for the organizer badge. When present, the
   * badge renders as a `Link`; otherwise it renders as plain text. Never an
   * external URL (that's the separate schema.org `organizer.url` used for
   * JSON-LD, not this prop).
   */
  organizerHref?: string | null;
  /**
   * The event's real, absolute self-serve refund deadline (calm-honest-ux
   * spec FR-004), as an ISO datetime — mirrors
   * `GetEventSeoOutput.refundCutoffAt` / `EventRecord.refundCutoffAt`
   * exactly. This is NOT an hours-before-event window; the real backend
   * deadline (`get-refund-eligibility.ts`) is `refundCutoffAt ?? startsAt`.
   * Renders a plain factual line after the tickets/RSVP section:
   * - `undefined` (omitted): section hidden entirely (RSVP/community
   *   listings have no ticketing, so no refund policy applies).
   * - `null`: no organizer override — "Full refund available until this
   *   event starts."
   * - An ISO datetime earlier than `startsAt`: the organizer set a custom,
   *   earlier cutoff — "Full refund available until {formatted date}."
   */
  refundCutoffAt?: string | null;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  location?: string;
  /** Full street address (e.g. "123 Harbor Blvd, San Francisco, CA 94111"). */
  address?: string;
  /**
   * Whether this event's location is published EXACTLY, straight off the
   * server's redacted payload (`event.location.isExact`).
   *
   * This exists because `locationCoords` cannot answer the question: a
   * FULLY-HIDDEN event has no coordinates at all, so `locationCoords` is
   * `undefined` — identical to an exact event whose address was never
   * geocoded. Without this flag the two were indistinguishable, and the
   * fully-hidden one kept rendering a "Copy address" control (it copied the
   * coarse area label under a label promising an address) and would link out
   * to a maps search for any `address` string it was handed.
   *
   * Defaults to TRUE rather than false, knowingly. The public event payload
   * always carries `isExact`, so the default only applies to callers that pass
   * no location block at all (stories, embeds, the builder preview) — and
   * defaulting those closed would strip the copy/maps affordances from every
   * ordinary event that has an address but no coordinates.
   */
  locationIsExact?: boolean;
  /**
   * The venue's ENTITY PAGE slug (`EntityPage.slug`), when the location
   * resolves to a `listedInDirectory` place in its exact/revealed state.
   * When present, renders an internal link to `/places/${placeSlug}`.
   *
   * This is the ONLY slug `/places/[slug]` resolves on. It is NOT `Place.slug`,
   * which is a multi-segment directory key (`us/tn/x--a1b2c3d4e5`) that this
   * single-segment route cannot match — passing that here produced a dead link
   * on every public event page. The server (`buildEventSeo`) emits null when
   * the venue has no entity page, and the render gate below then drops the
   * link entirely rather than pointing at a 404.
   */
  placeSlug?: string;
  /**
   * Display name of the platform venue. Renders the hero "At {venue}" badge
   * beside (or in place of) the "Presented by" organizer badge.
   *
   * INDEPENDENT of `placeSlug`, deliberately. The server sets the name for a
   * venue-confirmed, directory-listed venue, OR (owner ruling 2026-10-06,
   * option B) for an UNCONFIRMED community listing it may name: plain text,
   * no slug, `venueConfirmed` false, and no endorsement implied. `placeSlug`
   * gates whether the badge is also a LINK. A confirmed, directory-listed venue with
   * no EntityPage (every `bulkCreate`-imported one) therefore renders the badge
   * as plain text. Briefly these shared one gate, which silently dropped the
   * venue name — and the schema.org `location.name` — for exactly that
   * population. The location section's "View venue page" CTA still requires
   * `placeSlug`, because without a page there is no page to view.
   */
  venueName?: string | null;
  /**
   * Venue-confirmation spec (docs/specs/2026-08-27): the venue has stamped
   * this event. Renders the "Confirmed by venue" mark inside the "At {venue}"
   * badge — and only there. The server always nulls `placeSlug` on an
   * unconfirmed event, and nulls `name` too EXCEPT on an unconfirmed
   * community listing it may name (owner ruling 2026-10-06): there the name
   * renders as plain text WITHOUT this mark. A present name therefore does
   * not mean confirmed. Never re-gate on this flag.
   */
  venueConfirmed?: boolean;
  heroImageUrl?: string;
  /**
   * The poster's pixel size, read from the file at upload. Set as the `<img>`
   * `width`/`height` attributes, which under the poster CSS (`width: 100%;
   * height: auto`) only feed the UA's `aspect-ratio`: the box is reserved
   * before the bytes land and the final render is unchanged. Absent → the
   * poster renders as before.
   */
  heroImageSize?: { width: number; height: number };
  /**
   * Pre-rendered HTML for the body content.
   * Callers are responsible for converting their body format
   * (ProseMirrorDoc, EventBody, etc.) to HTML before passing it in.
   */
  bodyHtml?: string;
  ticketTypes?: EventContentTicketType[];
  eventHumans?: EventContentHuman[];
  /** The CTA button label. Defaults to "Get tickets". */
  ctaLabel?: string;
  /**
   * Accessible name for the buy control when the visible label is too terse
   * to stand alone. Must contain `ctaLabel` (WCAG 2.5.3, label in name).
   */
  ctaAriaLabel?: string;
  /** The CTA button href. When omitted, the button is not rendered as a link. */
  ctaHref?: string;
  /**
   * When set, the CTA calls this instead of navigating to `ctaHref` — used by
   * series events, where the button opens the date picker overlay. The href is
   * still rendered so the control degrades to a real link without JS.
   */
  onCtaPress?: () => void;
  /** When true, uses mobile-optimised sizes. Defaults to false. */
  mobile?: boolean;
  /**
   * ISO 4217 currency code used for formatting ticket prices.
   * Defaults to `"USD"` when omitted.
   */
  currency?: string;
  /** Location coordinates for the map preview. When provided, a map is rendered. */
  locationCoords?: EventContentLocationCoords;
  /** When provided, renders an "Edit Event" button linking to the admin edit page. */
  editHref?: string;
  /**
   * When true, the hero zone (back link, poster, title, organizer badge,
   * rating line, meta row) renders as an immersive light-on-dark surface: a
   * deterministic dark scrim backs the floating hero text so it stays legible
   * over the blurred `HeroBackdrop` poster regardless of the poster's colours.
   * ONLY the public event page (which mounts `HeroBackdrop`) sets this — embeds
   * and the admin preview render on their own light surface and leave it false,
   * keeping the classic dark-ink-on-light hero. Below-fold content is never
   * affected. Defaults to false.
   */
  immersiveHero?: boolean;
  /** When provided, renders a back arrow at the top. Defaults to "/events". */
  backHref?: string;
  /** Label for the back link. Defaults to "Explore events". */
  backLabel?: string;
  /**
   * Ticket availability state for this event.
   * Controls CTA button visibility and ticket section messaging.
   * Defaults to `"on_sale"` when omitted.
   */
  ticketAvailability?: TicketAvailability;
  /** Fee mode for this event — "ABSORB" (organizer pays) or "PASS_THROUGH" (buyer pays). */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  /** Per-ticket fee estimates, keyed by ticketTypeId. */
  feeEstimateMap?: Record<string, TicketFeeEstimate>;
  /**
   * The tax rate the fee tooltip prints, in basis points (975 ⇒ "9.75%") —
   * `taxRateLabelBps(feeRates.taxImpositions)`. Null = no rate shown (no tax,
   * or tax lines on different bases); the tax amount still shows.
   */
  admissionTaxRateBps?: number | null;
  /** Human-readable platform fee label, e.g. "6.5%". */
  platformFeeLabel?: string | null;
  /** Per-ticket fee policy (pct, cap, floor, fixed) for the capped fee label. */
  platformFeeRates?: PlatformFeeRateParts | null;
  /** Human-readable processor fee label, e.g. "2.9% + $0.30". */
  processorFeeLabel?: string | null;
  /** Tags associated with the event. Rendered as small chips below the body content. */
  tags?: Array<{ slug: string; name: string }>;
  /**
   * When true, the component renders as an admin preview and always
   * shows the location map — even for obscured (fuzzed or fully-hidden)
   * events.
   */
  isAdminPreview?: boolean;
  /**
   * Optional header action rendered beside the share button (e.g. the
   * Save/Saved toggle on the public event page). Omitted for embeds and
   * admin previews.
   */
  saveAction?: ReactNode;
  /**
   * Quiet verified-attendee rating line rendered directly under the "Presented
   * by" organizer attribution (attendee-reviews FR-005c). Renders nothing until
   * a publishable aggregate exists. Public event page only — omitted for embeds
   * and admin previews.
   */
  organizerRating?: ReactNode;
  /**
   * Primary attendance action for RSVP (community) events — rendered as its
   * own "Going?" section where the tickets section would sit. When set, the
   * tickets section is never rendered (RSVP events have no ticket types by
   * design; this is defense-in-depth).
   */
  rsvpAction?: ReactNode;
  /**
   * Heading for the RSVP section. Defaults to the "Going?" label; recurring
   * community listings pass "Upcoming dates" since the section renders a
   * per-date list rather than a single toggle.
   */
  rsvpSectionTitle?: string;
  /**
   * Host attribution for ownerless COMMUNITY listings — rendered in the
   * lineup/organizer slot (community listings have no organizer to show).
   */
  communityAttribution?: ReactNode;
  /**
   * De-emphasized footer content for COMMUNITY listings — rendered at the
   * very end of the left column (e.g. the "apply to moderate" recruitment
   * band), kept quiet and out of the way of the primary content.
   */
  communityFooter?: ReactNode;
  /**
   * Sections the PAGE owns that render after the event body (volunteer
   * shifts, the resale market). Threaded in rather than rendered beside the
   * article so that, poster-first, they flow in the decision column with
   * everything else instead of starting a third left edge under the grid.
   */
  belowContent?: ReactNode;
  /**
   * A status or sellability notice renders ABOVE this component (EventDetail
   * owns them). Poster-first, the band and the full-bleed poster climb back
   * over the shell's top padding to start under the navbar — with a notice
   * there instead, that climb would paint 0.62 black over its bottom edge.
   * MEASURED by review before this: a DRAFT preview at 1440 lost the banner's
   * bottom rule and 16px of its body under the band. True → no climb.
   */
  heroFollowsNotice?: boolean;
  /**
   * The recurring listing's cadence, for the calendar EXPORT (the on-page
   * cadence line is `CommunityDateList`'s own `recurrence` prop). With it,
   * "Add to calendar" hands over a repeating entry instead of one appointment
   * on the next date. `null` / absent keeps the single-event export byte for
   * byte — see `lib/calendar/recurrence.ts` for what it refuses to state.
   */
  communityRecurrence?: CalendarRecurrence | null;
  /**
   * Render the COMMUNITY listing layout instead of the ticketed one.
   *
   * Set ONLY for a COMMUNITY-stewardship listing in RSVP attendance mode (see
   * `EventDetail`). Everything else — including a hypothetical COMMUNITY
   * listing that carries ticket types — leaves it false and renders exactly as
   * it does today; that is a hard requirement, not a nicety.
   *
   * What it changes (docs/design/design-system-v2.md §8, and a 390x844
   * measurement showing the listing's own prose starting 69% down the page):
   *
   * - The description moves directly under the head.
   * - The numbered "Schedule" and "Location" sections collapse into one
   *   unnumbered WHERE / ENDS / LISTED BY fact block. Index numerals encode a
   *   sequence; three facts are not a sequence. Ticketed events keep theirs.
   * - Desktop becomes a two-track grid with a sticky rail carrying the facts,
   *   the map and the navigation actions, replacing a right column that held
   *   a ~300px map and then ~500px of nothing.
   * - With NO poster, the Date Stub is promoted from decoration to the page
   *   head and carries the title and venue line; the separate `<h1>` +
   *   attribution + meta stack is dropped, because each of its facts is then
   *   printed once in the head.
   * - With a poster, the head is UNCHANGED: `immersiveHero`, `HeroBackdrop`
   *   and the scrim treatment of the title/meta all behave exactly as today.
   */
  communityLayout?: boolean;
  // ── Notify Me ─────────────────────────────────────────────────────────────
  /** Event ID needed for the notify-me sign-up mutation. */
  eventId?: string;
  // ── Arrival areas ─────────────────────────────────────────────────────────
  /**
   * Parking, accessible drop-off and load-in this viewer may see
   * (arrival-areas FR-006): drawn on the location map and listed under the
   * address as "Getting there". Passed ONLY by the public event page; the
   * embed and the admin preview never pass it (NFR-002).
   */
  arrivalAreas?: readonly VisibleArrivalArea[];
  /** When true, the notify-me sign-up form is visible. */
  waitlistOpen?: boolean;
  /** Optional organizer-provided description displayed above the sign-up form. */
  waitlistDescription?: string | null;
};
