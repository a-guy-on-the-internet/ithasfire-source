"use client";

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  memo,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Link, useTranslations, useFormatters } from "@th/ui";
import { useTheme, XStack, YStack } from "tamagui";
import {
  ArrowLeft,
  Calendar,
  Check,
  Clock,
  Copy,
  Hash,
  BadgeCheck,
  MapPin,
  Pencil,
  Shield,
  User,
} from "lucide-react";

import { Text, Button, DateStub, formatStubDateParts } from "@th/ui";

// LocationMapPreview pulls maplibre-gl (~1 MB uncompressed). Defer so
// the event detail body can render without blocking on the map chunk.
import nextDynamic from "next/dynamic";
const LocationMapPreview = nextDynamic(
  () =>
    import("@/components/maps/LocationMapPreview").then((m) => ({
      default: m.LocationMapPreview,
    })),
  { ssr: false },
);
import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";
import { googleMapsUrl } from "@/lib/maps/directions";
import { fmtCurrency } from "@/lib/format";
import { readableIso } from "@/lib/readable-date";
import { WaitlistJoinForm } from "./WaitlistJoinForm";
import { posterSizeAttrs } from "./poster-size-attrs";
import { TravelTimeWidget } from "./TravelTimeWidget";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { useHydrateAudioBlocks } from "@/components/audio/useHydrateAudioBlocks";
import { useNavbarVisibleHeight } from "@/components/navigation/navbar-offset-store";
import { useHydrateMediaEmbeds } from "@/components/embeds/useHydrateMediaEmbeds";
import { DirectionsDropdown } from "@/components/actions/DirectionsDropdown";
import { ArrivalAreasLegend } from "@/components/maps/ArrivalAreasLayer";
import { isMapEnabled } from "@/config/maps";
import {
  GettingThereList,
  useArrivalAreaSelection,
} from "@/components/maps/GettingThereList";
import { getListedBuyerAllInDisplayCents } from "@/lib/pricing/buyer-display";
import {
  isPayWhatYouWant,
  payWhatYouWantFloorCents,
  payWhatYouWantFromCents,
} from "@/lib/pricing/pay-what-you-want";
import { payWhatYouWantListingCopy } from "./pay-what-you-want-copy";
import { isPosterFirstLayout } from "./poster-first-layout";
import { derivePriceBreakdown, priceBreakdownCaption } from "./price-breakdown";
import { DockedBarPriceCaption } from "./DockedBarPriceCaption";

import "./event-content.css";
// The description's typography, shared with the description editor.
import "./event-body-typography.css";
import {
  ACCENT,
  FOREGROUND,
  MUTED_TEXT,
  ON_STRUCTURE,
} from "@/lib/design-tokens";

// ── Re-exports (keep all public symbols importable from this module) ─────
export type {
  EventContentTicketType,
  EventContentHuman,
  TicketFeeEstimate,
  EventContentLocationCoords,
  TicketAvailability,
  EventContentProps,
} from "./event-content-types";

import type { EventContentProps } from "./event-content-types";
import {
  ContentStack,
  HeroImage,
  SectionTitle,
  EventSectionNum,
  RoleBadge,
} from "./event-content-styled";
import { LineupListenEntry, getListenEmbed } from "./LineupListenEntry";
import { ShareDropdown } from "./ShareDropdown";
import { CalendarDropdown } from "./CalendarDropdown";
import { TicketsSection } from "./TicketsSection";
import { CommunityListingHead } from "./CommunityListingHead";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

// The layout predicate lives beside the types so EventDetail (and its test)
// can share it without importing this module.
export { isPosterFirstLayout } from "./poster-first-layout";

/** Stable empty list, so the selection hook's input never changes identity. */
const NO_ARRIVAL_AREAS: readonly VisibleArrivalArea[] = [];

