"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Spinner, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import { getBuyerAllInDisplayCents } from "@/lib/pricing/buyer-display";
import type { SeatStatus } from "./embed-types";
import { formatCurrency } from "./embed-helpers";
import {
  STEEL_BLUE,
  TEXT,
  TEXT_MUTED,
  TEXT_CAPTION,
  TEXT_INVERTED,
  SURFACE,
  SURFACE_MUTED,
  SURFACE_OPAQUE,
  BORDER,
  BORDER_SUBTLE,
  WARNING,
  WARNING_BG,
  headerBarStyle,
  backButtonStyle,
  primaryButtonStyle,
  primaryButtonDisabledStyle,
} from "./embed-theme";

export function EmbedSeatPicker({
  embedId,
  eventId,
  seatSectionId,
  seatSectionName,
  ticketTypeId,
  currency = "usd",
  selectedSeatIds: initialSelectedIds,
  onConfirm,
  onBack,
}: {
  embedId: string;
  eventId: string;
  seatSectionId: string;
  seatSectionName: string;
  ticketTypeId: string;
  currency?: string;
  selectedSeatIds: string[];
  /**
   * The picked seats, with the seat data they were shown from, so the cart
   * keeps each override seat's shown price (see embed-seat-quotes.ts).
   */
  onConfirm: (
    seatIds: string[],
    seats: ReadonlyArray<{
      id: string;
      priceOverride?: { priceCents: number } | null;
    }>,
  ) => void;
  onBack: () => void;
}) {
  const t = useTranslations();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelectedIds),
  );

  const { data, isLoading, error } = trpc.embeds.listAvailableSeats.useQuery(
    { embedId, eventId, seatSectionId, hostOrigin: getEmbedHostOrigin() },
    { staleTime: 15_000, retry: 1 },
  );

  const feeRatesQuery = trpc.events.getCheckoutFeeRates.useQuery(
    { eventId },
    { staleTime: 60_000 },
  );

  const eventDetailQuery = trpc.embeds.getEventDetail.useQuery(
    { embedId, eventId, hostOrigin: getEmbedHostOrigin() },
    { staleTime: 30_000, retry: 1 },
  );

  const buyerPricingTicket = useMemo(() => {
    const ticketType = eventDetailQuery.data?.ticketTypes.find(
      (ticket) => ticket.id === ticketTypeId,
    );
    if (!ticketType) return null;
    const estimate = feeRatesQuery.data?.perTicketEstimates.find(
      (entry) => entry.ticketTypeId === ticketTypeId,
    );
    return {
      priceCents: ticketType.priceCents,
      buyerUnitTotalCents: estimate?.buyerUnitTotalCents ?? null,
    };
  }, [
    eventDetailQuery.data?.ticketTypes,
    feeRatesQuery.data?.perTicketEstimates,
    ticketTypeId,
  ]);

  const toggleSeat = useCallback((seatId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seatId)) {
        next.delete(seatId);
      } else {
        if (next.size >= 10) return prev; // max 10 seats
        next.add(seatId);
      }
      return next;
    });
  }, []);

  const clearAll = useCallback(() => setSelected(new Set()), []);

  // Group seats by row
  const seatsByRow = useMemo(() => {
    const seats = data?.seats;
    if (!seats) return [];
    const rowMap = new Map<string, typeof seats>();
    for (const seat of seats) {
      const rowLabel = seat.row ?? "—";
      if (!rowMap.has(rowLabel)) rowMap.set(rowLabel, []);
      rowMap.get(rowLabel)!.push(seat);
    }
    // Sort rows, then sort seats within each row by number
    return Array.from(rowMap.entries())
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([row, seats]) => ({
        row,
        seats: seats.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
      }));
  }, [data?.seats]);

  const seatStyle = (
    status: SeatStatus,
    isSelected: boolean,
  ): React.CSSProperties => {
    if (isSelected)
      return {
        background: STEEL_BLUE,
        color: TEXT_INVERTED,
        border: `1px solid ${STEEL_BLUE}`,
        cursor: "pointer",
      };
    switch (status) {
      case "AVAILABLE":
        return {
          background: SURFACE,
          color: TEXT_MUTED,
          border: `1px solid ${BORDER}`,
          cursor: "pointer",
        };
      case "HELD":
        return {
          background: WARNING_BG,
          color: WARNING,
          border: `1px solid ${WARNING}`,
          cursor: "not-allowed",
          opacity: 0.6,
        };
      case "SOLD":
        return {
          background: SURFACE_MUTED,
          color: TEXT_CAPTION,
          border: `1px solid ${BORDER_SUBTLE}`,
          cursor: "not-allowed",
          textDecoration: "line-through",
        };
      case "BLOCKED":
        return {
          background: SURFACE_MUTED,
          color: TEXT_CAPTION,
          border: `1px solid ${BORDER_SUBTLE}`,
          cursor: "not-allowed",
        };
      default:
        return {
          background: SURFACE_MUTED,
          color: TEXT_CAPTION,
          border: `1px solid ${BORDER_SUBTLE}`,
          cursor: "not-allowed",
        };
    }
  };

  const calculatingTotalLabel = String(t("checkout.calculatingTotal"));

  const getBuyerDisplayPriceCents = (
    priceCents: number | null | undefined,
    buyerTotalCents: number | null | undefined,
  ): number | null | undefined => {
    if (buyerTotalCents != null) return buyerTotalCents;
    if (priceCents == null) return undefined;
    if (buyerPricingTicket) {
      return getBuyerAllInDisplayCents(buyerPricingTicket, priceCents);
    }
    if (priceCents <= 0) return 0;
    return null;
  };

  const getPriceLabel = (
    priceCents: number | null | undefined,
    buyerTotalCents: number | null | undefined,
  ): string | undefined => {
    const buyerDisplayPriceCents = getBuyerDisplayPriceCents(
      priceCents,
      buyerTotalCents,
    );
    if (buyerDisplayPriceCents === undefined) return undefined;
    if (buyerDisplayPriceCents === null) return calculatingTotalLabel;
    return formatCurrency(buyerDisplayPriceCents, currency ?? "usd");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ ...headerBarStyle, gap: 8 }}>
        <button
          type="button"
          onClick={onBack}
          aria-label={String(t("common.back"))}
          style={backButtonStyle}
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <div style={{ flex: 1 }}>
          <h2
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: TEXT,
              margin: 0,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {seatSectionName}
          </h2>
          <p style={{ fontSize: 11, color: TEXT_MUTED, margin: 0 }}>
            Tap a seat to select it
          </p>
        </div>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={clearAll}
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: STEEL_BLUE,
              textDecoration: "underline",
              textUnderlineOffset: 2,
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
          background: SURFACE_MUTED,
          padding: "8px 16px",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: TEXT_MUTED,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontWeight: 700,
          }}
        >
          <span
            style={{
              display: "inline-block",
              height: 12,
              width: 12,
              borderRadius: 0,
              border: `1px solid ${BORDER}`,
              background: SURFACE,
            }}
          />
          Available
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: TEXT_MUTED,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontWeight: 700,
          }}
        >
          <span
            style={{
              display: "inline-block",
              height: 12,
              width: 12,
              borderRadius: 0,
              border: `1px solid ${STEEL_BLUE}`,
              background: STEEL_BLUE,
            }}
          />
          Selected
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: TEXT_MUTED,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontWeight: 700,
          }}
        >
          <span
            style={{
              display: "inline-block",
              height: 12,
              width: 12,
              borderRadius: 0,
              border: `1px solid ${BORDER_SUBTLE}`,
              background: SURFACE_MUTED,
            }}
          />
          Taken
        </span>
      </div>

      {/* Seat grid */}
      <div
        style={{ flex: 1, overflowY: "auto", padding: 16, maxHeight: "60vh" }}
      >
        {isLoading && (
          <div
            style={{
              display: "flex",
              minHeight: 160,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Spinner size="md" indicatorColor={STEEL_BLUE} />
          </div>
        )}

        {error && (
          <div
            style={{
              display: "flex",
              minHeight: 160,
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              textAlign: "center",
            }}
          >
            <AlertTriangle size={20} style={{ color: WARNING }} />
            <p style={{ fontSize: 14, color: TEXT_MUTED, margin: 0 }}>
              Could not load seat map. Please go back and try again.
            </p>
          </div>
        )}

        {data && seatsByRow.length === 0 && (
          <div
            style={{
              display: "flex",
              minHeight: 120,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <p style={{ fontSize: 14, color: TEXT_CAPTION, margin: 0 }}>
              No available seats in this section.
            </p>
          </div>
        )}

        {data && seatsByRow.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Stage indicator */}
            <div
              style={{
                marginBottom: 12,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  borderRadius: 0,
                  background: SURFACE_MUTED,
                  border: `1px solid ${BORDER_SUBTLE}`,
                  padding: "6px 24px",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: TEXT_CAPTION,
                }}
              >
                Stage
              </div>
            </div>

            {seatsByRow.map(({ row, seats }) => {
              // Find the representative price for this row (first seat with an override, or null)
              const rowOverride = seats.find(
                (s) => s.priceOverride,
              )?.priceOverride;
              return (
                <div
                  key={row}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <span
                    style={{
                      width: 24,
                      flexShrink: 0,
                      textAlign: "right",
                      fontSize: 11,
                      fontWeight: 700,
                      color: TEXT_CAPTION,
                    }}
                  >
                    {row}
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {seats.map((seat) => {
                      const isAvailable = seat.status === "AVAILABLE";
                      const isSel = selected.has(seat.id);
                      const priceLabel = getPriceLabel(
                        seat.priceOverride?.priceCents,
                        seat.priceOverride?.buyerTotalCents,
                      );
                      return (
                        <button
                          key={seat.id}
                          type="button"
                          disabled={!isAvailable && !isSel}
                          onClick={() =>
                            isAvailable || isSel
                              ? toggleSeat(seat.id)
                              : undefined
                          }
                          title={`${seat.label ?? `Row ${seat.row} Seat ${seat.number}`} — ${seat.status.toLowerCase()}${priceLabel ? ` — ${priceLabel}` : ""}`}
                          style={{
                            display: "flex",
                            height: 28,
                            width: 28,
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: 0,
                            fontSize: 10,
                            fontWeight: 700,
                            fontVariantNumeric: "tabular-nums",
                            transition: "all 0.15s",
                            ...seatStyle(seat.status as SeatStatus, isSel),
                          }}
                        >
                          {seat.number ?? "\u00b7"}
                        </button>
                      );
                    })}
                  </div>
                  {rowOverride && (
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 10,
                        fontWeight: 700,
                        color: TEXT_MUTED,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {getPriceLabel(
                        rowOverride.priceCents,
                        rowOverride.buyerTotalCents,
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          borderTop: `1px solid ${BORDER}`,
          // The platform surface, near-opaque: this bar scrolls over the
          // seat grid, so it cannot stay transparent like the rest.
          background: `color-mix(in srgb, ${SURFACE_OPAQUE} 95%, transparent)`,
          padding: "12px 16px",
          backdropFilter: "blur(8px)",
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (data) onConfirm(Array.from(selected), data.seats);
          }}
          // Not before the seat data loads: re-opened with seats already
          // picked, Confirm would otherwise store them with no shown prices,
          // and an override seat would read at the tier and go unquoted.
          disabled={selected.size === 0 || !data}
          // The disabled state must still spread the base style — the overlay
          // alone (opacity + pointer-events) rendered an unstyled native
          // button whenever no seats were selected.
          style={{
            ...primaryButtonStyle,
            ...(selected.size === 0 || !data ? primaryButtonDisabledStyle : {}),
          }}
        >
          {selected.size === 0
            ? "Select seats to continue"
            : `Confirm ${selected.size} seat${selected.size !== 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}
