"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Spinner, useTranslations } from "@th/ui";
import {
  ArrowLeft,
  CalendarOff,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

import { trpc } from "@/trpc";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import { EventDetail } from "@/app/events/[...slug]/_components/EventDetail";
import { CheckoutStepper } from "@/app/events/checkout/[...slug]/_components/CheckoutStepper";
import type { SeoEvent } from "@th/types/seo/types";
import type {
  PublicFeeRates,
  PublicEventHuman,
  PublicEventTag,
} from "@/server/events";

import type {
  CartItem,
  CheckoutStepId,
  EmbedGateType,
} from "./embed-types";
import {
  DEFAULT_SUPPORT_EMAIL,
  buyerTaxRateBps,
  embedEventUrl,
  formatCurrency,
} from "./embed-helpers";
import {
  STEEL_BLUE,
  TEXT,
  TEXT_MUTED,
  SURFACE,
  SURFACE_MUTED,
  SURFACE_OPAQUE,
  BORDER,
  BORDER_SUBTLE,
  sectionLabelStyle,
  sectionNumStyle,
  headerBarStyle,
  backButtonStyle,
  headerTitleStyle,
  primaryButtonStyle,
} from "./embed-theme";
import { EmbedSeatPicker } from "./EmbedSeatPicker";
import { EmbedSeriesDateSwitcher } from "./EmbedSeriesDateSwitcher";
import { EmbedTicketTypeList } from "./EmbedTicketTypeList";
import { EmbedErrorScreen } from "./EmbedErrorScreen";
import { EmbedGatedEventCard } from "./EmbedGatedEventCard";
import { EmbedMobileCTABar } from "./EmbedMobileCTABar";
import { useIsFramed } from "./useIsFramed";
import {
  estimateCartTotal,
  withBuyerUnitTotals,
} from "@/lib/pricing/order-estimate";
import { defaultChosenAmountCents } from "@/lib/pricing/pay-what-you-want";
import { useRefetchStaleEstimates } from "@/lib/pricing/useRefetchStaleEstimates";
import { platformFeeRateLabel as cappedPlatformFeeRateLabel } from "@/lib/pricing/fee-rate-label";
import { donationInputId } from "@/components/pricing/PayWhatYouWantAmount";
import {
  embedEstimateItems,
  embedInvalidDonationTier,
  embedShownLineCents,
  withEmbedChosenLinePrices,
} from "./embed-pwyw";
import { seatPickCartItem } from "./embed-seat-quotes";
import { EmbedSummaryRows, embedFiguresFromEstimate } from "./EmbedSummaryRows";

export function EmbedEventDetail({
  embedId,
  eventId,
  cart,
  onCartChange,
  onBack,
  onContinueToCheckout,
  onSelectDate,
  stepperStepId,
  completedStepIds,
  showBackButton = true,
  linkOut = false,
  buildEventUrl = embedEventUrl,
  gateTypeHint,
}: {
  embedId: string;
  eventId: string;
  cart: CartItem[];
  onCartChange: (cart: CartItem[]) => void;
  onBack: () => void;
  onContinueToCheckout: () => void;
  /** Switch the active event to a sibling series date (no navigation). */
  onSelectDate: (eventId: string) => void;
  stepperStepId: CheckoutStepId;
  completedStepIds: CheckoutStepId[];
  /** Hide the back arrow for single-event embeds that have no grid to return to. */
  showBackButton?: boolean;
  /** When true, this embed is a discovery surface: show the event details and
   * series switcher, but replace in-iframe ticket selection + checkout with a
   * CTA that opens the event on Ithas Fire in a new tab. */
  linkOut?: boolean;
  /** The event's page on Ithas Fire; the widget's one builder by default. */
  buildEventUrl?: (slugOrId: string) => string;
  /**
   * The gate the list card or single-event payload already reported, so an
   * ungated event's fee rates load beside the detail instead of after it.
   * The detail read's own `gateType` wins once it lands.
   */
  gateTypeHint?: EmbedGateType;
}) {
  const t = useTranslations();
  // In a resize-bridged iframe `position: fixed` pins to the iframe's full
  // content height (the host grows the frame to fit), so the fixed CTA bar
  // is meaningless there — the sticky in-flow CONTINUE below owns the
  // action instead.
  const isFramed = useIsFramed();
  const { data, isLoading } = trpc.embeds.getEventDetail.useQuery(
    { embedId, eventId, hostOrigin: getEmbedHostOrigin() },
    { staleTime: 30_000, retry: 1 },
  );

  const donationAmounts = useMemo(
    () =>
      Object.fromEntries(
        cart
          .filter((c) => c.donationAmountCents != null)
          .map((c) => [c.ticketTypeId, c.donationAmountCents!]),
      ),
    [cart],
  );

  const handleDonationAmountChange = useCallback(
    (ticketTypeId: string, amountCents: number) => {
      onCartChange(
        cart.map((c) =>
          c.ticketTypeId === ticketTypeId
            ? { ...c, donationAmountCents: amountCents }
            : c,
        ),
      );
    },
    [cart, onCartChange],
  );

  const currency = data?.event?.currency ?? "usd";

  // A gated event (owner ruling 2026-10-12) shows a card that opens it on
  // Ithas Fire: no tiers, no checkout. Its fee rates are refused (403), and
  // asking left "Calculating total…" up for good, so they are asked for only
  // once the event is known to be ungated.
  // A loaded detail without the field (an API from before the gate shipped)
  // reads as ungated, as it was then.
  const gateType: EmbedGateType | undefined = data
    ? (data.event.gateType ?? "NONE")
    : gateTypeHint;
  const isGated = gateType !== undefined && gateType !== "NONE";

  // Fee rate labels for pre-checkout transparency
  const feeRatesQuery = trpc.events.getCheckoutFeeRates.useQuery(
    { eventId },
    { staleTime: 60_000, enabled: gateType === "NONE" },
  );

  const displayTicketTypes = useMemo(
    () =>
      withBuyerUnitTotals(
        data?.ticketTypes ?? [],
        feeRatesQuery.data?.perTicketEstimates,
      ),
    [data?.ticketTypes, feeRatesQuery.data?.perTicketEstimates],
  );
  // A cached fee-rates row priced at another face reads "Calculating total…";
  // refetch the rates once so it does not stay that way until a remount.
  useRefetchStaleEstimates(displayTicketTypes, feeRatesQuery.refetch);

  // Pre-checkout cart estimate — the ONE result the rows and the total read.
  // A pay-what-you-want line is priced at the buyer's amount like a fixed
  // ticket of that amount, fees and tax ON TOP (`embedEstimateItems`); it used
  // to add the raw donation to the total, with no fee or tax on it.
  const invalidDonationTier = useMemo(
    () => embedInvalidDonationTier(cart, displayTicketTypes),
    [cart, displayTicketTypes],
  );
  const orderEstimate = useMemo(
    () =>
      invalidDonationTier
        ? null
        : estimateCartTotal(
            feeRatesQuery.data,
            embedEstimateItems(cart, displayTicketTypes),
          ),
    [cart, displayTicketTypes, feeRatesQuery.data, invalidDonationTier],
  );
  const totalCents = orderEstimate?.totalCents ?? 0;
  const isTotalKnown = orderEstimate !== null;
  // Lines at face × qty — a PWYW line at the buyer's amount.
  const lineTicketTypes = useMemo(
    () => withEmbedChosenLinePrices(displayTicketTypes, cart),
    [displayTicketTypes, cart],
  );
  // Each line's face × qty at the shown prices: an override seat at the
  // price the seat picker showed, as the estimate above prices it.
  const shownLineCents = useMemo(
    () => embedShownLineCents(cart, displayTicketTypes),
    [cart, displayTicketTypes],
  );

  const totalLabel = useMemo(() => {
    // An amount the server would refuse: no total to quote ("—"), as on the
    // main checkout.
    if (invalidDonationTier) return "—";
    if (!isTotalKnown) return String(t("checkout.calculatingTotal"));
    if (totalCents === 0) return String(t("common.free"));
    return formatCurrency(totalCents, currency);
  }, [currency, invalidDonationTier, isTotalKnown, t, totalCents]);

  // The platform-fee rate with its per-ticket cap ("3.33%, max $0.50/ticket").
  const platformFeeLabel =
    cappedPlatformFeeRateLabel(
      feeRatesQuery.data?.platformFeeLabel,
      feeRatesQuery.data?.platformFeeRates,
      t,
      (cents) => formatCurrency(cents, currency),
    ) ?? undefined;

  // Continue refuses an amount the server would refuse — shows the field's
  // error and puts the caret in it (main checkout's Hold does the same).
  const [showDonationErrors, setShowDonationErrors] = useState(false);
  const handleContinue = useCallback(() => {
    if (invalidDonationTier) {
      setShowDonationErrors(true);
      const tierId = invalidDonationTier.id;
      window.setTimeout(() => {
        document.getElementById(donationInputId(tierId))?.focus();
      }, 0);
      return;
    }
    onContinueToCheckout();
  }, [invalidDonationTier, onContinueToCheckout]);

  const totalQty = useMemo(
    () => cart.reduce((sum, item) => sum + item.qty, 0),
    [cart],
  );

  const updateQty = useCallback(
    (ticketTypeId: string, delta: number) => {
      onCartChange(
        (() => {
          const existing = cart.find((c) => c.ticketTypeId === ticketTypeId);
          if (!existing) {
            if (delta <= 0) return cart;
            const ticketType = displayTicketTypes.find(
              (tt) => tt.id === ticketTypeId,
            );
            // The shared default: the suggestion, never below the minimum
            // nor above the $10,000 cap.
            const donationAmountCents =
              ticketType?.pricingMode === "ADJUSTABLE"
                ? defaultChosenAmountCents(ticketType)
                : undefined;
            return [
              ...cart,
              {
                ticketTypeId,
                qty: 1,
                ...(donationAmountCents != null ? { donationAmountCents } : {}),
              },
            ];
          }
          const newQty = Math.max(0, existing.qty + delta);
          if (newQty === 0) {
            return cart.filter((c) => c.ticketTypeId !== ticketTypeId);
          }
          return cart.map((c) =>
            c.ticketTypeId === ticketTypeId ? { ...c, qty: newQty } : c,
          );
        })(),
      );
    },
    [cart, displayTicketTypes, onCartChange],
  );

  const [expandedSection, setExpandedSection] = useState<{
    ticketTypeId: string;
    seatSectionId: string;
    seatSectionName: string;
  } | null>(null);

  // The component stays mounted across a series date switch (only `eventId`
  // changes). Reset event-scoped local state so no stale UI carries over.
  useEffect(() => {
    setExpandedSection(null);
  }, [eventId]);

  const quantities = useMemo(
    () => Object.fromEntries(cart.map((c) => [c.ticketTypeId, c.qty])),
    [cart],
  );

  // Derive EventDetail props from the enriched query data.
  const seoEvent = useMemo((): SeoEvent | null => {
    if (!data?.event) return null;
    const ev = data.event;
    const startsAt =
      ev.startsAt instanceof Date
        ? ev.startsAt
        : new Date(ev.startsAt as string);
    const endsAt =
      ev.endsAt instanceof Date
        ? ev.endsAt
        : ev.endsAt
          ? new Date(ev.endsAt as string)
          : undefined;
    return {
      id: ev.id,
      slug: "",
      url: "",
      name: ev.title,
      startsAt,
      endsAt,
      // FR-010: the shared TicketsSection renders sales-window instants on the
      // EVENT's clock, so the widget must carry it too.
      timezone: ev.timezone ?? null,
      status: "PUBLISHED",
      images: ev.heroImageUrl ? [ev.heroImageUrl] : [],
      location: {
        // FR-013: the use case already redacts non-EXACT events (locationLabel
        // → coarse areaLabel, region/addressText/locality → null). Prefer the
        // explicit coarse areaLabel so we never render a raw operator label.
        name: ev.locationCoords?.areaLabel ?? ev.locationLabel ?? undefined,
        addressLine1: ev.addressText ?? undefined,
        city: ev.locality ?? undefined,
        region: ev.region ?? undefined,
        latitude: ev.locationCoords?.latitude ?? undefined,
        longitude: ev.locationCoords?.longitude ?? undefined,
        // Pass through the use case's real redaction flags: an OBSCURED
        // event's coords are the server-offset circle centre (isExact:false
        // + radiusMeters), so the shared EventContent gate renders the soft
        // circle with no directions. Hardcoding isExact:true here rendered
        // the deliberately-wrong point as a sharp pin with directions.
        isExact: ev.locationCoords?.isExact,
        radiusMeters: ev.locationCoords?.radiusMeters,
        areaLabel: ev.locationCoords?.areaLabel,
      },
      pricing: { currency, availability: "in_stock" },
      performers: [],
    };
  }, [data?.event, currency]);

  const detailFeeRates = useMemo((): PublicFeeRates | undefined => {
    if (!feeRatesQuery.data) return undefined;
    return {
      feeMode: feeRatesQuery.data.feeMode,
      admissionTaxRateBps: feeRatesQuery.data.admissionTaxRateBps,
      platformFeeLabel: feeRatesQuery.data.platformFeeLabel,
      processorFeeLabel: feeRatesQuery.data.processorFeeLabel,
      perTicketEstimates: feeRatesQuery.data.perTicketEstimates,
      taxImpositions: feeRatesQuery.data.taxImpositions,
    };
  }, [feeRatesQuery.data]);

  const detailHumans = useMemo((): PublicEventHuman[] => {
    if (!data?.eventHumans) return [];
    return data.eventHumans.map((eh, i) => ({
      id: eh.id,
      name: eh.name,
      role: eh.role,
      customRoleLabel: eh.customRoleLabel ?? null,
      profileUrl: eh.profileUrl,
      sortOrder: i,
      // The widget payload doesn't carry the derived listen URL (only
      // eventHumans.listPublic does — lineup-listen-embeds spec), so the
      // embed lineup renders without Listen chips for now.
      listenUrl: null,
    }));
  }, [data?.eventHumans]);

  const detailTags = useMemo((): PublicEventTag[] => {
    if (!data?.tags) return [];
    return data.tags.map((t) => ({ id: t.slug, slug: t.slug, name: t.name }));
  }, [data?.tags]);

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          minHeight: 200,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Spinner size="md" indicatorColor={STEEL_BLUE} />
      </div>
    );
  }

  if (!data) {
    return (
      <EmbedErrorScreen
        error={null}
        onRetry={onBack}
        supportEmail={DEFAULT_SUPPORT_EMAIL}
      />
    );
  }

  const { event } = data;
  // Same rule as the server purchase guard (EVENT_SALES_CLOSED): suppress
  // buyable UI up front instead of letting a selection fail at submit.
  const salesClosed = data.salesClosed === true;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Top bar */}
      <div style={headerBarStyle}>
        {showBackButton && (
          <button
            type="button"
            onClick={onBack}
            aria-label={String(t("common.back"))}
            style={backButtonStyle}
          >
            <ArrowLeft size={16} aria-hidden />
          </button>
        )}
        <h2 style={headerTitleStyle}>{event.title}</h2>
      </div>

      {/* Stepper — only for the in-iframe checkout flow */}
      {!linkOut && !salesClosed && !isGated && (
        <div
          style={{
            borderBottom: `1px solid ${BORDER_SUBTLE}`,
            background: SURFACE,
          }}
        >
          <CheckoutStepper
            currentStepId={stepperStepId}
            completedStepIds={completedStepIds}
          />
        </div>
      )}

      {/* Shared EventDetail — renders hero, meta, body, lineup, map, tags, fees.
          It styles itself from the platform theme, which on /embed/* is
          always the light one (Stub + the active preset — see
          lib/route-context.ts), so it needs no wrapper. Host --hf-* overrides
          reach it through the bridge on EmbedWidget's root. */}
      {seoEvent && !isGated && (
        <EventDetail
          event={seoEvent}
          bodyContent={data.body}
          imageMap={data.imageMap ?? {}}
          ticketTypes={displayTicketTypes.map((tt) => ({
            id: tt.id,
            name: tt.name,
            priceCents: tt.priceCents,
            capacity: tt.capacity,
            // Stock, from the server, on the same basis checkout refuses
            // on. Threaded (unlike the FR-010 fields below) because this
            // subtree derives the whole-event "sold out" state from it,
            // and that is not duplicated by the list underneath.
            remainingCapacity: tt.remainingCapacity,
            soldOut: tt.soldOut,
            buyerUnitTotalCents: tt.buyerUnitTotalCents,
            // Pay what you want: without these the shared hero read a PWYW
            // tier as a fixed $0 one. Its floor's row happened to give the
            // right all-in "From", but a floor-0 tier read "Free" instead of
            // "Pay what you want".
            pricingMode: tt.pricingMode,
            minimumCents: tt.minimumCents,
            suggestedCents: tt.suggestedCents,
            // FR-010 / Q-002 DELIBERATELY NOT THREADED HERE. The widget
            // mounts this read-only EventDetail AND `EmbedTicketTypeList`
            // below it, so the same tiers already appear twice; passing
            // `sellability` / `upcomingPriceChange` in made every new
            // notice appear twice too ("On sale Fri, Oct 9" printed once
            // here and once down there), which reads as two separate
            // facts. The per-tier state belongs on the list that has the
            // stepper — the row where the state is actionable and where a
            // buyer discovers WHY the +/- is inert. Threading fields
            // explicitly rather than spreading keeps that a visible
            // decision instead of a silent leak.
          }))}
          eventHumans={detailHumans}
          feeRates={detailFeeRates}
          tags={detailTags}
          eventId={eventId}
          waitlistOpen={event.waitlistStatus === "OPEN"}
          waitlistDescription={event.waitlistDescription}
          mobile
          hideTicketCta
        />
      )}

      {/* Gated event — title (in the bar above), date and hero, and one link
          that opens it on Ithas Fire in a new tab. Replaces the detail body,
          the tiers and checkout, so nothing priced renders and no seat,
          fee-rate or waiver query mounts. */}
      {isGated && event.gateType !== "NONE" && (
        <EmbedGatedEventCard
          event={{
            id: event.id,
            slug: event.slug,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            timezone: event.timezone,
            heroImageUrl: event.heroImageUrl,
            gateType: event.gateType,
          }}
          buildEventUrl={buildEventUrl}
          showAction={!salesClosed}
        />
      )}

      {/* Series date switcher — only renders for multi-date series events */}
      {!expandedSection && !isGated && (
        <EmbedSeriesDateSwitcher
          eventId={eventId}
          onSelectDate={onSelectDate}
        />
      )}

      {/* Sales closed — event info stays visible, every buy affordance goes.
          Mirrors the main site's sales-closed notice (EventDetail). */}
      {salesClosed && (
        <div style={{ padding: "8px 16px 20px" }}>
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              border: `2px solid ${BORDER}`,
              background: SURFACE_MUTED,
              padding: "14px 16px",
            }}
          >
            <CalendarOff
              size={20}
              style={{ color: TEXT_MUTED, flexShrink: 0, marginTop: 2 }}
              aria-hidden
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={sectionLabelStyle}>Ticket sales have closed</span>
              <span
                style={{ fontSize: 13, lineHeight: 1.5, color: TEXT_MUTED }}
              >
                This event has ended, so tickets are no longer available.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Link-out mode — discovery CTA replaces in-iframe ticket selection */}
      {!salesClosed && !isGated && linkOut && buildEventUrl && (
        <div style={{ padding: "8px 16px 20px" }}>
          <a
            href={buildEventUrl(event.slug ?? eventId)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...primaryButtonStyle,
              textDecoration: "none",
            }}
          >
            {/* Catalog key predates the Ithas Fire rename — the RENDERED copy
                says "Ithas Fire"; the key itself is just an identifier. */}
            {String(t("checkout.getTicketsOnHearthfire"))}
            <ExternalLink size={16} />
          </a>
        </div>
      )}

      {/* Two-column: Tickets left | Order summary right (in-iframe checkout) */}
      {!linkOut && !salesClosed && !isGated && (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {/* LEFT — inline seat picker or ticket type list */}
          <div style={{ minWidth: 0, flex: 1 }}>
            {expandedSection ? (
              <EmbedSeatPicker
                embedId={embedId}
                eventId={eventId}
                seatSectionId={expandedSection.seatSectionId}
                seatSectionName={expandedSection.seatSectionName}
                ticketTypeId={expandedSection.ticketTypeId}
                currency={currency}
                selectedSeatIds={
                  cart.find(
                    (c) => c.ticketTypeId === expandedSection.ticketTypeId,
                  )?.seatIds ?? []
                }
                onConfirm={(seatIds, seats) => {
                  const { ticketTypeId, seatSectionId } = expandedSection;
                  // The cart keeps each override seat's shown price; a seat
                  // the seat data does not cover keeps its earlier quote.
                  const previous = cart.find(
                    (c) =>
                      c.ticketTypeId === ticketTypeId &&
                      c.seatSectionId === seatSectionId,
                  );
                  const picked = seatPickCartItem(
                    ticketTypeId,
                    seatSectionId,
                    seatIds,
                    seats,
                    previous?.seatQuotes,
                  );
                  onCartChange([
                    ...cart.filter((c) => c.ticketTypeId !== ticketTypeId),
                    ...(picked ? [picked] : []),
                  ]);
                  setExpandedSection(null);
                }}
                onBack={() => setExpandedSection(null)}
              />
            ) : (
              <>
                <div
                  style={{
                    padding: "4px 20px 8px",
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                  }}
                >
                  <span style={sectionNumStyle}>01.</span>
                  <h3 style={sectionLabelStyle}>Select tickets</h3>
                </div>
                <div style={{ padding: "0 16px 16px" }}>
                  <EmbedTicketTypeList
                    ticketTypes={displayTicketTypes.map((tt) => ({
                      ...tt,
                      currency,
                      // FR-010: window instants render on the venue's clock.
                      timezone: data.event.timezone,
                    }))}
                    quantities={quantities}
                    onQuantityChange={updateQty}
                    donationAmounts={donationAmounts}
                    onDonationAmountChange={handleDonationAmountChange}
                    showDonationErrors={showDonationErrors}
                    onSelectSeats={(ttId, sectionId, sectionName) =>
                      setExpandedSection({
                        ticketTypeId: ttId,
                        seatSectionId: sectionId,
                        seatSectionName: sectionName,
                      })
                    }
                  />
                </div>
              </>
            )}
          </div>

          {/* RIGHT — Order summary card (visible when items selected) */}
          {totalQty > 0 && (
            <div className="th-embed-fade-in-up" style={{ padding: "0 16px" }}>
              <div
                style={{
                  overflow: "hidden",
                  borderRadius: 0,
                  border: `2px solid ${BORDER}`,
                  background: SURFACE,
                }}
              >
                <div
                  style={{
                    borderBottom: `1px solid ${BORDER_SUBTLE}`,
                    background: SURFACE_MUTED,
                    padding: "10px 16px",
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                  }}
                >
                  <span style={sectionNumStyle}>02.</span>
                  <h3 style={sectionLabelStyle}>Order summary</h3>
                </div>
                {/* Main checkout's step-1 rows, from the estimate the total
                    below reads (see EmbedSummaryRows). */}
                <div style={{ padding: "10px 16px" }}>
                  <EmbedSummaryRows
                    lines={cart
                      .filter((c) => c.qty > 0)
                      .flatMap((item) => {
                        const tt = lineTicketTypes.find(
                          (ticketType) => ticketType.id === item.ticketTypeId,
                        );
                        return tt
                          ? [
                              {
                                id: item.ticketTypeId,
                                name: tt.name,
                                qty: item.qty,
                                lineCents:
                                  shownLineCents[item.ticketTypeId] ??
                                  tt.priceCents * item.qty,
                              },
                            ]
                          : [];
                      })}
                    figures={embedFiguresFromEstimate(orderEstimate)}
                    feeMode={feeRatesQuery.data?.feeMode ?? null}
                    platformFeeRateLabel={platformFeeLabel}
                    processorFeeRateLabel={
                      feeRatesQuery.data?.processorFeeLabel ?? undefined
                    }
                    taxRateBps={buyerTaxRateBps(feeRatesQuery.data)}
                    currency={currency}
                    testIdPrefix="embed-detail"
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    borderTop: `2px solid ${BORDER}`,
                    background: SURFACE_MUTED,
                    padding: "10px 16px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: TEXT_MUTED,
                    }}
                  >
                    {/* Fee-inclusive order estimate, not a face-value
                        subtotal — label it as the estimate it is. */}
                    {String(t("checkout.estimatedTotal"))}
                  </span>
                  <span
                    data-testid="embed-detail-total-value"
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: TEXT,
                    }}
                  >
                    {totalLabel}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Continue button — sticky, in-flow. Hidden at phone widths ONLY
          when the fixed CTA bar renders (standalone pages); in iframes it
          is the load-bearing CTA at every width. */}
      {totalQty > 0 && !linkOut && !salesClosed && !isGated && (
        <div
          className={
            isFramed
              ? "th-embed-inline-cta"
              : "th-embed-inline-cta th-embed-inline-cta--with-fixed-bar"
          }
          style={{
            position: "sticky",
            bottom: 0,
            borderTop: `2px solid ${BORDER}`,
            // The platform surface, near-opaque: this bar scrolls over
            // content, so it cannot stay transparent like the rest.
            background: `color-mix(in srgb, ${SURFACE_OPAQUE} 95%, transparent)`,
            padding: "12px 16px",
            backdropFilter: "blur(8px)",
          }}
        >
          <button
            type="button"
            onClick={handleContinue}
            style={{
              ...primaryButtonStyle,
            }}
          >
            Continue
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Mobile CTA bar — ticket selection phase. Fixed positioning only
          works when the embed page IS the visitor's viewport (standalone);
          suppressed inside resize-bridged iframes. */}
      {totalQty > 0 && !linkOut && !salesClosed && !isGated && !isFramed && (
        <EmbedMobileCTABar
          totalLabel={totalLabel}
          tickets={cart
            .filter((c) => c.qty > 0)
            .map((item) => {
              // Face — a PWYW line at the buyer's amount (lineTicketTypes).
              const tt = lineTicketTypes.find(
                (ticketType) => ticketType.id === item.ticketTypeId,
              );
              return {
                id: item.ticketTypeId,
                name: tt?.name ?? "Ticket",
                priceCents: tt?.priceCents ?? 0,
                buyerUnitTotalCents: tt?.buyerUnitTotalCents ?? null,
                qty: item.qty,
                lineCents: shownLineCents[item.ticketTypeId],
              };
            })}
          order={null}
          preOrderEstimate={orderEstimate}
          currency={currency}
          feeMode={feeRatesQuery.data?.feeMode ?? null}
          platformFeeRateLabel={platformFeeLabel}
          processorFeeRateLabel={feeRatesQuery.data?.processorFeeLabel}
          taxRateBps={buyerTaxRateBps(feeRatesQuery.data)}
          countdown={null}
          isExpired={false}
          onAction={handleContinue}
          actionLabel="Continue"
        />
      )}
    </div>
  );
}
