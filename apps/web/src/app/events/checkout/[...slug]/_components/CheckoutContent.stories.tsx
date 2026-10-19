import React, { useState, useCallback, useMemo } from "react";
import type { Meta, StoryObj, Decorator } from "@storybook/react";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json";
import enApp from "../../../../../i18n/messages/en";

import {
  SeatMapPicker,
  type PlaceLayout,
  type SeatMapPickerProps,
} from "./SeatMapPicker";
import { TicketTypeGrid, type TicketTypeGridProps } from "./TicketTypeGrid";
import { OrderSummary } from "./OrderSummary";
import { formatMoneyCents } from "@/lib/format";
import { estimateCartTotal } from "@/lib/pricing/order-estimate";

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const withTranslations: Decorator = (Story) => (
  <TranslationProvider locale="en" messages={messages}>
    <div style={{ maxWidth: 896, margin: "0 auto", padding: 24 }}>
      <Story />
    </div>
  </TranslationProvider>
);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS: PlaceLayout["sections"] = [
  {
    sectionId: "sec-floor",
    label: "Floor",
    color: "#6366f1",
    capacity: 120,
    geometry: {
      polygons: [
        [
          { x: 50, y: 200 },
          { x: 450, y: 200 },
          { x: 450, y: 500 },
          { x: 50, y: 500 },
        ],
      ],
      origin: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
    },
    stageAnchor: { point: { x: 250, y: 80 }, facingAngle: 180 },
  },
  {
    sectionId: "sec-balcony",
    label: "Balcony",
    color: "#8b5cf6",
    capacity: 60,
    geometry: {
      polygons: [
        [
          { x: 500, y: 200 },
          { x: 750, y: 200 },
          { x: 750, y: 500 },
          { x: 500, y: 500 },
        ],
      ],
      origin: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
    },
  },
];

const LAYOUT: PlaceLayout = {
  id: "layout-1",
  name: "The Fillmore",
  seatCount: 180,
  sectionCount: 2,
  seatIndexBounds: { minX: 0, minY: 0, maxX: 800, maxY: 600 },
  sections: SECTIONS,
  stage: {
    kind: "rectangle",
    label: "Main Stage",
    bounds: { minX: 100, minY: 20, maxX: 700, maxY: 160 },
  },
};

const SEATED_TICKET_TYPES: SeatMapPickerProps["ticketTypes"] = [
  {
    id: "tt-floor",
    name: "Floor Standing",
    priceCents: 5500,
    capacity: 120,
    seatSectionId: "sec-floor",
    layoutSectionId: "sec-floor",
  },
  {
    id: "tt-balcony",
    name: "Balcony Reserved",
    priceCents: 8500,
    capacity: 60,
    seatSectionId: "sec-balcony",
    layoutSectionId: "sec-balcony",
  },
  {
    id: "tt-ga",
    name: "General Admission",
    priceCents: 3500,
    capacity: 200,
    seatSectionId: null,
    layoutSectionId: null,
  },
];

const GA_TICKET_TYPES: TicketTypeGridProps["ticketTypes"] = [
  {
    id: "tt-ga",
    name: "General Admission",
    priceCents: 3500,
    capacity: 200,
    remainingCapacity: 200,
  },
  {
    id: "tt-vip",
    name: "VIP Experience",
    priceCents: 12000,
    capacity: 30,
    remainingCapacity: 30,
  },
  {
    id: "tt-student",
    name: "Student",
    priceCents: 1500,
    capacity: 100,
    remainingCapacity: 100,
  },
];

// TODO(money-i18n): currency not in scope at this story callsite — using USD default.
const formatPrice = (cents: number) =>
  cents === 0 ? "Free" : formatMoneyCents(cents);

// ─────────────────────────────────────────────────────────────────────────────
// Interactive wrapper — replicates the two-column checkout layout
// ─────────────────────────────────────────────────────────────────────────────