export function EventContent({
  title,
  organizerName,
  organizerHref,
  refundCutoffAt,
  startsAt: rawStartsAt,
  endsAt: rawEndsAt,
  timezone,
  location,
  address,
  locationIsExact,
  placeSlug,
  venueName,
  venueConfirmed = false,
  heroImageUrl,
  heroImageSize,
  bodyHtml,
  ticketTypes = [],
  eventHumans = [],
  ctaLabel,
  ctaAriaLabel,
  ctaHref,
  onCtaPress,
  mobile = false,
  currency = "USD",
  locationCoords,
  editHref,
  backHref,
  backLabel,
  ticketAvailability = "on_sale",
  feeMode = null,
  feeEstimateMap,
  admissionTaxRateBps,
  platformFeeLabel,
  platformFeeRates,
  processorFeeLabel,
  tags = [],
  isAdminPreview = false,
  eventId,
  waitlistOpen = false,
  waitlistDescription,
  saveAction,
  organizerRating,
  rsvpAction,
  rsvpSectionTitle,
  communityAttribution,
  communityFooter,
  communityRecurrence,
  communityLayout = false,
  immersiveHero = false,
  belowContent,
  heroFollowsNotice = false,
  arrivalAreas,
}: EventContentProps) {
  // An unreadable date is an absent one from here down: every formatter below
  // would throw a RangeError on it, and each "no date" state already renders.
  const startsAt = readableIso(rawStartsAt);
  const endsAt = readableIso(rawEndsAt);
  const theme = useTheme();
  const t = useTranslations();
  const fmt = useFormatters();
  const { gates } = useFeatureGates();

  const resolvedBackLabel = backLabel ?? String(t("common.backToHome"));

  // ── The poster-first layout ──────────────────────────────────────────────
  // The poster in a rail, everything else in ONE column beside it — the meta
  // block, the buy band, the numbered sections, the sections below them.
  // MEASURED at 1440 before this, with a 2:3 flyer: the poster's left edge at
  // 200, the h1 at 672, and everything below the hero at 360 — a 720px block
  // centred on the page, aligned with nothing. Three left edges. The sections
  // now flow in the same column as the h1, which also fills the ~300px of dead
  // space under the CTA past 1200px and lets the sticky rail actually travel
  // (it used to be the tallest thing in its own row, so it never moved).
  //
  // This flag only says the layout is ELIGIBLE. The column split itself is a
  // media query (`.event-page-split`, >=768px, in event-content.css); below it
  // the same DOM is the phone layout: full-bleed poster, paper sheet, price bar.
  const heroSplit = isPosterFirstLayout({
    heroImageUrl,
    mobile,
    isAdminPreview,
    communityLayout,
  });

  // ── Hero palette ─────────────────────────────────────────────────────────
  // Three regimes, one JSX tree:
  //
  //   POSTER-FIRST (heroSplit). The treatment is RESPONSIVE: on a phone the
  //   text sits on a cream paper sheet in ink; wide, it sits over the dark
  //   band at the top of the page in on-dark ink. Inline styles cannot carry a
  //   media query, so the colours are CSS custom properties set on
  //   `.event-page-split` (`--hero-ink`, `--hero-ink-muted`, `--hero-rule`) and
  //   flipped by the same media query that turns the columns on. The scrim's
  //   job moved with the text: the band (`.event-page-split__band`) keeps the
  //   >=0.62 black floor under every light glyph and fades to cream only in
  //   its overhang, below the last line of hero text.
  //
  //   IMMERSIVE, NOT SPLIT (a community listing with a poster). The legacy
  //   zone-wide scrim; every glyph flips to the fixed on-dark ink
  //   (`$onStructure` / ON_STRUCTURE) that clears AA over the >=0.6 floor.
  //
  //   CLASSIC (embeds, admin preview, posterless). Themed ink. CSS vars rather
  //   than `theme.<token>.val`, so the embed's host-colour bridge
  //   (embedThemeBridgeStyle) still reaches them.
  const heroInkVar = heroSplit
    ? "var(--hero-ink)"
    : immersiveHero
      ? ON_STRUCTURE
      : FOREGROUND;
  const heroInkToken = heroSplit
    ? "var(--hero-ink)"
    : immersiveHero
      ? "$onStructure"
      : "$color";
  const heroIconColor = heroSplit
    ? "var(--hero-ink)"
    : immersiveHero
      ? theme.onStructure?.val
      : FOREGROUND;
  // Muted-but-legible for the quiet hero bits (organizer badge, rating): the
  // 85% on-dark rung over a scrim, the themed muted ink on paper.
  const heroMutedInk = heroSplit
    ? "var(--hero-ink-muted)"
    : immersiveHero
      ? "color-mix(in srgb, var(--onStructure, #FDFAF3) 85%, transparent)"
      : undefined;
  // Match the muted icon to its paired label brightness so the badge icon and
  // its text read as one weight.
  const heroMutedIconColor = heroSplit
    ? "var(--hero-ink-muted)"
    : immersiveHero
      ? "color-mix(in srgb, var(--onStructure, #FDFAF3) 85%, transparent)"
      : MUTED_TEXT;
  // Divider / badge border: a light hairline on a scrim, the ink border
  // (`$borderColor`) on paper.
  const heroDividerColor = heroSplit
    ? "var(--hero-rule)"
    : immersiveHero
      ? "color-mix(in srgb, var(--onStructure, #FDFAF3) 35%, transparent)"
      : "var(--borderColor, #211C16)";
  // Distance the legacy scrim fades to transparent at its bottom edge; the hero
  // wrapper reserves exactly this much bottom padding so the fade lands in
  // empty space and never crosses hero text (deterministic, no measurement).
  const heroScrimFade = mobile ? 28 : 40;

  const formatDateForDisplay = (isoString: string) => {
    const date = new Date(isoString);
    return fmt.dateTime(date, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  };

  const formatPrice = (cents: number) => {
    if (cents === 0) return String(t("common.free"));
    return fmtCurrency(fmt, cents, currency);
  };

  const iconSize = mobile ? 16 : 18;
  const metaFontSize = mobile ? 15 : 16;

  const [addressCopied, setAddressCopied] = useState(false);

  // The sticky rail pins UNDER the consumer navbar, whose visible height the
  // navbar publishes (0 during SSR and while it is slid away on a phone). It
  // reaches the stylesheet as a custom property on the page grid — the navbar
  // is a sibling of the content area, so nothing here can inherit it.
  const navbarVisibleHeight = useNavbarVisibleHeight();

  // The docked price bar portals to <body>, which only exists on the client;
  // it mounts after hydration so the server and first client render agree.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => {
    setPortalReady(true);
  }, []);

  // ── Arrival areas (arrival-areas FR-006) ──────────────────────────────────
  // `mobile` is the EMBED flag, and the embed never shows areas (NFR-002).
  // One selection shared by the map (`mapColumn` / the community map) and the
  // "Getting there" list under the address, which sit in different columns.
  const visibleArrivalAreas = mobile
    ? NO_ARRIVAL_AREAS
    : (arrivalAreas ?? NO_ARRIVAL_AREAS);
  const showArrivalAreas = visibleArrivalAreas.length > 0;
  // The legend explains the map's paint, so it shows only when a real map
  // does (tiles configured; both call sites also need showable coords). With
  // no map, "Getting there" carries the areas alone, as on the place card.
  const legendShown = showArrivalAreas && isMapEnabled;
  const areaSelection = useArrivalAreaSelection(visibleArrivalAreas);
  const mapArrivalAreas = showArrivalAreas
    ? {
        areas: visibleArrivalAreas,
        selectedId: areaSelection.selectedId,
        onSelect: areaSelection.selectFromMap,
      }
    : undefined;
  const gettingThere = showArrivalAreas ? (
    <GettingThereList
      areas={visibleArrivalAreas}
      selection={areaSelection}
      seenOnEventId={eventId}
    />
  ) : null;

  // Copy location/address to clipboard
  const handleCopyAddress = useCallback(() => {
    const text = [location, address].filter(Boolean).join(", ");
    if (!text) return;
    // `.catch` is not ceremony: `writeText` REJECTS on a denied clipboard
    // permission and in any non-secure context, and an unhandled rejection
    // here both leaves the reader with a button that silently did nothing and
    // trips the e2e console-error fixture. Failing quietly is the honest
    // outcome — the address is already on screen and selectable.
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setAddressCopied(true);
        setTimeout(() => setAddressCopied(false), 2000);
      })
      .catch(() => {
        setAddressCopied(false);
      });
  }, [location, address]);

  const contentClassName = [
    "event-content-body",
    mobile ? "event-content-body--mobile" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // For OBSCURED events the backend returns isExact=false pre-reveal, in two
  // shapes (see redactLocation): the obfuscated-circle variant carries a
  // deterministically-offset lat/lng + radiusMeters and is safe to render
  // publicly as a radius circle; the fully-hidden variant has no coordinates
  // at all (callers never have a lat/lng to pass — no map, unchanged).
  // Ticket holders get the exact location once the reveal time passes
  // (page + notification + email). In admin preview mode, always show the
  // map so the organizer can verify.
  const showableLocationCoords =
    locationCoords &&
    (isAdminPreview ||
      locationCoords.isExact !== false ||
      locationCoords.radiusMeters != null)
      ? locationCoords
      : undefined;

  // Navigation affordances (maps link, directions, travel time) only make
  // sense for exact coordinates — the obfuscated pre-reveal point is
  // deliberately NOT the venue, so there is nothing to navigate to.
  const coordsAreExact =
    showableLocationCoords !== undefined &&
    showableLocationCoords.isExact !== false;

  // The admin builder preview passes TRUE coordinates (the map component
  // jitters them client-side); the public page passes coordinates the
  // server already obfuscated, so the map must not offset them again.
  const coordsArePreObfuscated =
    !isAdminPreview && showableLocationCoords?.isExact === false;

  /**
   * Whether the event publishes its address at all — the gate for every
   * "take me there" / "copy this" affordance on the page.
   *
   * Read from the explicit prop first, then from the coords block, then TRUE.
   * The coords fallback covers callers that predate the prop; the prop is what
   * covers the FULLY-HIDDEN case, where there are no coords to read (see
   * `EventContentProps.locationIsExact`). The admin preview is exempt: the
   * organizer is looking at their own event and already knows the address.
   */
  const locationPublishesAddress =
    isAdminPreview ||
    (locationIsExact ?? locationCoords?.isExact ?? true) !== false;

  // Volunteers are intentionally excluded from the public lineup — they are
  // surfaced only via the dedicated VolunteerSection, never listed line-by-line
  // as performers/hosts. EventContent is the single render path for the public
  // page, admin live preview, and embed detail, so filtering here covers every
  // public-facing rendered lineup. (SEO JSON-LD already excludes volunteers
  // upstream.)
  const visibleLineup = eventHumans.filter((eh) => eh.role !== "VOLUNTEER");

  // Headliner auto-expand (lineup-listen-embeds spec): the FIRST entry in the
  // existing lineup order whose listenUrl parses to an iframe embed starts
  // expanded — desktop only (mobile keeps everything collapsed for data cost).
  // Only ever one auto-expanded row; every other row lazy-mounts its player
  // on first expansion.
  //
  // "Desktop" must be judged against the REAL viewport, not the `mobile`
  // prop: the public event page never passes `mobile` (its responsiveness is
  // CSS-only), so gating on the prop alone auto-expanded on phones too
  // (caught in live QA). SSR/first paint therefore renders every row
  // collapsed (no player iframe in the initial HTML at all) and the
  // candidate activates after mount only when the viewport clears the CSS
  // desktop breakpoint (min-width: 768px — event-content.css). A true
  // `mobile` prop (embed/admin callers that do pass it) still hard-disables.
  const autoExpandCandidateId =
    visibleLineup.find((eh) => getListenEmbed(eh.listenUrl) !== null)?.id ??
    null;
  const [autoExpandListenId, setAutoExpandListenId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (
      !mobile &&
      autoExpandCandidateId !== null &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      setAutoExpandListenId(autoExpandCandidateId);
    }
    // Mount-only by design: the headliner expands once on load; later viewport
    // resizes must not yank a player open/closed under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasLogistics = Boolean(
    startsAt ||
    location ||
    showableLocationCoords ||
    visibleLineup.length > 0 ||
    rsvpAction ||
    communityAttribution,
  );

  // Matches the threshold the ticket rows and the embed already count down
  // from, so the hero never disagrees with the list below it.
  const LOW_AVAILABILITY_AT = 10;

  // ── The starting price ───────────────────────────────────────────────────
  // Computed once and printed in one of three places: the meta row (classic /
  // community hero), the buy band (poster-first, wide) or the docked price bar
  // (poster-first, phone). The cheapest tier by the buyer's ALL-IN unit total.
  // Every figure IS that all-in total, so it can never undercut what checkout
  // charges — a pay-what-you-want floor included: "From $6.09" for a $5 floor
  // at 8.88% tax, fees on top (owner ruling 2026-10-02). It used to print the
  // face ("From $5.00") with "+ fees & tax" beside it.
  const priceSummary = (() => {
    if (ticketTypes.length === 0) return null;
    // Tiers are RANKED, and a PWYW floor DISPLAYED, by what the buyer pays
    // all-in. The server prices a PWYW tier's estimate row at `minimumCents`
    // with fees and tax on top, exactly like a fixed price
    // (`payWhatYouWantFromCents`); floor 0 is 0 and reads "Pay what you
    // want". Its stored $0 used to rank it, and label it, as "Free" even with
    // a $5 minimum.
    const rankCents = (tier: (typeof ticketTypes)[number]): number | null => {
      if (isPayWhatYouWant(tier)) {
        return payWhatYouWantFromCents(tier, feeEstimateMap?.[tier.id]);
      }
      // Stale-guarded, like the Tickets rows below it.
      return getListedBuyerAllInDisplayCents({
        priceCents: tier.priceCents,
        buyerUnitTotalCents: feeEstimateMap?.[tier.id]?.buyerUnitTotalCents,
        buyerUnitPriceCents: feeEstimateMap?.[tier.id]?.unitPriceCents,
      });
    };
    const cheapest = [...ticketTypes].sort(
      (left, right) =>
        (rankCents(left) ?? Number.POSITIVE_INFINITY) -
        (rankCents(right) ?? Number.POSITIVE_INFINITY),
    )[0]!;
    // A PWYW floor of 0 is worded the way its Tickets row says it — "Pay
    // what you want" + the suggestion — because there is no total to quote.
    const pwyw = isPayWhatYouWant(cheapest)
      ? {
          floorCents: payWhatYouWantFloorCents(cheapest),
          copy: payWhatYouWantListingCopy(cheapest, {
            estimate: feeEstimateMap?.[cheapest.id],
            formatPrice,
            t,
          }),
        }
      : null;
    const buyerUnitTotalCents = rankCents(cheapest);
    // TRUE availability (`capacity - issued - held`), the basis checkout
    // refuses on — never the authored `capacity`, which no write path
    // decrements. Shown only when it is genuinely low, and worded as the plain
    // count the ticket rows already use, so the hero states a fact rather than
    // manufacturing pressure (calm-honest-ux FR-004).
    const remaining = cheapest.remainingCapacity;
    const showRemaining =
      typeof remaining === "number" &&
      remaining > 0 &&
      remaining <= LOW_AVAILABILITY_AT;
    // The all-in figure's parts ("$40.00 ticket + $2.12 fees + $3.55 tax").
    // A PWYW floor's parts come off the same row, with the floor as the
    // ticket. An RSVP listing quotes nothing. Null unless the parts sum to
    // the figure exactly — see `derivePriceBreakdown`.
    const breakdown = rsvpAction
      ? null
      : derivePriceBreakdown({
          priceCents: pwyw ? pwyw.floorCents : cheapest.priceCents,
          figureCents: buyerUnitTotalCents,
          estimate: feeEstimateMap?.[cheapest.id],
          feeMode,
        });
    return { buyerUnitTotalCents, pwyw, remaining, showRemaining, breakdown };
  })();
  // "From" is a LABEL on the poster-first surfaces and a PREFIX in the classic
  // meta row; the figure itself is the same string either way. A free or a
  // still-calculating price carries no "From" — there is nothing it is from.
  const priceIsFrom =
    priceSummary != null &&
    priceSummary.buyerUnitTotalCents != null &&
    priceSummary.buyerUnitTotalCents > 0;
  const priceFigure =
    priceSummary == null
      ? null
      : priceSummary.pwyw && priceSummary.pwyw.floorCents === 0
        ? priceSummary.pwyw.copy.label
        : priceSummary.buyerUnitTotalCents == null
        ? String(t("checkout.calculatingTotal"))
        : priceSummary.buyerUnitTotalCents === 0
          ? String(t("common.free"))
          : formatPrice(priceSummary.buyerUnitTotalCents);
  /** Muted line under a PWYW floor of 0: "suggested $15.00". */
  const priceHint = priceSummary?.pwyw?.copy.hint ?? null;
  /** Muted line under a fixed all-in figure naming its parts; `short` for the docked bar. */
  const priceBreakdownLong = priceSummary?.breakdown
    ? priceBreakdownCaption(priceSummary.breakdown, "long", { formatPrice, t })
    : null;
  const priceBreakdownShort = priceSummary?.breakdown
    ? priceBreakdownCaption(priceSummary.breakdown, "short", { formatPrice, t })
    : null;
  const remainingLine =
    priceSummary?.showRemaining && priceSummary.remaining != null
      ? String(
          t("eventDetail.lowAvailability", { count: priceSummary.remaining }),
        )
      : null;

  // ── The buy control ────────────────────────────────────────────────────
  // Defined once and rendered twice: beside the price in the hero, and again
  // in the body for whoever read the whole page. Both were one control before
  // (in the body only, 1,452px down a 2,254px page — 64% of the way to the
  // footer, while the hero quoted the price and offered nothing to press).
  //
  // `onCtaPress` is the series case: the button opens the date picker instead
  // of navigating, and the href still renders so it degrades to a real link.
  const canBuy = !rsvpAction && Boolean(ctaHref) && Boolean(ctaLabel);
  const renderBuyButton = (
    testId: string,
    fullWidth: boolean,
    size: "$4" | "$5" = "$4",
  ) => {
    const style = fullWidth ? { width: "100%" } : undefined;
    return onCtaPress ? (
      <Button
        variant="primary"
        size={size}
        style={style}
        onPress={onCtaPress}
        aria-label={ctaAriaLabel}
        data-testid={testId}
      >
        {ctaLabel}
      </Button>
    ) : (
      <Link
        href={ctaHref as string}
        aria-label={ctaAriaLabel}
        style={fullWidth ? { display: "block", width: "100%" } : undefined}
      >
        <Button
          tag="span"
          variant="primary"
          size={size}
          style={style}
          data-testid={testId}
        >
          {ctaLabel}
        </Button>
      </Link>
    );
  };

  // ── Section numbering ──────────────────────────────────────────────────
  // The "0N." labels are assigned from the set of *visible* sections at
  // render time so they stay consecutive no matter which optional sections
  // (lineup, tickets, RSVP, refund) are present. Previously each section
  // hardcoded its number, so a hidden section left a gap (e.g. 02 → 04 when
  // the lineup was absent, or a ticketed event with no lineup showing 05
  // with no 03/04). Order here MUST match DOM order below.
  const showScheduleSection = Boolean(startsAt);
  const showLocationSection = Boolean(location || address);
  const showLineupSection = visibleLineup.length > 0;
  const showTicketsSection = !rsvpAction && ticketTypes.length > 0;
  const showRefundSection = refundCutoffAt !== undefined;
  const showRsvpSection = Boolean(rsvpAction);

  let sectionSeq = 0;
  const nextSectionNum = (visible: boolean) =>
    visible ? String(++sectionSeq).padStart(2, "0") : "";
  const scheduleSectionNum = nextSectionNum(showScheduleSection);
  const locationSectionNum = nextSectionNum(showLocationSection);
  const lineupSectionNum = nextSectionNum(showLineupSection);
  const ticketsSectionNum = nextSectionNum(showTicketsSection);
  const refundSectionNum = nextSectionNum(showRefundSection);
  const rsvpSectionNum = nextSectionNum(showRsvpSection);

  // Build a Google Maps link for the address / coordinates. Never link out
  // to the obfuscated pre-reveal point — it isn't the venue.
  //
  // `locationPublishesAddress` also gates the `address`-only fallback below:
  // a withheld event should arrive with a null `address`, and if one ever
  // slips through, this is what stops it becoming a maps query string.
  const addressMapsHref = !locationPublishesAddress
    ? null
    : coordsAreExact && showableLocationCoords
      ? googleMapsUrl({
          latitude: showableLocationCoords.latitude,
          longitude: showableLocationCoords.longitude,
          label: address || location,
        })
      : address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
        : null;

  // ── COMMUNITY LISTING BRANCH ─────────────────────────────────────────────
  // `communityLayout` is set ONLY for a COMMUNITY-stewardship RSVP listing
  // (see EventDetail). Everything ticketed — including a COMMUNITY listing
  // that somehow carries ticket types — falls through to the layout below,
  // unchanged.
  //
  // Two head states:
  //   NO POSTER (all 19 seeded community listings) — the Date Stub stops being
  //   decoration and becomes the head, carrying the title and the venue line
  //   beside the date. The separate <h1> + attribution + meta stack is dropped,
  //   because each of its facts is printed once in the head.
  //   WITH A POSTER — untouched. The immersive HeroBackdrop, the parallax and
  //   the scrim treatment of the title/meta are exactly what they are today.
  const communityHeadActive = communityLayout && !heroImageUrl;
  const communityDateParts = communityHeadActive
    ? formatStubDateParts(startsAt, timezone)
    : null;
  // The date panel is a GRAPHIC; `role="img"` + this label is what puts the
  // date into the accessibility tree, in prose, once. The time is deliberately
  // NOT here — it renders as real text beside the title.
  const communityDateLabel = startsAt
    ? fmt.dateTime(new Date(startsAt), {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        ...(timezone ? { timeZone: timezone } : {}),
      })
    : String(t("common.dateNotSet"));
  const communityTimeLabel = startsAt
    ? fmt.dateTime(new Date(startsAt), {
        hour: "numeric",
        minute: "2-digit",
        ...(timezone ? { timeZone: timezone } : {}),
      })
    : null;
  // The fact block replaces the numbered "Schedule" and "Location" sections.
  const communityWhereValue = address || location;
  const hasCommunityFacts = Boolean(
    communityWhereValue || startsAt || endsAt || communityAttribution,
  );
  // Start and end print as ONE "When" row (owner, 2026-10-17). formatRange,
  // in the VENUE's zone, prints the shared date once for a same-day range
  // ("Monday, October 26, 2026, 7:00 – 10:00 PM") and both dates across that
  // zone's midnight. With one end missing or unreadable, the row keeps the
  // single date under "Starts" / "Ends". An end at or before the start is not
  // a range we print (a product rule; formatRange would print it backwards),
  // so it keeps the start alone too.
  const communityWhen = ((): { key: string; value: string } | null => {
    const starts = startsAt ? new Date(startsAt) : null;
    const ends = endsAt ? new Date(endsAt) : null;
    const validStarts =
      starts && !Number.isNaN(starts.getTime()) ? starts : null;
    const validEnds = ends && !Number.isNaN(ends.getTime()) ? ends : null;
    if (validStarts && validEnds && validEnds > validStarts) {
      try {
        return {
          key: "eventDetail.factWhen",
          value: new Intl.DateTimeFormat(fmt.locale, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            ...(timezone ? { timeZone: timezone } : {}),
          })
            .formatRange(validStarts, validEnds)
            // ICUs disagree on formatRange's spaces: Node 24 (ICU 77.1) puts
            // a thin space around the dash and a narrow no-break space before
            // PM, Chrome 155 prints plain spaces, and the mismatch failed
            // hydration on this row. Plain spaces make SSR and the browser
            // print the same string.
            .replace(/[\u2009\u202f\u00a0]/g, " ")
            // They also disagree on the dash itself. Measured after the line
            // above: Node, Chromium and Firefox print a Spanish same-day range
            // as "19:00–22:00" and WebKit as "19:00 – 22:00"; every other
            // range was the same in all four. One spaced en dash everywhere.
            .replace(/\s*\u2013\s*/g, " \u2013 "),
        };
      } catch {
        /* a runtime without formatRange: fall through to the start alone. An
           unreadable zone or locale has already thrown in the head's
           fmt.dateTime calls above. */
      }
    }
    if (startsAt && validStarts)
      return {
        key: "eventDetail.scheduleStarts",
        value: formatDateForDisplay(startsAt),
      };
    if (endsAt && validEnds)
      return {
        key: "eventDetail.scheduleEnds",
        value: formatDateForDisplay(endsAt),
      };
    return null;
  })();

  // ── Shared pieces ────────────────────────────────────────────────────────
  // Rendered by both trees below. Plain JSX values, not components: they
  // close over this render's props and hooks, and a component defined inline
  // would remount on every render.
  const backLink = backHref ? (
            <Link
              href={backHref}
              data-testid="event-back-link"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px 8px 12px",
                borderRadius: 0,
                backgroundColor: "transparent",
                border: "none",
                // Over the dark immersive scrim the accent orange (~1.4:1) is
                // unreadable, so the back link flips to on-dark ink; on the
                // classic light hero (embeds/admin) it keeps the accent.
                color: heroSplit ? heroInkVar : immersiveHero ? ON_STRUCTURE : ACCENT,
                textDecoration: "none",
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase" as const,
                transition: "color 0.15s, opacity 0.15s",
              }}
            >
              <ArrowLeft size={16} strokeWidth={2.5} />
              {resolvedBackLabel}
            </Link>
  ) : null;

  const posterFrame = !communityHeadActive ? (
        <HeroImage
          className={
            heroImageUrl
              ? "event-content-hero event-hero-poster-frame"
              : "event-content-hero"
          }
          /*
           * A photograph is its own figure and needs no frame. GENERATED
           * artwork does: the Date Stub's body is `$surface`, which on Ember is
           * #162240 against a #0F1B33 page (1.14:1) and on Stub is #FDFAF3
           * against #F6F0E4. MEASURED in both — without an edge the paper half
           * dissolves into the page and the artifact reads as a lone coloured
           * block beside some text rather than as a ticket. 2px of ink is the
           * same frame the page's other content blocks already carry.
           */
          {...(heroImageUrl
            ? {}
            : { borderWidth: 2, borderColor: "$borderColor" as const })}
          style={
            heroImageUrl
              ? /*
                 * A POSTER sizes itself. No aspect-ratio, no min/max height:
                 * the frame is only the column's width and a stacking slot, and
                 * the shape rules live in `.event-hero-poster-frame` /
                 * `.event-hero-poster-img` in event-content.css — declared once
                 * so `container-type` has a single home.
                 */
                { position: "relative", zIndex: 1 }
              : /*
                 * GENERATED artwork keeps the fixed 16/9 plate it was drawn
                 * for. The Date Stub is the Open Graph PNG's twin and has a
                 * shape of its own; it is not a file whose proportions we are
                 * discovering.
                 */
                {
                  position: "relative",
                  zIndex: 1,
                  aspectRatio: "16 / 9",
                  maxHeight: mobile ? 220 : 360,
                  minHeight: mobile ? 160 : 200,
                }
          }
        >
          {heroImageUrl ? (
            /*
             * The poster, whole. The blurred self-copy and its veil that used
             * to sit behind this are gone: they existed only to fill letterbox
             * bars, and there are no bars left to fill.
             *
             * `mobile` is the EMBED flag, not a viewport signal — a real phone
             * takes the `!mobile` branch and gets the full 2:3 ceiling. Only
             * the embed (and the builder's mobile preview frame, which reuses
             * the flag) is held to the tighter square.
             */
            <img
              src={heroImageUrl}
              // The file's own pixel size, when known: lets the browser
              // reserve the box before the bytes arrive. The CSS keeps
              // `width: 100%; height: auto`, so these only set the ratio.
              {...posterSizeAttrs(heroImageSize)}
              alt={t("eventDetail.heroAlt") as string}
              // The password Door's photo morphs into this on unlock
              // (GatedEventShell + password-door.css). Inert otherwise.
              data-gate-reveal="poster"
              className={
                mobile
                  ? "event-hero-poster-img event-hero-poster-img--compact"
                  : "event-hero-poster-img"
              }
            />
          ) : (
            /*
             * ── The Date Stub: the default artwork for an event with no
             * poster. Replaces a bokeh-gradient panel carrying an image icon
             * and the words "No hero image" — a decorative blob (which the
             * design system bans outright) whose only message was that
             * something was missing.
             *
             * Same artifact as the Open Graph PNG at /og/event/<slug>, so a
             * posterless event reads as one object whether it is seen in Slack,
             * in an email or here. This half is vector, themed and free.
             *
             * ── WHY THE TORN STUB AND NOT THE FULL ARTIFACT ─────────────────
             * `layout="column"`, and NO title or place line. The PNG prints
             * both because it is standalone — a link unfurl has nothing else to
             * say what the event is. This page has everything else. MEASURED at
             * a 320px viewport with the full artifact, the screen read, top to
             * bottom: "Comedy Night at Larry's" (stub) / "COMEDY NIGHT AT
             * LARRY'S" (h1) / "Nashville, TN" (stub) / "NASHVILLE, TN" (meta
             * row). Four lines, two facts.
             *
             * On the detail page the artwork's job is IDENTITY, not
             * information; the page states the information. So the hero takes
             * the half of the ticket that is pure identity — the torn stub,
             * full-bleed, the date owning the frame, the perforation running
             * down its right edge. A browse CARD is the opposite case and keeps
             * the title: its poster variant renders no body at all, so the
             * stub's title is the card's only title.
             *
             * `timezone` is the venue's, threaded from `Event.timezone`: the
             * event page is the one surface that actually has it, so unlike a
             * browse card the stub can print the day the show happens WHERE it
             * happens rather than where the reader is.
             *
             * Decorative (`DateStub` is aria-hidden on both platforms), and
             * more clearly so than before: it now carries no prose at all. The
             * node it replaces announced "No hero image", which is noise — the
             * absence of artwork is not information.
             */
            <DateStub
              layout="column"
              date={formatStubDateParts(startsAt, timezone)}
              /*
               * Not `mobile`: that prop is a device guess, and a 320px DESKTOP
               * viewport is exactly where a wide-frame numeral overflowed its
               * frame before. `xl` steps down to `heroCompact` on the `$sm`
               * media query, which is the frame's real width.
               */
              size="xl"
              testId="event-hero-date-stub"
            />
          )}
        </HeroImage>
  ) : null;

  const metaBlock = (
          <YStack gap={16} className="event-content-meta">
            {communityHeadActive ? (
              <>
                {/* The head. Date + title + venue line, each printed once —
                    which is why the <h1> / attribution / meta stack that
                    normally follows is not rendered in this branch. */}
                <CommunityListingHead
                  title={title || String(t("common.untitledEvent"))}
                  dateParts={communityDateParts}
                  dateLabel={communityDateLabel}
                  timeLabel={communityTimeLabel}
                  startsLabel={String(t("eventDetail.scheduleStarts"))}
                  venueName={venueName}
                  placeLabel={location}
                  placeSlug={placeSlug}
                  confirmedByVenueLabel={
                    venueConfirmed
                      ? String(t("eventDetail.confirmedByVenue"))
                      : null
                  }
                />
                {/* Save + Share, directly under the head (design order #2).
                    `onDark` is false by construction here: the immersive
                    scrim only exists when there is a poster, and a poster
                    takes the other branch. */}
                <XStack gap={12} alignItems="center" marginLeft="auto">
                  {saveAction}
                  <ShareDropdown title={title} onDark={immersiveHero} />
                </XStack>
              </>
            ) : (
              <>
            {/* ── Title + Share row ──────────────────────────────────── */}
            <XStack
              justifyContent="space-between"
              alignItems="flex-start"
              gap={12}
              // Wrap so the title never shares its line budget with the
              // SAVE/share buttons on phones: squeezed to ~156px next to them,
              // even word-boundary wrapping had to break inside words. Below
              // 560px the h1 takes the full row (see .event-title-row CSS) and
              // the actions drop to their own line.
              flexWrap="wrap"
              className="event-title-row"
            >
              <h1
                // The password Door's title moves here on unlock (see the
                // poster's `data-gate-reveal`).
                data-gate-reveal="heading"
                style={{
                  fontFamily: "Montserrat, sans-serif",
                  // `mobile` is the EMBED flag, not a viewport signal — real
                  // phones render the !mobile branch. A fixed 42px meant even
                  // 8-char words ("BROOKLYN") exceeded a 390px viewport's line
                  // box and the old `word-break: break-word` (≙ overflow-wrap:
                  // anywhere) shattered the title letter-by-letter. Ramp with
                  // the viewport instead: 7.5vw ≈ 29px @390 / 24px @320, capped
                  // at the unchanged 42px desktop scale (cap reached ≥ 560px).
                  fontSize: mobile ? 24 : "clamp(22px, 7.5vw, 42px)",
                  fontWeight: 900,
                  lineHeight: mobile ? 1.3 : 1.05,
                  letterSpacing: mobile ? -0.5 : -1,
                  textTransform: "uppercase" as const,
                  margin: 0,
                  color: heroInkVar,
                  // Wrap on word boundaries only. `overflow-wrap: break-word`
                  // (unlike `anywhere`/`break-all`) never splits a word that
                  // fits on its own line, and does NOT inflate the flex item's
                  // min-content width — so an extreme title hyphenates/breaks
                  // inside the box instead of stretching the mobile layout
                  // viewport (which was dragging every position:fixed element
                  // out past the visual viewport). `minWidth: 0` lets the flex
                  // item actually shrink below the longest word so lines wrap.
                  overflowWrap: "break-word" as const,
                  hyphens: "auto" as const,
                  WebkitHyphens: "auto" as const,
                  minWidth: 0,
                  flex: 1,
                }}
              >
                {title || String(t("common.untitledEvent"))}
              </h1>

              {/* Save (secondary) + Share actions — grouped so they wrap as a
                unit and stay right-aligned when they drop below the title.
                Poster-first, both live under the poster in the rail. */}
              {!heroSplit && (
                <XStack gap={12} alignItems="center" marginLeft="auto">
                  {saveAction}
                  <ShareDropdown title={title} onDark={immersiveHero} />
                </XStack>
              )}
            </XStack>

            {/* ── "Presented by" + "At {venue}" attribution row ─────────
              Plain facts, no manufactured urgency — calm-honest-ux FR-003.
              The organizer badge hides when there's no organizer to name
              (e.g. ownerless COMMUNITY listings); the venue badge renders
              whenever the event sits at a real platform venue — alone if
              there's no organizer. flexWrap lets the badges stack on
              narrow screens instead of overflowing. */}
            {(organizerName || venueName) && (
              <XStack alignItems="center" gap={8} flexWrap="wrap">
                {organizerName &&
                  (() => {
                    const presentedByLabel = String(
                      t("eventDetail.presentedBy", { name: organizerName }),
                    );
                    const badgeText = (
                      <Text
                        truncate
                        style={{
                          display: "block",
                          fontSize: mobile ? 12 : 13,
                          fontWeight: "500",
                          ...(immersiveHero ? { color: heroMutedInk } : {}),
                        }}
                        tone="muted"
                      >
                        {presentedByLabel}
                      </Text>
                    );
                    // Same shrink contract the venue badge below carries, for
                    // the same measured reason. Stacks default to flexShrink 0,
                    // so "Presented by Chicago Underground Collective" kept its
                    // max-content width and pushed the document to a 384px
                    // scrollWidth in a 320px viewport (badge measured 344px).
                    // The badge shrinks explicitly, minWidth 0 lets the shrink
                    // reach the text, and the organizer NAME ellipsises instead
                    // of forcing the row wide. The link stays a link.
                    const shrinkStyle = {
                      minWidth: 0,
                      flexShrink: 1,
                      overflow: "hidden",
                    } as const;
                    return (
                      <RoleBadge
                        data-testid="event-organizer-badge"
                        borderColor={
                          immersiveHero ? heroDividerColor : undefined
                        }
                        flexShrink={1}
                        minWidth={0}
                        maxWidth="100%"
                      >
                        <XStack
                          gap={6}
                          alignItems="center"
                          flexShrink={1}
                          minWidth={0}
                        >
                          <User
                            size={14}
                            color={heroMutedIconColor}
                            aria-hidden="true"
                          />
                          {organizerHref ? (
                            <Link
                              href={organizerHref}
                              style={{
                                textDecoration: "none",
                                ...shrinkStyle,
                              }}
                            >
                              {badgeText}
                            </Link>
                          ) : (
                            <XStack {...shrinkStyle}>{badgeText}</XStack>
                          )}
                        </XStack>
                      </RoleBadge>
                    );
                  })()}
                {venueName && (
                  // Measured at 320px: with the "Confirmed by venue" mark
                  // beside the link this badge ran 397px wide in a 240px
                  // column and the whole page shrank to fit. Stacks default
                  // to flexShrink 0, so the badge shrinks explicitly, its
                  // row WRAPS (the mark drops under the link when there is
                  // no room, its hairline becoming a leading rule on that
                  // line), and the link ellipsises a long venue name.
                  <RoleBadge
                    data-testid="event-venue-badge"
                    borderColor={immersiveHero ? heroDividerColor : undefined}
                    flexShrink={1}
                    minWidth={0}
                    maxWidth="100%"
                  >
                    <XStack
                      gap={6}
                      rowGap={4}
                      alignItems="center"
                      flexWrap="wrap"
                      // Tamagui stacks default to flexShrink 0; without this the
                      // row keeps its single-line max-content width and spills
                      // out of the badge instead of wrapping (measured: 427px
                      // scrollWidth at a 320px viewport).
                      flexShrink={1}
                      minWidth={0}
                    >
                      <MapPin
                        size={14}
                        color={heroMutedIconColor}
                        aria-hidden="true"
                      />
                      {/* NAME and LINK are separate decisions (see
                          build-event-seo.ts). The venue name is public
                          directory data and renders whenever the server sends
                          it; `placeSlug` only decides whether it is also a
                          link. A venue with no EntityPage — every
                          bulk-imported one — reads as plain text rather than
                          vanishing from the page. Identical styling either
                          way: the shrink/truncate props are what stop a long
                          name overflowing at 320px, so they belong on
                          whichever element is rendered. */}
                      {(() => {
                        const venueLabel = (
                          <Text
                            truncate
                            style={{
                              display: "block",
                              fontSize: mobile ? 12 : 13,
                              fontWeight: "500",
                              ...(immersiveHero
                                ? { color: heroMutedInk }
                                : {}),
                            }}
                            tone="muted"
                          >
                            {String(
                              t("eventDetail.atVenue", { name: venueName }),
                            )}
                          </Text>
                        );
                        const shrinkStyle = {
                          minWidth: 0,
                          flexShrink: 1,
                          overflow: "hidden",
                        } as const;
                        return placeSlug ? (
                          <Link
                            href={`/places/${placeSlug}`}
                            style={{ textDecoration: "none", ...shrinkStyle }}
                          >
                            {venueLabel}
                          </Link>
                        ) : (
                          <XStack
                            data-testid="event-venue-name-plain"
                            {...shrinkStyle}
                          >
                            {venueLabel}
                          </XStack>
                        );
                      })()}
                      {/* "Confirmed by venue" (venue-confirmation spec): the
                          venue vouched for this listing. Mono overline, muted,
                          a hairline off the venue link. Plain text carries the
                          whole phrase; the glyph is ornament. */}
                      {venueConfirmed && (
                        <XStack
                          gap={4}
                          alignItems="center"
                          paddingLeft={6}
                          borderLeftWidth={1}
                          borderLeftColor={
                            immersiveHero ? heroDividerColor : "$borderColor"
                          }
                          data-testid="event-venue-confirmed"
                        >
                          <BadgeCheck
                            size={12}
                            color={heroMutedIconColor}
                            aria-hidden="true"
                          />
                          <Text
                            variant="overline"
                            tone="muted"
                            style={
                              immersiveHero ? { color: heroMutedInk } : undefined
                            }
                          >
                            {String(t("eventDetail.confirmedByVenue"))}
                          </Text>
                        </XStack>
                      )}
                    </XStack>
                  </RoleBadge>
                )}
              </XStack>
            )}

            {/* Verified-attendee rating line, directly under the organizer
              attribution (attendee-reviews FR-005c). Self-gating: renders
              nothing until a publishable aggregate exists. */}
            {organizerRating}

            {/* Quick meta row (date + location text + starting price) */}
            <XStack
              gap={mobile ? 14 : 20}
              flexWrap="wrap"
              alignItems="center"
              style={{
                borderTop: `2px solid ${heroDividerColor}`,
                paddingTop: 16,
              }}
            >
              {/* Date/location legs must be able to SHRINK (flexShrink 1 +
                minWidth 0 down the chain — stack children default to
                flexShrink 0), or the full uppercase date renders as one
                intrinsic-width line (~360px) that overflows the hero and
                stretches the mobile layout viewport, pulling every
                position:fixed element (grid overlay) wider than
                the visual viewport. Wrapping to a second line is preferred
                over ellipsis — dates are content. Icons pin to the first
                line via alignItems flex-start + a small optical offset. */}
              <XStack
                gap={6}
                alignItems="flex-start"
                flexShrink={1}
                minWidth={0}
              >
                <Calendar
                  size={iconSize}
                  color={heroIconColor}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 3 }}
                />
                <Text
                  flexShrink={1}
                  style={{
                    fontSize: metaFontSize,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    minWidth: 0,
                    overflowWrap: "break-word",
                  }}
                  color={heroInkToken}
                >
                  {startsAt
                    ? formatDateForDisplay(startsAt)
                    : String(t("common.dateNotSet"))}
                </Text>
              </XStack>
              {location && (
                <XStack
                  gap={6}
                  alignItems="flex-start"
                  flexShrink={1}
                  minWidth={0}
                >
                  <MapPin
                    size={iconSize}
                    color={heroIconColor}
                    aria-hidden="true"
                    style={{ flexShrink: 0, marginTop: 3 }}
                  />
                  <Text
                    flexShrink={1}
                    style={{
                      fontSize: metaFontSize,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      minWidth: 0,
                      overflowWrap: "break-word",
                    }}
                    color={heroInkToken}
                  >
                    {location}
                  </Text>
                </XStack>
              )}
              {/* The starting price rides the meta row on the classic and
                  community heroes only. Poster-first, it moves to the buy
                  band (wide) and the docked price bar (phone) — see below. */}
              {!heroSplit && priceSummary && (
                <XStack
                  gap={10}
                  alignItems="center"
                  flexWrap="wrap"
                  flexShrink={1}
                  minWidth={0}
                >
                  {/* The breakdown sits on its own line UNDER the figure, as
                      on the buy band, so it can't read as a second price.
                      Shrinkable down the chain so it WRAPS at 320px. */}
                  <YStack gap={2} flexShrink={1} minWidth={0}>
                    <Text
                      style={{ fontSize: metaFontSize, fontWeight: "700" }}
                      color={heroInkToken}
                    >
                      {priceIsFrom
                        ? String(t("common.fromPrice", { value: priceFigure }))
                        : priceFigure}
                    </Text>
                    {priceBreakdownLong && (
                      <Text
                        flexShrink={1}
                        style={{
                          fontSize: metaFontSize - 2,
                          minWidth: 0,
                          overflowWrap: "break-word",
                        }}
                        color={heroMutedInk ?? "$colorMuted"}
                        data-testid="event-hero-price-breakdown"
                      >
                        {priceBreakdownLong}
                      </Text>
                    )}
                  </YStack>
                  {priceHint && (
                    <Text
                      style={{ fontSize: metaFontSize - 2 }}
                      color={heroMutedInk ?? "$colorMuted"}
                    >
                      {priceHint}
                    </Text>
                  )}
                  {remainingLine && (
                    <Text
                      style={{ fontSize: metaFontSize - 2 }}
                      color={heroMutedInk ?? "$colorMuted"}
                    >
                      {remainingLine}
                    </Text>
                  )}
                </XStack>
              )}
            </XStack>
              </>
            )}

            {/* The buy, in the hero, beside the price the hero already
                quotes. Before this the nearest button was 1,452px down a
                2,254px page — the reader was told what it costs and given
                nothing to press for another screen and a half. */}
            {canBuy && !heroSplit && (
              <XStack paddingTop={4}>
                {renderBuyButton("event-hero-get-tickets-btn", mobile)}
              </XStack>
            )}

            {/* Edit button (admins only — inline, not CTA).
              On the immersive hero the `secondary` variant's themed ink
              border/label ($structure/$color — ink on Stub) vanishes on the
              dark scrim, so override to the same on-dark chrome ShareDropdown
              uses: a light hairline border + $onStructure ink. The label and
              Pencil icon both follow via `color: inherit`/currentColor. Hover
              keeps the variant's $structure fill + $onStructure label (a
              sanctioned AA pair in every theme). Classic (embeds, admin
              preview) rendering is unchanged. */}
            {editHref && (
              <Link href={editHref} style={{ display: "block", width: "100%" }}>
                <Button
                  tag="span"
                  variant="secondary"
                  size="$4"
                  style={{
                    width: "100%",
                    // Per-side longhands, not the `borderColor` shorthand: the
                    // Tamagui variant already paints per-side border colors, and
                    // mixing a shorthand into the same inline style loses to
                    // them (dark ink border survives) + trips React's
                    // conflicting-style warning on every rerender.
                    ...(immersiveHero
                      ? {
                          borderTopColor: heroDividerColor,
                          borderRightColor: heroDividerColor,
                          borderBottomColor: heroDividerColor,
                          borderLeftColor: heroDividerColor,
                          color: heroInkVar,
                        }
                      : {}),
                  }}
                >
                  <Pencil size={16} aria-hidden="true" />
                  {String(t("common.editEvent"))}
                </Button>
              </Link>
            )}
          </YStack>
  );

  // ── The facts: Schedule, Location, the map ─────────────────────────────
  // Rendered in one of two places. Classic: at the head of the logistics
  // block, the map beside the text. Poster-first (canvas board E1): UNDER
  // THE POSTER, in the rail column, which a landscape photo otherwise left
  // empty for a whole screen while the decision column ran on. The section
  // numbers do not change — Schedule and Location are still 01 and 02, and
  // top-to-bottom, left-to-right they still come first.
  // Schedule — condensed: only the end time, since the start is in the meta row.
  const scheduleSection = startsAt ? (
                <YStack gap={10}>
                  <SectionTitle>
                    <EventSectionNum aria-hidden>
                      {scheduleSectionNum}
                    </EventSectionNum>
                    {String(t("eventDetail.scheduleSection"))}
                  </SectionTitle>
                  <YStack gap={10}>
                    {endsAt ? (
                      <XStack gap={10} alignItems="center">
                        <Clock
                          size={iconSize}
                          color={FOREGROUND}
                          style={{ flexShrink: 0 }}
                          aria-hidden="true"
                        />
                        <Text
                          style={{
                            fontSize: mobile ? 15 : 16,
                            fontWeight: "700",
                          }}
                          color="$color"
                        >
                          {String(t("eventDetail.scheduleEnds"))}
                        </Text>
                        <Text
                          style={{ fontSize: mobile ? 15 : 16 }}
                          color="$color"
                        >
                          {formatDateForDisplay(endsAt)}
                        </Text>
                      </XStack>
                    ) : (
                      <XStack gap={10} alignItems="center">
                        <Calendar
                          size={iconSize}
                          color={FOREGROUND}
                          style={{ flexShrink: 0 }}
                          aria-hidden="true"
                        />
                        <Text
                          style={{ fontSize: mobile ? 15 : 16 }}
                          color="$color"
                        >
                          {formatDateForDisplay(startsAt)}
                        </Text>
                      </XStack>
                    )}
                  </YStack>
                  {/* Calendar add: single button with dropdown. Poster-first
                      the rail carries the same control from 768px, so this
                      one hides there (`.event-schedule-calendar`) — two
                      buttons named "Add to calendar" on one page is the
                      accessible-name collision the passkey page shipped. */}
                  <div className="event-schedule-calendar">
                    <CalendarDropdown
                      title={title}
                      startsAt={startsAt}
                      endsAt={endsAt}
                      location={location}
                      eventId={eventId}
                      timezone={timezone}
                      recurrence={communityRecurrence}
                    />
                  </div>
                </YStack>
  ) : null;

  // Location + address — text only; the map is `mapColumn` (the embed's
  // inline one rides along here, gated on the EMBED flag).
  const locationSection = (
    <>
              {(location || address) && (
                <YStack gap={12} data-testid="event-location-section">
                  <SectionTitle>
                    <EventSectionNum aria-hidden>
                      {locationSectionNum}
                    </EventSectionNum>
                    {String(t("eventDetail.locationSection"))}
                  </SectionTitle>
                  <XStack gap={10} alignItems="flex-start">
                    <MapPin
                      size={iconSize}
                      color={FOREGROUND}
                      style={{ marginTop: 2, flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    <YStack gap={4} flex={1}>
                      {location &&
                        (addressMapsHref ? (
                          <a
                            href={addressMapsHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ textDecoration: "none" }}
                          >
                            <Text
                              style={{
                                fontSize: mobile ? 15 : 16,
                                fontWeight: "500",
                              }}
                              color="$accentText"
                              data-testid="event-location-text"
                            >
                              {location}
                            </Text>
                          </a>
                        ) : (
                          <Text
                            style={{
                              fontSize: mobile ? 15 : 16,
                              fontWeight: "500",
                            }}
                            color="$color"
                            data-testid="event-location-text"
                          >
                            {location}
                          </Text>
                        ))}
                      {address &&
                        (addressMapsHref ? (
                          <a
                            href={addressMapsHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ textDecoration: "none" }}
                          >
                            <Text
                              style={{ fontSize: mobile ? 14 : 15 }}
                              color="$color"
                            >
                              {address}
                            </Text>
                          </a>
                        ) : (
                          <Text
                            style={{ fontSize: mobile ? 14 : 15 }}
                            color="$color"
                          >
                            {address}
                          </Text>
                        ))}
                      {placeSlug && (
                        <Link
                          href={`/places/${placeSlug}`}
                          style={{ marginTop: 2, textDecoration: "none" }}
                        >
                          <Text
                            style={{
                              fontSize: mobile ? 13 : 14,
                              fontWeight: "500",
                            }}
                            color="$accentText"
                            data-testid="event-location-venue-link"
                          >
                            {String(t("eventDetail.viewVenuePage"))}
                          </Text>
                        </Link>
                      )}
                    </YStack>
                    {locationPublishesAddress && (location || address) && (
                      <CopyAddressButton
                        copied={addressCopied}
                        onCopy={handleCopyAddress}
                        inkColor={FOREGROUND}
                        copyLabel={String(t("eventDetail.copyAddress"))}
                        copiedLabel={String(t("eventDetail.copied"))}
                      />
                    )}
                  </XStack>
                  {gettingThere}
                </YStack>
              )}

              {/* Mobile-only: map + directions inline (stacked beneath location text) */}
              {mobile && showableLocationCoords && (
                <YStack
                  gap={12}
                  data-testid="event-location-map-container"
                  style={{ marginTop: 4 }}
                >
                  <LocationMapPreview
                    latitude={showableLocationCoords.latitude}
                    longitude={showableLocationCoords.longitude}
                    label={showableLocationCoords.label}
                    isExact={showableLocationCoords.isExact}
                    radiusMeters={showableLocationCoords.radiusMeters}
                    preObfuscated={coordsArePreObfuscated}
                  />

                  {/* Directions dropdown — all map providers. Exact coords
                      only: pre-reveal there is nothing to navigate to. */}
                  {coordsAreExact && (
                    <div data-testid="event-location-directions">
                      <DirectionsDropdown
                        coords={{
                          latitude: showableLocationCoords.latitude,
                          longitude: showableLocationCoords.longitude,
                          label: location,
                        }}
                        address={location}
                        labels={{
                          trigger: String(t("eventDetail.getDirections")),
                          google: String(t("eventDetail.directionsGoogle")),
                          apple: String(t("eventDetail.directionsApple")),
                          waze: String(t("eventDetail.directionsWaze")),
                          copyAddress: String(t("eventDetail.copyAddress")),
                          copied: String(t("eventDetail.copied")),
                        }}
                      />
                    </div>
                  )}

                  {/* Travel time from user's location (feature-gated) */}
                  {coordsAreExact && gates?.travelTime && (
                    <TravelTimeWidget
                      destinationLat={showableLocationCoords.latitude}
                      destinationLng={showableLocationCoords.longitude}
                      mobile
                    />
                  )}
                </YStack>
              )}
    </>
  );

  // The map + directions (never in the embed, which has no room for it).
  const mapColumn =
            !mobile && showableLocationCoords ? (
              <div
                style={{
                  // min() caps the card at its container: `mobile` is the
                  // EMBED flag, so real phones render this column too, and a
                  // hard 300px overflowed a 320px viewport (expanding the
                  // mobile layout viewport and dragging fixed bars offscreen).
                  // Stacked under the text (poster-first: in the facts under
                  // the poster): the column's full width, and no sticky — the
                  // rail column is the one sticky thing on that page.
                  width: heroSplit ? "100%" : "min(300px, 100%)",
                  flexShrink: 0,
                  position: heroSplit ? "static" : "sticky",
                  top: heroSplit ? undefined : 24,
                  alignSelf: "flex-start",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
                data-testid="event-location-map-container"
              >
                <LocationMapPreview
                  latitude={showableLocationCoords.latitude}
                  longitude={showableLocationCoords.longitude}
                  label={showableLocationCoords.label}
                  isExact={showableLocationCoords.isExact}
                  radiusMeters={showableLocationCoords.radiusMeters}
                  preObfuscated={coordsArePreObfuscated}
                  height="16rem"
                  arrivalAreas={mapArrivalAreas}
                />
                {legendShown && (
                  <ArrivalAreasLegend areas={visibleArrivalAreas} />
                )}
                {/* Directions — exact coords only: pre-reveal there is
                    nothing to navigate to. */}
                {coordsAreExact && (
                  <div data-testid="event-location-directions-desktop">
                    <DirectionsDropdown
                      coords={{
                        latitude: showableLocationCoords.latitude,
                        longitude: showableLocationCoords.longitude,
                        label: location,
                      }}
                      address={location}
                      labels={{
                        trigger: String(t("eventDetail.getDirections")),
                        google: String(t("eventDetail.directionsGoogle")),
                        apple: String(t("eventDetail.directionsApple")),
                        waze: String(t("eventDetail.directionsWaze")),
                        copyAddress: String(t("eventDetail.copyAddress")),
                        copied: String(t("eventDetail.copied")),
                      }}
                    />
                  </div>
                )}

                {/* Travel time from user's location (feature-gated) */}
                {coordsAreExact && gates?.travelTime && (
                  <TravelTimeWidget
                    destinationLat={showableLocationCoords.latitude}
                    destinationLng={showableLocationCoords.longitude}
                  />
                )}
              </div>
            ) : null;

  const showFacts =
    showScheduleSection ||
    showLocationSection ||
    Boolean(!mobile && showableLocationCoords);
  const factsBlock = showFacts ? (
    <div className="event-page-split__facts" data-testid="event-page-facts">
      {scheduleSection}
      {locationSection}
      {mapColumn}
    </div>
  ) : null;

  // Poster-first, the logistics block opens on the lineup; without one, and
  // with nothing to sell, it has nothing to frame.
  const showLogisticsBlock = heroSplit
    ? showLineupSection ||
      showTicketsSection ||
      showRefundSection ||
      showRsvpSection ||
      Boolean(communityAttribution) ||
      Boolean(communityFooter) ||
      canBuy
    : hasLogistics;

  const contentStack = (
      <ContentStack
        /*
         * Poster-first, this is row 4 of the page grid — the numbered
         * sections flow in the SAME column as the h1 and the buy band, so the
         * page has two left edges, not three. The prose measure is the
         * column's: 544px at the page's 1088px cap (~65 characters at 16px),
         * which is the reading measure the design system asks for. It used
         * to be a 48rem block centred under the whole grid, aligned with
         * neither the rail nor the column.
         */
        className={heroSplit ? "event-page-split__content" : undefined}
        data-testid="event-content-stack"
        style={{
          // Poster-first, the grid owns the insets (`.event-page-split__content`
          // in event-content.css) and the cream ground is the page's own.
          ...(heroSplit ? {} : { padding: mobile ? 16 : 24 }),
          // When immersive, the fixed HeroBackdrop still sits behind the page
          // and its gradient has a dark mid-band at ~50% viewport. An opaque
          // cream surface here keeps below-fold dark ink off that band as it
          // scrolls through the middle of the viewport (stays AA on any
          // poster). Gated to immersive: embeds/admin preview have no backdrop
          // and stay transparent over the page. The hero above keeps its own
          // wrapper, so its backdrop glow is untouched.
          ...(immersiveHero && !heroSplit
            ? { backgroundColor: "var(--background, #F6F0E4)" }
            : {}),
        }}
      >
        {communityLayout ? (
          /* ── COMMUNITY LISTING BODY ────────────────────────────────
             The measured failure this replaces, on a 390x844 phone: the
             listing's own prose started at 2,188px of a 3,151px page,
             behind "01 Schedule" (whose only content was an end time, the
             start being in the meta row already) and "02 Location" (an
             address). The description now sits directly under the head,
             and those two sections collapse into one compact fact block.

             The numerals go with them. `docs/design/design-system-v2.md`
             §8 assigns index numbers to a real SEQUENCE; an end time, an
             address and a date list are three facts, not three steps.
             Ticketed events keep their numbering — nothing here touches
             that path.

             Desktop is a two-track grid (7fr / 5fr) with a STICKY rail,
             which is the other half of the fix: today the right column
             holds a ~300px map and then ~500px of dead space while the
             left column runs on. On a phone the tracks dissolve
             (`display: contents`) and the rail's items interleave back
             into one column — see `.community-body` in event-content.css. */
          <>
            <div className="community-body">
              {/* 1 — the description. First in the DOM because it is first
                  on the page: reading order IS DOM order in this layout, and
                  there is deliberately not one `order` rule below. */}
              <div className="community-body__track community-body__lead">
                {/* 1 — the description, first, which is the whole point. */}
                {bodyHtml && (
                  <div className="community-body__description">
                    <EventBodyContent
                      bodyHtml={bodyHtml}
                      className={contentClassName}
                    />
                  </div>
                )}
              </div>

              {/* 2 — the facts. The rail holds ONLY this block, and it sits
                  here rather than being pulled up visually, because it
                  carries the address link, "View venue page", copy-address
                  and "Suggest an edit". Reordering it with CSS put keyboard
                  focus and screen-reader order out of step with the paint
                  order — WCAG 1.3.2 and 2.4.3, both Level A. Keeping the map
                  out of the rail also keeps the sticky box short enough to
                  fit a 13" laptop viewport while pinned. */}
              <div className="community-body__track community-body__rail">
                {/* The fact block: WHERE / WHEN / LISTED BY (start and end in one
                    row, owner 2026-10-17). Mono keys on the
                    label idiom, Montserrat values. */}
                {hasCommunityFacts && (
                  <div
                    className="community-facts community-body__facts"
                    data-testid="community-fact-block"
                  >
                    {communityWhereValue && (
                      <div
                        className="community-facts__row"
                        data-testid="community-fact-where"
                      >
                        <span className="community-facts__key">
                          {String(t("eventDetail.factWhere"))}
                        </span>
                        {/* The address owns the FULL row width, and the
                            actions sit under it — they do not share a line
                            with it. Measured at 1440: with the copy control
                            beside the text the rail's 5fr column left the
                            address ~110px and it broke MID-WORD
                            ("Springwate / r Supper / Club &"). An address is
                            the one value on this page a reader may need to
                            copy by eye. */}
                        <XStack gap={8} alignItems="flex-start">
                          <MapPin
                            size={iconSize}
                            color={FOREGROUND}
                            style={{ marginTop: 4, flexShrink: 0 }}
                            aria-hidden="true"
                          />
                          <YStack gap={8} flex={1} minWidth={0}>
                            {addressMapsHref ? (
                              <a
                                href={addressMapsHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="community-facts__value"
                                data-testid="event-location-text"
                              >
                                {communityWhereValue}
                              </a>
                            ) : (
                              <span
                                className="community-facts__value"
                                data-testid="event-location-text"
                              >
                                {communityWhereValue}
                              </span>
                            )}
                            {placeSlug && (
                              <Link
                                href={`/places/${placeSlug}`}
                                style={{ textDecoration: "none" }}
                              >
                                <Text
                                  style={{ fontSize: 14, fontWeight: "500" }}
                                  color="$accentText"
                                  data-testid="event-location-venue-link"
                                >
                                  {String(t("eventDetail.viewVenuePage"))}
                                </Text>
                              </Link>
                            )}
                            {/* Withheld events get no copy-address control.
                                It used to render for them and copy the coarse
                                area label — an affordance promising an address
                                the venue deliberately does not publish. */}
                            {locationPublishesAddress && (
                              <XStack
                                gap={14}
                                alignItems="center"
                                flexWrap="wrap"
                              >
                                <CopyAddressButton
                                  copied={addressCopied}
                                  onCopy={handleCopyAddress}
                                  inkColor={FOREGROUND}
                                  copyLabel={String(
                                    t("eventDetail.copyAddress"),
                                  )}
                                  copiedLabel={String(t("eventDetail.copied"))}
                                />
                              </XStack>
                            )}
                          </YStack>
                        </XStack>
                        {gettingThere}
                      </div>
                    )}

                    {communityWhen && (
                      <div
                        className="community-facts__row"
                        data-testid="community-fact-when"
                      >
                        <span className="community-facts__key">
                          {String(t(communityWhen.key))}
                        </span>
                        <XStack gap={8} alignItems="flex-start">
                          <Clock
                            size={iconSize}
                            color={FOREGROUND}
                            style={{ marginTop: 4, flexShrink: 0 }}
                            aria-hidden="true"
                          />
                          <span className="community-facts__value">
                            {communityWhen.value}
                          </span>
                        </XStack>
                      </div>
                    )}

                    {/* The community byline + "Suggest an edit" + the
                        "How this works" disclosure, exactly as they render
                        today — reused, not rebuilt. */}
                    {communityAttribution && (
                      <div
                        className="community-facts__row"
                        data-testid="community-fact-listed-by"
                      >
                        <span className="community-facts__key">
                          {String(t("eventDetail.factListedBy"))}
                        </span>
                        {communityAttribution}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 3 — the rest, in the order it is read: lineup, dates, then
                  the map and the navigation actions. */}
              <div className="community-body__track community-body__rest">
                {/* Lineup, when a community listing has one. Unnumbered,
                    like every other heading in this branch. */}
                {visibleLineup.length > 0 && (
                  <YStack gap={10} className="community-body__lineup">
                    <SectionTitle>
                      {String(t("eventDetail.lineupSection"))}
                    </SectionTitle>
                    <YStack gap={4}>
                      {visibleLineup.map((eh) => (
                        <LineupListenEntry
                          key={eh.id}
                          human={eh}
                          mobile={mobile}
                          autoExpand={eh.id === autoExpandListenId}
                        />
                      ))}
                    </YStack>
                  </YStack>
                )}

                {/* Upcoming dates (recurring) or the single "Going?" toggle —
                    the same CommunityDateList / RsvpButton as before. */}
                {rsvpAction && (
                  <YStack
                    gap={10}
                    className="community-body__dates"
                    data-testid="event-rsvp-section"
                  >
                    <SectionTitle>
                      {rsvpSectionTitle ?? String(t("eventDetail.goingSection"))}
                    </SectionTitle>
                    {rsvpAction}
                  </YStack>
                )}

                {(showableLocationCoords || startsAt) && (
                  <YStack gap={12} className="community-body__map">
                    {showableLocationCoords && (
                      <div data-testid="event-location-map-container">
                        <LocationMapPreview
                          latitude={showableLocationCoords.latitude}
                          longitude={showableLocationCoords.longitude}
                          label={showableLocationCoords.label}
                          isExact={showableLocationCoords.isExact}
                          radiusMeters={showableLocationCoords.radiusMeters}
                          preObfuscated={coordsArePreObfuscated}
                          height="16rem"
                          arrivalAreas={mapArrivalAreas}
                        />
                      </div>
                    )}
                    {showableLocationCoords && legendShown && (
                      <ArrivalAreasLegend areas={visibleArrivalAreas} />
                    )}
                    {/* Exact coords only: the obfuscated pre-reveal point is
                        deliberately NOT the venue, so there is nothing to
                        navigate to. */}
                    {showableLocationCoords && coordsAreExact && (
                      <div data-testid="event-location-directions">
                        <DirectionsDropdown
                          coords={{
                            latitude: showableLocationCoords.latitude,
                            longitude: showableLocationCoords.longitude,
                            label: location,
                          }}
                          address={location}
                          labels={{
                            trigger: String(t("eventDetail.getDirections")),
                            google: String(t("eventDetail.directionsGoogle")),
                            apple: String(t("eventDetail.directionsApple")),
                            waze: String(t("eventDetail.directionsWaze")),
                            copyAddress: String(t("eventDetail.copyAddress")),
                            copied: String(t("eventDetail.copied")),
                          }}
                        />
                      </div>
                    )}
                    {showableLocationCoords &&
                      coordsAreExact &&
                      gates?.travelTime && (
                        <TravelTimeWidget
                          destinationLat={showableLocationCoords.latitude}
                          destinationLng={showableLocationCoords.longitude}
                          mobile={mobile}
                        />
                      )}
                    {startsAt && (
                      <CalendarDropdown
                        title={title}
                        startsAt={startsAt}
                        endsAt={endsAt}
                        location={location}
                        eventId={eventId}
                        timezone={timezone}
                        recurrence={communityRecurrence}
                      />
                    )}
                  </YStack>
                )}
              </div>
            </div>

            {/* The recruitment band, LAST — present but never competing
                with the listing. */}
            {communityFooter}
          </>
        ) : (
          <>
        {/* ── Body content ────────────────────────────────────────── */}
        {/* The prose leads: it is the organiser's own account of the show,
            and the numbered logistics below it are reference material the
            reader scans afterwards. Moved in the DOM rather than with CSS
            `order`, for the reason the community branch above states —
            keyboard focus and screen-reader order must match paint order
            (WCAG 1.3.2 and 2.4.3, both Level A). Numbering is unaffected:
            the "0N." labels are assigned from the visibility flags computed
            near the top of this component, not from DOM position, and the
            prose carries no numeral. */}
        {bodyHtml && (
          <EventBodyContent bodyHtml={bodyHtml} className={contentClassName} />
        )}

        {/* ── Logistics block ─────────────────────────────────────── */}
        {showLogisticsBlock && (
          <div
            // `.logistics-row` puts the map BESIDE the text from 768px. That
            // is a rule for the 720px one-column measure; the poster-first
            // decision column is never wider than 624px, and MEASURED at 1440
            // (544px) the side-by-side left the address and the ticket names
            // breaking mid-word in a ~110px column. There the map stacks
            // below, at the column's full width.
            className={`event-content-logistics${showableLocationCoords && !mobile && !heroSplit ? " logistics-row" : ""}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 0,
              borderTop: "1px solid var(--borderColor, #211C16)",
              borderBottom: "1px solid var(--borderColor, #211C16)",
              paddingTop: 20,
              paddingBottom: 20,
            }}
          >
            {/* ── Left column: logistics content ── */}
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 24,
                minWidth: 0,
              }}
            >
              {/* Schedule and Location lead the block on the classic page.
                  Poster-first they are the FACTS under the poster instead
                  (`factsBlock`, in the rail column), and this block opens on
                  the lineup. */}
              {!heroSplit && scheduleSection}
              {!heroSplit && locationSection}

              {/* Lineup (volunteers excluded — see visibleLineup) */}
              {visibleLineup.length > 0 && (
                <YStack gap={10}>
                  <SectionTitle>
                    <EventSectionNum aria-hidden>
                      {lineupSectionNum}
                    </EventSectionNum>
                    {String(t("eventDetail.lineupSection"))}
                  </SectionTitle>
                  <YStack gap={4}>
                    {visibleLineup.map((eh) => (
                      <LineupListenEntry
                        key={eh.id}
                        human={eh}
                        mobile={mobile}
                        autoExpand={eh.id === autoExpandListenId}
                      />
                    ))}
                  </YStack>
                </YStack>
              )}

              {/* Community-maintained host attribution (ownerless listings —
                  occupies the organizer/lineup slot) */}
              {communityAttribution}

              {/* Tickets — never rendered alongside the RSVP action (RSVP
                  events have no ticket types by design) */}
              {!rsvpAction && ticketTypes.length > 0 && (
                <TicketsSection
                  sectionNumber={ticketsSectionNum}
                  ticketTypes={ticketTypes}
                  feeMode={feeMode}
                  feeEstimateMap={feeEstimateMap}
                  admissionTaxRateBps={admissionTaxRateBps}
                  platformFeeLabel={platformFeeLabel}
                  platformFeeRates={platformFeeRates}
                  processorFeeLabel={processorFeeLabel}
                  mobile={mobile}
                  currency={currency}
                  // FR-010: sales windows and price flips render on the EVENT's
                  // clock, not the reader's.
                  timezone={timezone}
                />
              )}

              {/* The second buy affordance, for a reader who came down the
                  page. It used to be the ONLY one, wrapped in
                  `position: sticky; bottom: 0` under a comment claiming it
                  "survives a long scroll" — measured at 390px scrolled to
                  mid-page, its rect was `top: -229`: sticky holds only while
                  its containing block is in view, and that block ends long
                  before the page does. The wrapper is gone; the hero carries
                  the buy above the fold instead. */}
              {canBuy && renderBuyButton("event-get-tickets-btn", true)}

              {/* ── Refund policy disclosure ──────────────────────────
                  Plain fact, no urgency framing — calm-honest-ux FR-004.
                  Hidden entirely when `refundCutoffAt` is omitted/undefined
                  (RSVP/community listings have no ticketing, so no refund
                  policy applies). The real backend deadline is
                  `refundCutoffAt ?? startsAt` (see get-refund-eligibility.ts)
                  — an absolute datetime, never an hours-before-event window.
                  `null` means no organizer override, so the true default
                  applies: refunds are available until the event starts. Only
                  when the organizer set a real cutoff earlier than `startsAt`
                  do we disclose that specific date/time; anything else (no
                  override, or a same-day/undefined `startsAt` to compare
                  against) falls back to the always-true "until event starts"
                  copy. */}
              {refundCutoffAt !== undefined && (
                <YStack gap={8} data-testid="event-refund-policy-section">
                  <SectionTitle>
                    <EventSectionNum aria-hidden>
                      {refundSectionNum}
                    </EventSectionNum>
                    {String(t("eventDetail.refundPolicySection"))}
                  </SectionTitle>
                  <XStack gap={10} alignItems="center">
                    <Shield
                      size={iconSize}
                      color={FOREGROUND}
                      style={{ flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    <Text style={{ fontSize: mobile ? 14 : 15 }} color="$color">
                      {refundCutoffAt &&
                      startsAt &&
                      new Date(refundCutoffAt).getTime() <
                        new Date(startsAt).getTime()
                        ? String(
                            t("eventDetail.refundPolicyUntilDate", {
                              date: formatDateForDisplay(refundCutoffAt),
                            }),
                          )
                        : String(t("eventDetail.refundPolicyUntilStart"))}
                    </Text>
                  </XStack>
                </YStack>
              )}

              {/* "I'm going" — RSVP listings' primary action, in the slot
                  the tickets section occupies on ticketed events */}
              {rsvpAction && (
                <YStack gap={10} data-testid="event-rsvp-section">
                  <SectionTitle>
                    <EventSectionNum aria-hidden>
                      {rsvpSectionNum}
                    </EventSectionNum>
                    {rsvpSectionTitle ?? String(t("eventDetail.goingSection"))}
                  </SectionTitle>
                  {rsvpAction}
                </YStack>
              )}

              {/* De-emphasized community footer band (e.g. "apply to
                  moderate"), pinned to the bottom of the left column. */}
              {communityFooter}
            </div>
            {/* end left column */}

            {/* The map, beside the text (classic) — see `mapColumn`. */}
            {!heroSplit && mapColumn}
          </div>
        )}
          </>
        )}

        {/* ── Tags ────────────────────────────────────────────────── */}
        {tags.length > 0 && (
          <YStack gap={10} className="event-content-tickets-section">
            <XStack flexWrap="wrap" gap={8}>
              {/* The chip keeps its strong ink fill, so its label and glyph
                  MUST ride `$onStructure`. They were `$colorMuted`, which on
                  the `$surfaceStrong` fill is 2.27:1 on Stub / 1.41:1 on Swiss
                  — unreadable. globals.css only force-fixed this inside
                  `body.th-embed-body`, so embeds looked right while the main
                  site shipped broken. `$onStructure` is the only foreground
                  that clears AA here in all three themes (16.2 / 7.0 / 9.5),
                  and it matches what that embed override was already forcing —
                  so the CSS hack is now redundant and can be deleted. */}
              {tags.map((tag) => (
                <XStack
                  key={tag.slug}
                  alignItems="center"
                  gap={4}
                  paddingHorizontal={10}
                  paddingVertical={5}
                  borderRadius={0}
                  backgroundColor="$surfaceStrong"
                >
                  {/* The CSS var, not `theme.onStructure.val`: a raw JS value
                      can't follow the embed's host-colour bridge, so the
                      glyph would stay ink when the fill turns white. */}
                  <Hash size={12} color="var(--onStructure)" aria-hidden="true" />
                  <Text
                    style={{ fontSize: 13, fontWeight: 500 }}
                    color="$onStructure"
                  >
                    {tag.name}
                  </Text>
                </XStack>
              ))}
            </XStack>
          </YStack>
        )}
      </ContentStack>
  );

  // ── Notify-me sign-up form ─────────────────────────────────────────────
  // Behind the `waitlists` gate: fail-CLOSED (`=== true`), so while the gates
  // are loading — or the API is down — the join form stays hidden rather than
  // promising a notification the platform can't send yet.
  const waitlistForm =
    gates?.waitlists === true && waitlistOpen && eventId ? (
        <div
          style={{
            padding: heroSplit ? 0 : mobile ? "0 16px 16px" : "0 24px 20px",
            maxWidth: heroSplit ? undefined : 960,
          }}
        >
          <WaitlistJoinForm
            eventId={eventId}
            description={waitlistDescription}
            mobile={mobile}
          />
        </div>
    ) : null;

  if (heroSplit) {
    /*
     * ── The poster-first page ──────────────────────────────────────────────
     * ONE grid, eight siblings, no nesting between them — that is the whole
     * fix for the three left edges. Wide (>=768px, event-content.css):
     *
     *   row 1   back link              (cols 1-2, over the band)
     *   row 2   aside | meta block     (the aside — poster, actions, FACTS —
     *   row 3         | buy band        spans rows 2-5 as one sticky unit)
     *   row 4         | ContentStack   (lineup, tickets, refund, IN the column)
     *   row 5         | after          (waitlist, volunteers, resale)
     *
     * The band and its fade are aria-hidden grid items painted UNDER rows 1-2
     * and the top of row 3; they are what remains of the scrim, reshaped to
     * the text it now backs. Narrow, the same DOM is a ONE-column grid: the
     * poster full-bleed in row 1, the paper sheet riding up over its bottom
     * edge in row 2, the facts in row 3, the sections in row 4, and the price
     * docked in a fixed bar at the bottom.
     *
     * DOM ORDER vs PAINT ORDER — a recorded decision. The sheet (the h1)
     * precedes the aside in the DOM so a screen reader meets the title, the
     * badges and the meta row before the poster's chrome and the facts; on a
     * phone the grid still paints the poster first. The cost is that Tab runs
     * title links → back/save/share squares → facts, i.e. up the screen once.
     * The community body refused a CSS reorder (WCAG 1.3.2 / 2.4.3) because
     * there it moved a whole fact block past prose; here it moves three chrome
     * squares past a heading, and heading-first is the better trade.
     */
    const rootClass = [
      "event-page-split",
      immersiveHero ? "event-page-split--immersive" : "",
      canBuy ? "event-page-split--bar" : "",
      heroFollowsNotice ? "event-page-split--after-notice" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <article aria-label={title}>
        <div
          className={rootClass}
          data-testid="event-page-split"
          style={
            {
              "--navbar-visible": `${navbarVisibleHeight}px`,
            } as CSSProperties
          }
        >
          {immersiveHero && (
            <div
              aria-hidden
              className="event-page-split__band"
              data-testid="event-page-band"
            />
          )}
          {immersiveHero && (
            // The backdrop's window ends here: HeroBackdrop clips itself to
            // this element's bottom edge, so nothing below the fade — the
            // paper, the footer — has the blurred poster under it.
            <div
              aria-hidden
              className="event-page-split__fade"
              data-hero-backdrop-window=""
            />
          )}
          {backLink && (
            <div className="event-page-split__back">{backLink}</div>
          )}

          {/* The paper sheet. Narrow it is literally that — cream, a 2px ink
              top rule, pulled 24px up over the poster's bottom edge. Wide it
              is the top of the decision column, transparent over the band.
              FIRST in the DOM, before the rail: the title is the first thing
              a screen reader should meet, and the grid places the poster
              above it visually on a phone (`grid-row`), so DOM order and
              paint order part ways here on purpose. */}
          <div className="event-page-split__sheet" data-testid="event-page-sheet">
            {metaBlock}
          </div>

          {/* The rail column: the poster with Save / Share / Calendar under
              it, and under THOSE the facts (canvas board E1). Wide, it is one
              sticky unit that pins while it fits the viewport; narrow, it
              dissolves (`display: contents`) so the poster takes row 1 and
              the facts sit under the sheet in row 3. Deliberately NO overflow
              anywhere in this subtree above the poster frame: the Share and
              Calendar menus open from here. */}
          <div className="event-page-split__aside" data-testid="event-page-aside">
          <div className="event-page-split__rail" data-testid="event-poster-rail">
            {posterFrame}
            <div className="event-poster-chrome">
              {backHref && (
                /* Wrapped, because the stylesheet hides this wide and the
                   anchor Next renders carries its own `display`. */
                <div className="event-poster-chrome__back">
                  <Link
                    href={backHref}
                    aria-label={resolvedBackLabel}
                    className="event-poster-action"
                    data-testid="event-poster-back"
                  >
                    {/* Explicit, not `currentColor`: the anchor Next renders
                        carries the themed ink, which is invisible over the
                        poster. The square is a fixed-dark surface, so the
                        glyph takes the fixed half of the scrim pair. */}
                    <ArrowLeft
                      size={17}
                      strokeWidth={2.4}
                      color="var(--onScrim, #FDFAF3)"
                      aria-hidden="true"
                    />
                  </Link>
                </div>
              )}
              <div className="event-poster-chrome__actions">
                {saveAction}
                <ShareDropdown title={title} variant="poster" />
                {startsAt && (
                  <CalendarDropdown
                    variant="poster"
                    title={title}
                    startsAt={startsAt}
                    endsAt={endsAt}
                    location={location}
                    eventId={eventId}
                    timezone={timezone}
                    recurrence={communityRecurrence}
                  />
                )}
              </div>
            </div>
          </div>
          {factsBlock}
          </div>

          {/* The buy band — wide only; the docked bar carries the same price
              and CTA on a phone. Renders for a price alone (sold out: the
              tickets section says so) or a CTA alone (a free event with no
              tiers quoted). */}
          {(priceFigure || canBuy) && (
            <div className="event-buy-band" data-testid="event-buy-band">
              {priceFigure && (
                <div className="event-buy-band__price">
                  {priceIsFrom && (
                    <span className="event-price-label">
                      {String(t("eventCard.priceFrom"))}
                    </span>
                  )}
                  <span
                    className="event-buy-band__figure"
                    data-testid="event-buy-band-price"
                  >
                    {priceFigure}
                  </span>
                  {priceHint && (
                    // The band's existing muted caption style.
                    <span className="event-buy-band__remaining">
                      {priceHint}
                    </span>
                  )}
                  {priceBreakdownLong && (
                    <span
                      className="event-buy-band__remaining"
                      data-testid="event-buy-band-breakdown"
                    >
                      {priceBreakdownLong}
                    </span>
                  )}
                  {remainingLine && (
                    <span className="event-buy-band__remaining">
                      {remainingLine}
                    </span>
                  )}
                </div>
              )}
              {canBuy && (
                <div className="event-buy-band__cta">
                  {renderBuyButton("event-hero-get-tickets-btn", false, "$5")}
                </div>
              )}
            </div>
          )}

          {contentStack}

          <div className="event-page-split__after">
            {waitlistForm}
            {belowContent}
          </div>

          {/* The docked price bar (phone only — `display: none` from 768px).
              Portaled to <body> after mount: a `position: fixed` box inside
              the page column would be re-parented by any transformed
              ancestor, and the reveal animations transform. It docks ABOVE the
              shell's bottom nav (`--consumer-bottom-nav-height`), and
              `EventDetail` stands the nav's centre action down while this is
              on screen so the two never offer the same button twice. */}
          {canBuy &&
            portalReady &&
            createPortal(
              <div className="event-sticky-bar" data-testid="event-sticky-bar">
                <div className="event-sticky-bar__price">
                  {priceIsFrom && (
                    <span className="event-price-label event-price-label--on-ink">
                      {String(t("eventCard.priceFrom"))}
                    </span>
                  )}
                  {priceFigure && (
                    <span
                      className="event-sticky-bar__figure"
                      data-testid="event-sticky-bar-price"
                    >
                      {priceFigure}
                    </span>
                  )}
                  {priceBreakdownShort && (
                    <DockedBarPriceCaption text={priceBreakdownShort} />
                  )}
                </div>
                <div className="event-sticky-bar__cta">
                  {/* event-content.css's ≤359px padding rule selects this test id; renaming it breaks the 320px price fit. */}
                  {renderBuyButton("event-sticky-get-tickets-btn", true, "$5")}
                </div>
              </div>,
              document.body,
            )}
        </div>
      </article>
    );
  }

  return (
    <article aria-label={title}>
      {/* ── Immersive hero zone ─────────────────────────────────────
          Back link + poster + meta share ONE wrapper so the dark scrim
          (immersive public page only) backs exactly this zone and fades to
          transparent in the reserved bottom padding — a clean boundary
          between the light-on-dark hero and the cream page. Below-fold
          content (logistics/tickets/about) lives in ContentStack, untouched. */}
      <div
        className="event-hero-immersive"
        style={{
          position: "relative",
          paddingBottom: immersiveHero ? heroScrimFade : 0,
        }}
      >
        {immersiveHero && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 0,
              pointerEvents: "none",
              // Deterministic guaranteed-dark floor (≥0.6 black) under every
              // hero glyph — densest where the meta text sits — so `$onStructure`
              // clears AA regardless of the poster. Fades to transparent only in
              // the reserved bottom padding, so it never crosses text and
              // dissolves cleanly into the cream page below. No pixel sampling,
              // no measurement — correct on first paint / SSR.
              background: `linear-gradient(to bottom, rgba(0,0,0,0.62) 0px, rgba(0,0,0,0.66) 30%, rgba(0,0,0,0.74) calc(100% - ${heroScrimFade}px), transparent 100%)`,
            }}
          />
        )}
        {/* ── Back navigation (above hero, always readable) ──────────── */}
        {backLink && (
          <div
            style={{
              position: "relative",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              padding: mobile ? "10px 16px" : "12px 24px",
            }}
          >
            {backLink}
          </div>
        )}

        {/* ── Poster + meta ────────────────────────────────────────────
            Source order, one column: the embed, the builder preview, the
            community head and the posterless page. The poster-first page
            returned above and never reaches this tree. */}
        <div>
        {posterFrame}

        {/* ── Title + meta (hero zone) ───────────────────────────────
            Pulled OUT of ContentStack so the immersive wrapper encloses it
            and the scrim/light-ink treatment stops here. */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            paddingLeft: mobile ? 16 : 24,
            paddingRight: mobile ? 16 : 24,
            paddingTop: mobile ? 16 : 24,
            // Immersive: a strip of solid-dark padding below the meta before
            // the scrim's fade begins. Classic: no bottom pad — ContentStack's
            // top padding supplies the gap to logistics (unchanged rhythm).
            paddingBottom: immersiveHero ? 16 : 0,
          }}
        >
          {metaBlock}
        </div>
        </div>
      </div>
      {/* ── end immersive hero zone ─────────────────────────────────
          Everything below reads on the cream page background and keeps the
          themed dark ink — never flipped to light. */}

      {contentStack}

      {waitlistForm}
      {belowContent}
    </article>
  );
}

/** Renders prose body HTML and hydrates audio blocks with the custom player.
 *  Wrapped in React.memo so unrelated parent re-renders (tRPC query retries,
 *  notification errors) don't regenerate the innerHTML and destroy the player. */
const EventBodyContent = memo(function EventBodyContent({
  bodyHtml,
  className,
}: {
  bodyHtml: string;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = useTranslations();
  useHydrateAudioBlocks(bodyRef, [bodyHtml], {
    download: String(t("eventDetail.audioDownload") ?? "Download audio"),
  });
  useHydrateMediaEmbeds(bodyRef, [bodyHtml]);

  return (
    <YStack className="event-content-body-section">
      <div
        ref={bodyRef}
        className={className}
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </YStack>
  );
});

/**
 * The copy-address chip.
 *
 * Extracted verbatim from the location section so the community fact block
 * can carry the same affordance without a second copy of sixty lines of
 * inline style. Pure composition — the rendered DOM is the same node tree it
 * always was.
 */
function CopyAddressButton({
  copied,
  onCopy,
  inkColor,
  copyLabel,
  copiedLabel,
}: {
  copied: boolean;
  onCopy: () => void;
  inkColor?: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <button
      type="button"
      className="copy-address-btn"
      onClick={onCopy}
      aria-label={copied ? copiedLabel : copyLabel}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px 4px 8px",
        // 44px tap-target floor: the chip rested at ~24px tall. Rest state is
        // transparent (no border), so the taller box is invisible until
        // hover/copied.
        minHeight: 44,
        boxSizing: "border-box",
        borderRadius: 0,
        flexShrink: 0,
        fontSize: 13,
        fontWeight: 500,
        color: copied ? "var(--success, #166534)" : (inkColor ?? "#fff"),
        transition: "background 0.15s, color 0.15s",
        background: copied
          ? "color-mix(in srgb, var(--success, #166534) 15%, transparent)"
          : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!copied)
          e.currentTarget.style.background =
            "color-mix(in srgb, var(--foreground, #211C16) 10%, transparent)";
      }}
      onMouseLeave={(e) => {
        if (!copied) e.currentTarget.style.background = "transparent";
      }}
    >
      {copied ? (
        <Check size={14} color="var(--success, #166534)" aria-hidden="true" />
      ) : (
        <Copy size={14} color={inkColor} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? copiedLabel : copyLabel}</span>
    </button>
  );
}
