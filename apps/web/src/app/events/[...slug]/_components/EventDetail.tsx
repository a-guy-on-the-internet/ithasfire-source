"use client";

import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import type { EventBody } from "@th/schema";
import type { SeoEvent } from "@th/types/seo/types";
import type { EventStatus } from "@th/types";
import { useTranslations } from "@th/ui";

import { EventContent } from "@/components/events/EventContent";
import { isPosterFirstLayout } from "@/components/events/poster-first-layout";
import type { TicketAvailability } from "@/components/events/EventContent";
import type { EventContentSeriesDate } from "@/components/events/event-content-types";
import { eventBodyToHtml } from "@/components/events/event-body-to-html";
import { captureAttribution } from "@/lib/attribution";
import { taxRateLabelBps } from "@/lib/pricing/tax-rate-label";
import type { AudioUrlMapEntry } from "@/app/admin/[slug]/events/new/_components/prose-editor";
import type { PublicAudioItem } from "@/server/events";
import type {
  PublicTicketType,
  PublicEventHuman,
  PublicFeeRates,
  PublicEventTag,
  CommunityEventDate,
  CommunityRecurrenceSummary,
} from "@/server/events";
import { SaveButton } from "@/components/saves/SaveButton";
import { RsvpButton } from "@/components/community/RsvpButton";
import { CommunityDateList } from "@/components/community/CommunityDateList";
import { composeEventAddress } from "@/lib/location/compose-address";
import { readableDateIso, readableIso } from "@/lib/readable-date";
import { CommunityListingNotice } from "@/components/community/CommunityListingNotice";
import { BecomeModeratorCta } from "@/components/community/BecomeModeratorCta";
import { usePagePrimaryAction } from "@/components/navigation/page-primary-action";
import { useScrolledPast } from "@/components/events/use-scrolled-past";
import { useMinViewportWidth } from "@/hooks/useMinViewportWidth";
import { EventRatingLine } from "./EventRatingLine";
import { SeriesTicketDatePicker } from "./SeriesTicketDatePicker";
import { deriveEventDetailMode } from "./event-detail.helpers";
import type {
  EventAttendanceMode,
  EventSellabilityReason,
  EventStewardship,
} from "./event-detail.helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EventDetailProps = {
  event: SeoEvent;
  /**
   * Plain "Presented by {name}" attribution (calm-honest-ux FR-003) — the
   * event's own org name/slug, separate from any schema.org data on
   * `event`. Hidden when absent (ownerless COMMUNITY listings).
   */
  organizerName?: string | null;
  /** Internal `/orgs/{slug}` link for the organizer badge — never external. */
  organizerHref?: string | null;
  /**
   * Pixel size of `event.images[0]`, so the poster reserves its box before
   * it loads. Null/absent renders the poster exactly as before.
   */
  heroImageSize?: { width: number; height: number } | null;
  /**
   * The venue stamped this event (venue-confirmation spec). Adds the
   * "Confirmed by venue" mark to the "At {venue}" badge; nothing else keys on
   * it — the server decides the rest: `location.placeSlug` is null when
   * unconfirmed, and `location.name` may still be set as plain text for an
   * unconfirmed community listing (owner ruling 2026-10-06; no endorsement).
   */
  venueConfirmed?: boolean;
  /**
   * Real, absolute self-serve refund deadline (calm-honest-ux FR-004), as an
   * ISO datetime — mirrors `EventRecord.refundCutoffAt` /
   * `GetEventSeoOutput.refundCutoffAt` exactly. `null` means the organizer
   * never overrode it (the enforced deadline then defaults to the event's
   * own `startsAt` — see `get-refund-eligibility.ts`). Omitted/undefined for
   * RSVP/community listings (no ticketing, no refund policy to disclose) —
   * `EventDetail` still enforces that hiding rule itself via `mode.isRsvp`,
   * so callers don't have to.
   */
  refundCutoffAt?: string | null;
  bodyContent: unknown;
  imageMap?: Record<string, string>;
  /** Resolved audio uploads from the server (for the custom player). */
  audioItems?: PublicAudioItem[];
  ticketTypes?: PublicTicketType[];
  eventHumans?: PublicEventHuman[];
  /** Fee rate estimates from the server. */
  feeRates?: PublicFeeRates;
  /** Tags assigned to the event. */
  tags?: PublicEventTag[];
  /** If set, renders an "Edit Event" shortcut button. */
  editHref?: string;
  /** Back-navigation link (e.g. "/events"). */
  backHref?: string;
  /** Label shown next to back arrow. */
  backLabel?: string;
  /** When true, uses mobile-optimised sizes (e.g. embeds). */
  mobile?: boolean;
  /**
   * When true, the hero renders as the immersive light-on-dark surface used by
   * the public event page (which mounts `HeroBackdrop`). Threads down to
   * `EventContent` and flips the hero chrome (Save/Share/rating) + status
   * banners to their on-dark treatment. Embeds and the admin preview leave it
   * false. Defaults to false.
   */
  immersiveHero?: boolean;
  /** When true, the "Get tickets" CTA and sticky bar are suppressed. */
  hideTicketCta?: boolean;
  /** Ticket-holder view of a hidden event: neutral "sales paused" notice. */
  holderView?: boolean;
  /**
   * Why the CTA is hidden, if it is. Only the organizer-side reasons render
   * a user-facing notice; "free" and "ok" are mutually exclusive with
   * `hideTicketCta` so they don't need handling here.
   */
  sellabilityReason?: EventSellabilityReason;
  // ── Notify Me ────────────────────────────────────────────────────────────
  /** Event UUID (used by the notify-me sign-up form). */
  eventId?: string;
  /** When true, the notify-me form is visible. */
  waitlistOpen?: boolean;
  /** Organizer-provided blurb for the notify-me form. */
  waitlistDescription?: string | null;
  /** Published sibling dates when this event belongs to a series. */
  seriesDates?: EventContentSeriesDate[];
  /**
   * Renders the Save/Saved toggle in the header (public event page only —
   * embeds live on third-party sites where the sign-in redirect is wrong).
   */
  showSaveAction?: boolean;
  // ── Community listings ────────────────────────────────────────────────────
  /**
   * TICKETED (default) renders the tickets path; RSVP renders the personal
   * "I'm going" toggle and suppresses ALL ticketed UI — including the
   * organizer-facing sellability banners (RSVP events have no payee by
   * design, so "no_payee" is their normal state, not a problem).
   */
  attendanceMode?: EventAttendanceMode;
  /** COMMUNITY renders the "community-maintained listing" attribution. */
  stewardship?: EventStewardship;
  /**
   * The event's lifecycle status. When it is not PUBLISHED (CANCELLED /
   * ARCHIVED / COMPLETED / DRAFT), a status banner is shown at the top so
   * the page never reads as a live event. DRAFT is a deliberate render:
   * it's the organizer's live draft preview (event-builder FR-204/D4 —
   * noindexed, reachable only by link) and gets "draft preview" copy.
   * Independent of the ticketed/RSVP branch, so cancelled community
   * listings surface it too.
   */
  eventStatus?: EventStatus;
  /** Server-known viewer RSVP state (seed for the toggle; never a count). */
  viewerRsvped?: boolean;
  /**
   * Upcoming SCHEDULED dates for a RECURRING community listing. When non-empty
   * (recurring), the per-date "Upcoming dates" list replaces the single RSVP
   * toggle. EMPTY for single-date listings (unchanged behavior).
   */
  communityDates?: CommunityEventDate[];
  /**
   * The recurrence rule behind `communityDates`, summarised — lets the list
   * lead with the cadence ("Every Wednesday, 8:00 PM") instead of enumerating
   * all 52 rows. Pure decoration for a list that already renders: `undefined` /
   * `null` simply means no cadence line. Never gates the list.
   */
  communityRecurrence?: CommunityRecurrenceSummary | null;
  /**
   * `communityDates` stops SHORT of the end of the series. Server-computed: the
   * list is capped both by the API's row limit and by how far ahead occurrences
   * are materialised, and neither cap is visible from here — so the list must be
   * told, or it states the last row it holds as the organizer's last date.
   * Defaults to `false` (treat the list as complete) for the non-recurring and
   * legacy-caller cases.
   */
  communityDatesTruncated?: boolean;
  /**
   * The occurrence the schedule section leads with — the first upcoming one
   * still SCHEDULED, `null` when every upcoming night is called off. Seeds the
   * list; `communityDates[0]` is not a substitute (a called-off night sorts
   * first like any other).
   */
  communityNextScheduledDateId?: string | null;
  /**
   * The listing is driven by a stored recurrence rule.
   *
   * GATES THE BRANCH BELOW, and it is the whole reason this prop exists: a
   * recurring listing must NEVER fall back to the single event-level
   * `RsvpButton`, because a drained series' `Event.startsAt` is a past or
   * synthetic instant — the button then offers "I'm going" on a night that
   * already happened. Not derivable from `communityRecurrence` (null for
   * FIXED_DATES and unphrasable rules, both series) nor from
   * `communityDates.length` (a drained series has none).
   */
  communityHasRecurrenceRule?: boolean;
  /**
   * Target of the "Suggest an edit" CTA. Surfaces as an in-body link beside
   * the community byline (`CommunityListingNotice` → `event-suggest-edit-btn`),
   * which is the only place on the page that frames the listing as
   * community-run. It rode the action bar until 2026-08-28.
   * Only passed for COMMUNITY published PUBLIC events — the caller gates
   * visibility, and the backend rejects OWNED suggestions outright
   * (community-listings-only as of 2026-07-20).
   */
  suggestEditHref?: string;
  /**
   * Sections the page owns that render after the event body (volunteer
   * shifts, the resale market). Threaded through to `EventContent` so that,
   * poster-first, they flow in the decision column rather than under it.
   */
  belowContent?: ReactNode;
  /** Arrival areas for this viewer (arrival-areas FR-006). Public page only. */
  arrivalAreas?: readonly VisibleArrivalArea[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
//
// Thin adapter: converts server-side SeoEvent + EventBody data into the flat
// props that EventContent expects, so the public page renders identically to
// the admin EventPreview.
// ─────────────────────────────────────────────────────────────────────────────

export function EventDetail({
  event,
  organizerName,
  organizerHref,
  heroImageSize,
  refundCutoffAt: refundCutoffAtProp,
  venueConfirmed = false,
  bodyContent,
  imageMap = {},
  audioItems = [],
  ticketTypes = [],
  eventHumans = [],
  feeRates,
  tags = [],
  editHref,
  backHref,
  backLabel,
  mobile,
  immersiveHero = false,
  hideTicketCta,
  holderView = false,
  sellabilityReason,
  eventId,
  waitlistOpen = false,
  waitlistDescription,
  seriesDates = [],
  showSaveAction = false,
  attendanceMode = "TICKETED",
  stewardship = "OWNED",
  viewerRsvped,
  communityDates = [],
  communityRecurrence,
  communityDatesTruncated = false,
  communityNextScheduledDateId = null,
  communityHasRecurrenceRule = false,
  suggestEditHref,
  eventStatus,
  belowContent,
  arrivalAreas,
}: EventDetailProps) {
  const t = useTranslations();
  const searchParams = useSearchParams();

  // Focus the page heading right after a successful password unlock.
  // The gate wrapper sets a session flag before `router.refresh()` —
  // without this jump, keyboard users land in nowhere-land when the
  // gate disappears and the full detail mounts.
  useEffect(() => {
    if (!eventId) return;
    const flagKey = `th-event-just-unlocked:${eventId}`;
    try {
      if (sessionStorage.getItem(flagKey) !== "1") return;
    } catch {
      return;
    }
    // Defer to the next paint so the headline is mounted.
    const id = requestAnimationFrame(() => {
      // Consumed HERE, not above: the cleanup cancels this frame, so under
      // StrictMode's double-invoke a flag removed in the effect body was gone
      // before the second run, which then bailed — no focus at all.
      try {
        sessionStorage.removeItem(flagKey);
      } catch {
        // sessionStorage may be unavailable (private window quirks).
      }
      // The shell's main region is `<div role="main">` (AppShell), not a
      // <main> element, so `main h1` alone never matched and the handoff
      // silently did nothing (measured: focus stayed on <body>).
      const heading = document.querySelector<HTMLHeadingElement>(
        'main h1, [role="main"] h1',
      );
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
        // No scroll: on a phone the h1 sits below the full-bleed poster, and
        // scrolling to it mid-reveal yanked the page away from the poster the
        // Door's photo had just turned into. Focus is the handoff; the next
        // Tab brings whatever it lands on into view.
        heading.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [eventId]);

  // Capture ref/UTM attribution params from the URL on initial load
  useEffect(() => {
    const ref = searchParams.get("ref");
    const utmSource = searchParams.get("utm_source");
    const utmMedium = searchParams.get("utm_medium");
    const utmCampaign = searchParams.get("utm_campaign");

    if (ref || utmSource || utmMedium || utmCampaign) {
      captureAttribution({
        ref: ref ?? undefined,
        utmSource: utmSource ?? undefined,
        utmMedium: utmMedium ?? undefined,
        utmCampaign: utmCampaign ?? undefined,
        eventSlug: event.slug,
        capturedAt: new Date().toISOString(),
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build audio URL map from server-provided data (no client roundtrip).
  // Stabilize with JSON key so query retries don't regenerate the map.
  const audioKey = useMemo(
    () => audioItems.map((a) => `${a.id}:${a.hlsPlaylistUrl ?? ""}`).join("|"),
    [audioItems],
  );
  const audioUrlMap = useMemo(() => {
    const map: Record<string, AudioUrlMapEntry> = {};
    for (const item of audioItems) {
      map[item.id] = {
        hlsPlaylistUrl: item.hlsPlaylistUrl,
        sourceUrl: item.sourceUrl,
        status: item.status,
        waveformPeaks: item.waveformPeaks,
      };
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKey]);

  const bodyHtml = useMemo(
    () =>
      eventBodyToHtml(bodyContent as EventBody | null, imageMap, audioUrlMap),
    [bodyContent, imageMap, audioUrlMap],
  );

  // The "At {venue}" hero badge renders whenever the server sends a venue
  // NAME — with or without a link (`placeSlug` only decides whether the badge
  // is clickable; see build-event-seo.ts, which gates the two separately). So
  // whenever the badge shows, the meta row keeps the complementary
  // city/region text instead of repeating the venue name two lines below it.
  const venueBadgeShown = Boolean(event.location?.name);
  const locationLabel =
    event.location?.areaLabel ??
    (venueBadgeShown ? undefined : event.location?.name) ??
    ([event.location?.city, event.location?.region]
      .filter(Boolean)
      .join(", ") ||
      undefined);

  // Calm pre-reveal notice for OBSCURED events (both the obfuscated-circle
  // and fully-hidden variants render `isExact: false` pre-reveal). Shown to
  // every viewer — the copy already scopes the reveal to ticket holders (or,
  // on an RSVP listing, to people who RSVP'd) — so
  // a fully-hidden event page (no map, area label only) still explains when
  // the address arrives. Post-reveal ticket holders get `isExact: true` from
  // the server and the notice disappears. Deliberately plain: no countdowns
  // or urgency styling.
  const revealNotice =
    event.location?.isExact === false &&
    event.addressRevealAt &&
    event.addressRevealAt.getTime() > Date.now()
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          ...(event.timezone ? { timeZone: event.timezone } : {}),
        }).format(event.addressRevealAt)
      : null;

  // Build a full display address from the location fields.
  //
  // `composeEventAddress`, not a plain join: `addressLine1` is fed from
  // `Event.addressText`, which for an imported listing is the WHOLE address
  // already. Joining blindly printed the city and region twice — the shipped
  // "115 27th Ave N, Nashville, TN, Nashville, TN, 37203, US".
  const address = composeEventAddress({
    addressText: event.location?.addressLine1,
    addressLine2: event.location?.addressLine2,
    locality: event.location?.city,
    region: event.location?.region,
    postalCode: event.location?.postalCode,
    countryCode: event.location?.countryCode,
  });

  // ── RSVP vs ticketed branch (community-managed listings) ─────────────────
  // The attendanceMode branch takes precedence over sellability: an RSVP
  // event's "no_payee" reason is by design, never an organizer problem.
  const mode = deriveEventDetailMode({
    attendanceMode,
    hideTicketCta,
    sellabilityReason,
  });

  /*
   * A recurring community listing surfaces the "Upcoming dates" schedule
   * instead of the single "I'm going" toggle.
   *
   * `communityHasRecurrenceRule` is checked FIRST and independently of the row
   * count, because the row count reaching zero is exactly the case the rule
   * exists for. A weekly open mic whose materialised dates have all passed (or
   * have all been called off) has a rule and no rows — and the old
   * `communityDates.length > 0` test sent it to `RsvpButton`, which RSVPs to
   * `Event.startsAt`: a night that already happened. The schedule section
   * handles the empty case itself, stating either "next dates are being
   * scheduled" or "this series has ended".
   *
   * No rule and no dates → an ordinary single-date listing, unchanged.
   */
  const isRecurringRsvp =
    mode.isRsvp &&
    Boolean(eventId) &&
    (communityHasRecurrenceRule || communityDates.length > 0);

  // Plain refund-policy disclosure (calm-honest-ux FR-004): the real
  // enforced deadline is `event.refundCutoffAt ?? event.startsAt` (an
  // absolute, organizer-settable datetime — see get-refund-eligibility.ts),
  // NOT an hours-before-event window. `null` here means "no organizer
  // override" (EventContent renders the true default: "until this event
  // starts"). RSVP/community listings have no ticketing, hence no refund
  // policy to disclose — `undefined` hides the section entirely.
  const refundCutoffAt = mode.isRsvp ? undefined : (refundCutoffAtProp ?? null);

  // ── Derive ticket availability ──────────────────────────────────────────
  let ticketAvailability: TicketAvailability = "on_sale";
  if (ticketTypes.length === 0) {
    ticketAvailability = "coming_soon";
  } else if (
    // Sold out when NOTHING is left across every tier. Reads the SERVER's
    // count (`capacity - issued - held`), not the authored `capacity` column —
    // that column never moves, so this branch was effectively unreachable and
    // the page kept sending buyers to a checkout that would refuse them.
    ticketTypes.every((tt) => tt.soldOut ?? tt.remainingCapacity <= 0)
  ) {
    ticketAvailability = "sold_out";
  }

  // When tickets aren't on sale, suppress the checkout link entirely.
  // Also suppress when the caller explicitly hides the CTA (e.g. embeds
  // that render their own inline ticket selector below EventContent).
  const effectiveCtaHref = mode.hideTicketCta
    ? undefined
    : ticketAvailability === "on_sale"
      ? (event.ticketingUrl ?? `/events/checkout/${event.slug}`)
      : undefined;

  // Series events: the Get-tickets button opens the date picker instead of
  // navigating, so the page owns that overlay's open state. (Both used to be
  // coupled through the floating action bar, removed 2026-08-27.)
  const [seriesPickerOpen, setSeriesPickerOpen] = useState(false);
  // Only dates a buyer can read count: the picker leaves an unreadable one
  // out, so a series with fewer than two readable dates gets the plain
  // checkout link a single-date event has, never a picker with nothing in it.
  const readableSeriesDates = useMemo(
    () => seriesDates.filter((d) => readableIso(d.startsAt)),
    [seriesDates],
  );
  const seriesPickerUsable =
    !mode.hideTicketCta &&
    ticketAvailability === "on_sale" &&
    readableSeriesDates.length >= 2;

  // ── Mobile bottom-nav primary ────────────────────────────────────────────
  // Below 960px the shell's bottom bar carries ONE page action in its raised
  // centre slot; on an event that is "Get tickets". Same behaviour as the
  // inline `event-get-tickets-btn`, series-picker branch included, so the two
  // can never disagree — the difference is only that the bar's copy stays
  // reachable after a long scroll.
  const router = useRouter();
  const handleMobileGetTickets = useCallback(() => {
    if (seriesPickerUsable) {
      setSeriesPickerOpen(true);
      return;
    }
    if (!effectiveCtaHref) return;
    // `event.ticketingUrl` can point off-platform; the inline CTA is a plain
    // <a> there, so the router (client-side only) would silently do nothing.
    if (/^https?:\/\//i.test(effectiveCtaHref)) {
      window.location.href = effectiveCtaHref;
      return;
    }
    router.push(effectiveCtaHref);
  }, [effectiveCtaHref, router, seriesPickerUsable]);

  // The hero carries its own "Get tickets" now, so the nav's raised square is
  // a DUPLICATE while that button is on screen — measured at 390px, the two sat
  // about 60px apart doing the identical thing. Hand the action over only once
  // the hero button has scrolled away, which is also the case the nav is
  // genuinely useful for: a 3,400px page the reader is halfway down.
  const heroCtaGone = useScrolledPast('[data-testid="event-hero-get-tickets-btn"]');

  // The poster-first page — the SAME rule EventContent applies, so the
  // things this component owns around it (the rail's Save button, the nav's
  // centre action) can never disagree with the layout it is rendering.
  // `isAdminPreview` is never passed from here.
  const posterFirst = isPosterFirstLayout({
    heroImageUrl: event.images?.[0],
    mobile,
    communityLayout: stewardship === "COMMUNITY" && mode.isRsvp,
  });
  // Below 768px the poster-first page docks its OWN price bar at the bottom
  // of the screen (`.event-sticky-bar`), always on screen. The nav's raised
  // square would be a second "Get tickets" a few pixels above it — so the nav
  // stands down there. 768 is the layout's own threshold (event-content.css);
  // from it up to the nav's 960 the buy band scrolls away like any in-page
  // button and the nav takes over as before.
  const wideEnoughForBuyBand = useMinViewportWidth(768);
  const dockedBarOnScreen = posterFirst && !wideEnoughForBuyBand;

  usePagePrimaryAction({
    // Its own key: in es `common.getTickets` is the short "Entradas", the same
    // visible text as the bottom nav's my-tickets tab. The raised square sits
    // in that bar, so it shows the longer "Obtener entradas" instead. The
    // page's buy controls keep "Entradas" visible and take this key as their
    // accessible name (`ctaAriaLabel` below).
    label: String(t("common.navGetTickets")),
    onPress: handleMobileGetTickets,
    // Mirrors EventContent's own render gate for the CTA: never on RSVP
    // listings, never when the caller hid the CTA, never when tickets are off
    // sale (all three collapse into `effectiveCtaHref`).
    enabled:
      !mode.isRsvp &&
      Boolean(effectiveCtaHref) &&
      heroCtaGone &&
      !dockedBarOnScreen,
  });

  // Build per-ticket fee map for EventContent
  const feeEstimateMap = feeRates?.perTicketEstimates
    ? Object.fromEntries(
        feeRates.perTicketEstimates.map((e) => [
          e.ticketTypeId,
          {
            platformFeeCents: e.platformFeeCents,
            processorFeeCents: e.processorFeeCents,
            taxEstimateCents: e.taxEstimateCents,
            buyerUnitTotalCents: e.buyerUnitTotalCents,
            unitPriceCents: e.unitPriceCents,
          },
        ]),
      )
    : undefined;

  // Non-PUBLISHED public pages show a status banner at the very top so the
  // page never reads as a live event. CANCELLED gets the loud danger tone;
  // ARCHIVED / COMPLETED get a muted "unavailable" tone. DRAFT gets its own
  // "draft preview" copy — this render IS the organizer-facing preview
  // (event-builder regroup FR-204/D4: the builder's Preview action opens the
  // live draft page in a new tab), so "no longer available" would read as an
  // error to the person previewing their own unpublished event.
  // Independent of the ticketed/RSVP branch on purpose — a taken-down
  // (CANCELLED) community listing must surface this too.
  const statusBanner =
    eventStatus === "CANCELLED"
      ? {
          tone: "danger" as const,
          title: String(t("eventDetail.statusBanner.cancelledTitle")),
          body: String(t("eventDetail.statusBanner.cancelledBody")),
        }
      : eventStatus === "COMPLETED"
        ? {
            tone: "muted" as const,
            title: String(t("eventDetail.statusBanner.completedTitle")),
            body: String(t("eventDetail.statusBanner.completedBody")),
          }
        : eventStatus === "DRAFT"
          ? {
              tone: "muted" as const,
              title: String(t("eventDetail.statusBanner.draftTitle")),
              body: String(t("eventDetail.statusBanner.draftBody")),
            }
          : eventStatus === "ARCHIVED"
            ? {
                tone: "muted" as const,
                title: String(t("eventDetail.statusBanner.archivedTitle")),
                body: String(t("eventDetail.statusBanner.archivedBody")),
              }
            : null;

  // On the immersive public hero the banners sit over the blurred backdrop,
  // where their near-transparent tints leave the dark ink illegible. Make them
  // opaque cream cards there so they read as self-contained notices; their
  // (danger/muted/accent) left borders still carry the tone. Off the immersive
  // hero (embeds, admin) they keep their original translucent tint.
  const bannerBackground = (tint: string) =>
    immersiveHero ? "var(--surface, #FDFAF3)" : tint;

  return (
    <>
      {/*
        Series events (>= 2 published dates) open this overlay instead of
        navigating — both the inline `event-get-tickets-btn` (via `onCtaPress`)
        and the mobile bottom bar's centre action route through
        `seriesPickerOpen`. With fewer than two readable dates it never renders
        and the CTA is a plain link to checkout.
      */}
      {seriesPickerUsable && (
        <SeriesTicketDatePicker
          seriesDates={readableSeriesDates}
          open={seriesPickerOpen}
          onOpenChange={setSeriesPickerOpen}
        />
      )}
      {statusBanner && (
        <div
          role="status"
          data-testid="event-status-banner"
          data-status={eventStatus}
          style={{
            margin: "0 24px 16px",
            padding: "12px 14px",
            border:
              statusBanner.tone === "danger"
                ? "1px solid rgba(239, 68, 68, 0.45)"
                : "1px solid rgba(33, 28, 22, 0.18)",
            borderLeft:
              statusBanner.tone === "danger"
                ? "4px solid rgba(239, 68, 68, 0.9)"
                : "4px solid rgba(33, 28, 22, 0.55)",
            background: bannerBackground(
              statusBanner.tone === "danger"
                ? "rgba(239, 68, 68, 0.08)"
                : "rgba(33, 28, 22, 0.04)",
            ),
            fontSize: 14,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <strong
            style={{
              fontSize: 12,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {statusBanner.title}
          </strong>
          <span style={{ color: "var(--colorMuted, #5C544A)" }}>
            {statusBanner.body}
          </span>
        </div>
      )}
      {revealNotice && (
        <div
          style={{
            margin: "0 24px 16px",
            padding: "12px 14px",
            border: "1px solid rgba(226, 72, 29, 0.3)",
            background: bannerBackground("rgba(226, 72, 29, 0.06)"),
            fontSize: 14,
          }}
        >
          {/* RSVP listings reveal to people who RSVP'd as well (owner ruling
              Q16, arrival-areas); a ticketed event's holders are the audience. */}
          {String(
            t(mode.isRsvp ? "admin.ebRevealNoticeRsvp" : "admin.ebRevealNotice", {
              date: revealNotice,
            }),
          )}
        </div>
      )}
      {!holderView && mode.showPaymentSetupNotice && (
        <div
          role="status"
          data-testid="event-not-sellable-notice"
          style={{
            margin: "0 24px 16px",
            padding: "12px 14px",
            border: "1px solid rgba(226, 72, 29, 0.4)",
            borderLeft: "4px solid rgba(226, 72, 29, 0.85)",
            background: bannerBackground("rgba(226, 72, 29, 0.06)"),
            fontSize: 14,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <strong
            style={{
              fontSize: 12,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Tickets aren&apos;t available yet
          </strong>
          <span style={{ color: "var(--colorMuted, #5C544A)" }}>
            The organizer is still finishing their payment setup. Check back
            soon or reach out to them directly.
          </span>
        </div>
      )}
      {holderView && !mode.isRsvp && (
        <div
          role="status"
          data-testid="event-holder-sales-paused-notice"
          style={{
            margin: "0 24px 16px",
            padding: "12px 14px",
            border: "1px solid rgba(33, 28, 22, 0.18)",
            borderLeft: "4px solid rgba(33, 28, 22, 0.55)",
            background: bannerBackground("rgba(33, 28, 22, 0.04)"),
            fontSize: 14,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <strong
            style={{
              fontSize: 12,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {String(t("eventDetail.holderSalesPausedTitle"))}
          </strong>
          <span style={{ color: "var(--colorMuted, #5C544A)" }}>
            {String(t("eventDetail.holderSalesPausedBody"))}
          </span>
        </div>
      )}
      {!holderView && mode.showSalesClosedNotice && (
        <div
          role="status"
          data-testid="event-sales-closed-notice"
          style={{
            margin: "0 24px 16px",
            padding: "12px 14px",
            border: "1px solid rgba(33, 28, 22, 0.18)",
            borderLeft: "4px solid rgba(33, 28, 22, 0.55)",
            background: bannerBackground("rgba(33, 28, 22, 0.04)"),
            fontSize: 14,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <strong
            style={{
              fontSize: 12,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Ticket sales have closed
          </strong>
          <span style={{ color: "var(--colorMuted, #5C544A)" }}>
            This event has ended, so tickets are no longer available.
          </span>
        </div>
      )}
      <EventContent
        title={event.name}
        organizerName={organizerName}
        organizerHref={organizerHref}
        refundCutoffAt={refundCutoffAt}
        startsAt={readableDateIso(event.startsAt)}
        endsAt={readableDateIso(event.endsAt)}
        timezone={event.timezone ?? undefined}
        location={locationLabel}
        heroImageUrl={event.images?.[0] ?? undefined}
        heroImageSize={heroImageSize ?? undefined}
        bodyHtml={bodyHtml || undefined}
        ticketTypes={mode.isRsvp ? [] : ticketTypes}
        eventHumans={eventHumans.map((eh) => ({
          id: eh.id,
          name: eh.name,
          role: eh.role,
          customRoleLabel: eh.customRoleLabel,
          // Deliberately NOT eh.profileUrl: that field is the entry's external
          // WEBSITE url (null for linked humans), and feeding it into the
          // avatar <img src> rendered a broken-image tile on every external
          // act. No avatar URL exists in this payload — the initial-letter
          // fallback is the correct render.
          listenUrl: eh.listenUrl ?? null,
        }))}
        ctaLabel={
          mode.hideTicketCta ? undefined : String(t("common.getTickets"))
        }
        ctaAriaLabel={String(t("common.navGetTickets"))}
        ctaHref={effectiveCtaHref}
        onCtaPress={
          seriesPickerUsable ? () => setSeriesPickerOpen(true) : undefined
        }
        ticketAvailability={ticketAvailability}
        currency={event.pricing?.currency ?? "USD"}
        backHref={backHref}
        backLabel={backLabel}
        immersiveHero={immersiveHero}
        editHref={editHref}
        address={address}
        // ADDRESS PRIVACY. Straight off the server's redacted payload. It is
        // NOT derivable from `locationCoords` below — a fully-hidden event has
        // no coordinates, so that prop is undefined and indistinguishable from
        // an exact event that was never geocoded. This is the flag that keeps
        // the copy-address control and the maps link off a withheld event.
        locationIsExact={event.location?.isExact ?? true}
        // Only the LINK. Null for a directory-listed, confirmed venue that
        // has no EntityPage (every bulk-imported one) — the badge then renders
        // the name as plain text rather than disappearing.
        placeSlug={event.location?.placeSlug ?? undefined}
        // Venue display name for the hero "At {venue}" badge. Independent of
        // placeSlug: the name is public directory data, the link is a
        // reachability question.
        venueName={event.location?.name ?? undefined}
        venueConfirmed={venueConfirmed}
        feeMode={feeRates?.feeMode ?? null}
        feeEstimateMap={feeEstimateMap}
        // The tooltip's rate: null when the charged tax lines sit on
        // different bases (Minneapolis), so the tax shows without a rate.
        admissionTaxRateBps={taxRateLabelBps(feeRates?.taxImpositions)}
        platformFeeLabel={feeRates?.platformFeeLabel ?? null}
        // The per-ticket cap, so the fee tooltip can read "3.33%, max
        // $0.50/ticket" — the label checkout shows (composed in
        // TicketsSection, which already holds the formatters).
        platformFeeRates={feeRates?.platformFeeRates ?? null}
        processorFeeLabel={feeRates?.processorFeeLabel ?? null}
        tags={tags}
        eventId={eventId}
        arrivalAreas={arrivalAreas}
        // Feeds the calendar EXPORT, not the on-page cadence line (that is the
        // `CommunityDateList` below). Same summary, so the .ics and the page can
        // never disagree about the cadence.
        communityRecurrence={communityRecurrence}
        waitlistOpen={waitlistOpen}
        waitlistDescription={waitlistDescription}
        saveAction={
          showSaveAction && eventId ? (
            <SaveButton
              eventId={eventId}
              onDark={immersiveHero}
              variant={posterFirst ? "poster" : "default"}
            />
          ) : undefined
        }
        organizerRating={
          showSaveAction && eventId ? (
            <EventRatingLine
              eventId={eventId}
              onDark={immersiveHero}
              ink={posterFirst ? "var(--hero-ink-muted)" : undefined}
            />
          ) : undefined
        }
        belowContent={belowContent}
        heroFollowsNotice={Boolean(
          statusBanner ||
            revealNotice ||
            (holderView && !mode.isRsvp) ||
            mode.showPaymentSetupNotice ||
            mode.showSalesClosedNotice,
        )}
        rsvpAction={
          mode.isRsvp && eventId ? (
            isRecurringRsvp ? (
              <CommunityDateList
                eventId={eventId}
                initialDates={communityDates}
                timezone={event.timezone ?? undefined}
                recurrence={communityRecurrence}
                datesTruncated={communityDatesTruncated}
                nextScheduledEventDateId={communityNextScheduledDateId}
                hasRecurrenceRule={communityHasRecurrenceRule}
              />
            ) : (
              <RsvpButton eventId={eventId} initialRsvped={viewerRsvped} />
            )
          ) : undefined
        }
        rsvpSectionTitle={
          isRecurringRsvp ? String(t("eventDetail.upcomingDates")) : undefined
        }
        communityAttribution={
          stewardship === "COMMUNITY" ? (
            <CommunityListingNotice suggestEditHref={suggestEditHref} />
          ) : undefined
        }
        // Recruitment ("apply to moderate") moved out of the top attribution
        // and down to a quiet footer band — present but de-emphasized.
        communityFooter={
          stewardship === "COMMUNITY" ? (
            <BecomeModeratorCta variant="footer" />
          ) : undefined
        }
        /*
         * The COMMUNITY listing layout — description first, one unnumbered
         * fact block, a sticky desktop rail.
         *
         * Gated on RSVP as well as stewardship, deliberately. The two props
         * are independent, and the community layout drops the ticketed
         * sections (tickets, refund policy, the buy button in the body). A
         * COMMUNITY listing that somehow carried ticket types would lose its
         * only way to buy — so it keeps the ticketed layout instead. In
         * practice community listings are always RSVP; this is the guard for
         * when they are not.
         */
        communityLayout={stewardship === "COMMUNITY" && mode.isRsvp}
        mobile={mobile}
        // EXACT / post-reveal coords render the pin map; OBSCURED pre-reveal
        // coords are the server-obfuscated circle centre (redactLocation) and
        // render the radius-circle map — but only when the server also sent
        // radiusMeters (spec FR-002). Fully-hidden events have no lat/lng at
        // all, so they keep rendering with no map.
        locationCoords={
          event.location?.latitude != null &&
          event.location?.longitude != null &&
          (event.location?.isExact !== false ||
            event.location?.radiusMeters != null)
            ? {
                latitude: event.location.latitude,
                longitude: event.location.longitude,
                label: event.location.name ?? null,
                isExact: event.location.isExact ?? true,
                radiusMeters: event.location.radiusMeters,
                areaLabel: event.location.areaLabel,
              }
            : undefined
        }
      />
    </>
  );
}