function InteractiveCheckoutContent({
  ticketTypes,
  layout,
}: {
  ticketTypes:
    | SeatMapPickerProps["ticketTypes"]
    | TicketTypeGridProps["ticketTypes"];
  layout: PlaceLayout | null;
}) {
  const allTicketTypes = ticketTypes as SeatMapPickerProps["ticketTypes"];

  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(allTicketTypes.map((tt) => [tt.id, 0])),
  );
  const [selectedSeatIds, setSelectedSeatIds] = useState<
    Record<string, string[]>
  >({});

  const sectionToTicketType = useMemo(() => {
    const map = new Map<string, SeatMapPickerProps["ticketTypes"][number]>();
    for (const tt of allTicketTypes) {
      if ("seatSectionId" in tt && tt.seatSectionId) {
        map.set(tt.seatSectionId, tt);
      }
    }
    return map;
  }, [allTicketTypes]);

  const handleQuantityChange = useCallback(
    (ticketTypeId: string, delta: number) => {
      setQuantities((prev) => ({
        ...prev,
        [ticketTypeId]: Math.max(0, (prev[ticketTypeId] ?? 0) + delta),
      }));
    },
    [],
  );

  const handleSeatToggle = useCallback(
    (seatId: string, sectionId: string) => {
      const tt = sectionToTicketType.get(sectionId);
      if (!tt) return;
      setSelectedSeatIds((prev) => {
        const current = prev[tt.id] ?? [];
        const next = current.includes(seatId)
          ? current.filter((id) => id !== seatId)
          : [...current, seatId];
        setQuantities((prevQ) => ({ ...prevQ, [tt.id]: next.length }));
        return { ...prev, [tt.id]: next };
      });
    },
    [sectionToTicketType],
  );

  const selectedItems = useMemo(
    () =>
      allTicketTypes
        .map((tt) => {
          const qty = quantities[tt.id] ?? 0;
          return qty > 0 ? { ticketTypeId: tt.id, qty } : null;
        })
        .filter(Boolean),
    [quantities, allTicketTypes],
  );

  const selectedQty = useMemo(
    () => selectedItems.reduce((sum, item) => sum + (item?.qty ?? 0), 0),
    [selectedItems],
  );

  const subtotalCents = useMemo(
    () =>
      allTicketTypes.reduce((sum, tt) => {
        const qty = quantities[tt.id] ?? 0;
        return sum + qty * tt.priceCents;
      }, 0),
    [quantities, allTicketTypes],
  );

  // The summary's rows and total come from ONE estimate, as in Checkout. A
  // demo PASS_THROUGH policy (3.33% capped at 50¢, 2.9% + 30¢, NY 8.88%).
  const preHoldEstimate = useMemo(
    () =>
      estimateCartTotal(
        {
          feeMode: "PASS_THROUGH",
          admissionTaxRateBps: 888,
          taxImpositions: [
            {
              code: "SALES",
              label: "Sales tax",
              jurisdiction: "US/NY",
              rateBps: 888,
              base: "TICKET_FACE",
              collector: "PLATFORM",
            },
          ],
          processorPct: 0.029,
          processorFixedCents: 30,
          maxPlatformFeeCents: null,
          platformFeeRates: {
            buyerFeePct: 0.0333,
            maxFeeCents: 50,
            minFeeCents: 0,
            platformFixedCents: 0,
          },
          perTicketEstimates: allTicketTypes.map((tt) => ({
            ticketTypeId: tt.id,
            unitPriceCents: tt.priceCents,
            platformFeeCents: Math.min(50, Math.round(tt.priceCents * 0.0333)),
          })),
        },
        allTicketTypes.map((tt) => ({
          ticketTypeId: tt.id,
          qty: quantities[tt.id] ?? 0,
          priceCents: tt.priceCents,
        })),
      ),
    [quantities, allTicketTypes],
  );

  // Simplified ticket types for OrderSummary (needs id, name, priceCents)
  const summaryTicketTypes = allTicketTypes.map((tt) => ({
    id: tt.id,
    name: tt.name,
    priceCents: tt.priceCents,
    capacity: tt.capacity,
    // Story fixtures have no orders behind them, so nothing is issued or held
    // and everything the tier was authored with is still available. The real
    // payload gets this from the server (`capacity - issued - held`).
    remainingCapacity: tt.capacity,
  }));

  return (
    <div style={{ display: "grid", gap: 32, gridTemplateColumns: "1fr 280px" }}>
      {/* LEFT: Ticket selection */}
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "var(--foreground, #ededed)",
          }}
        >
          Select your tickets
        </h2>

        {layout ? (
          <SeatMapPicker
            layout={layout}
            ticketTypes={allTicketTypes}
            quantities={quantities}
            onQuantityChange={handleQuantityChange}
            formatPrice={formatPrice}
            selectedSeatIds={selectedSeatIds}
            onSeatToggle={handleSeatToggle}
          />
        ) : (
          <TicketTypeGrid
            ticketTypes={summaryTicketTypes}
            quantities={quantities}
            onQuantityChange={handleQuantityChange}
            formatPrice={formatPrice}
          />
        )}
      </div>

      {/* RIGHT: Order summary sidebar */}
      <div style={{ position: "sticky", top: 24, alignSelf: "start" }}>
        <OrderSummary
          ticketTypes={summaryTicketTypes}
          quantities={quantities}
          selectedQty={selectedQty}
          subtotalCents={subtotalCents}
          preHoldEstimate={preHoldEstimate}
          feeMode="PASS_THROUGH"
          taxRateBps={888}
          order={null}
          orderId={null}
          countdown={null}
          isExpired={false}
          formatPrice={formatPrice}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

const meta: Meta = {
  title: "Checkout/CheckoutContent",
  decorators: [withTranslations],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj;

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/** Full two-column checkout with assigned-seating venue (seat map + GA overflow). */
export const SeatedVenue: Story = {
  render: () => (
    <InteractiveCheckoutContent
      ticketTypes={SEATED_TICKET_TYPES}
      layout={LAYOUT}
    />
  ),
};

/** General admission only — no venue layout, card-based ticket grid. */
export const GeneralAdmission: Story = {
  render: () => (
    <InteractiveCheckoutContent ticketTypes={GA_TICKET_TYPES} layout={null} />
  ),
};

/** Seated venue without polygon geometry (section cards fallback). */
export const SeatedNoGeometry: Story = {
  render: () => (
    <InteractiveCheckoutContent
      ticketTypes={SEATED_TICKET_TYPES}
      layout={{
        ...LAYOUT,
        sections: LAYOUT.sections.map((s) => ({ ...s, geometry: null })),
      }}
    />
  ),
};
