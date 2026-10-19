import { useState, useCallback } from "react";
import type { Meta, StoryObj, Decorator } from "@storybook/react";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json";
import enApp from "../../../../../i18n/messages/en";

import {
  SeatMapPicker,
  type SeatMapPickerProps,
  type PlaceLayout,
  type SeatAvailability,
} from "./SeatMapPicker";
import { formatMoneyCents } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
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

const TICKET_TYPES: SeatMapPickerProps["ticketTypes"] = [
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

const TICKET_TYPES_NO_GA: SeatMapPickerProps["ticketTypes"] = [
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
];

// TODO(money-i18n): currency not in scope at this story callsite — using USD default.
const formatPrice = (cents: number) =>
  cents === 0 ? "Free" : formatMoneyCents(cents);

// ─────────────────────────────────────────────────────────────────────────────
// Stateful wrapper (quantities need local state for interactive stories)
// ─────────────────────────────────────────────────────────────────────────────

function InteractiveSeatMapPicker({
  ticketTypes,
  layout,
  seatAvailability,
  disabled,
}: {
  ticketTypes: SeatMapPickerProps["ticketTypes"];
  layout: PlaceLayout;
  seatAvailability?: SeatAvailability[];
  disabled?: boolean;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(ticketTypes.map((tt) => [tt.id, 0])),
  );
  const [selectedSeatIds, setSelectedSeatIds] = useState<
    Record<string, string[]>
  >({});

  const sectionToTicketType = new Map(
    ticketTypes
      .filter((tt) => tt.layoutSectionId)
      .map((tt) => [tt.layoutSectionId!, tt]),
  );

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

  return (
    <SeatMapPicker
      layout={layout}
      ticketTypes={ticketTypes}
      quantities={quantities}
      onQuantityChange={handleQuantityChange}
      formatPrice={formatPrice}
      disabled={disabled}
      seatAvailability={seatAvailability}
      selectedSeatIds={selectedSeatIds}
      onSeatToggle={handleSeatToggle}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

const meta: Meta<typeof SeatMapPicker> = {
  title: "Checkout/SeatMapPicker",
  component: SeatMapPicker,
  decorators: [withTranslations],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof SeatMapPicker>;

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/** Section cards with a visual seat map (geometry provided) and a GA overflow row. */
export const WithGeometryAndGA: Story = {
  render: () => (
    <InteractiveSeatMapPicker ticketTypes={TICKET_TYPES} layout={LAYOUT} />
  ),
};

/** Sections only, no general admission ticket types. */
export const SectionsOnly: Story = {
  render: () => (
    <InteractiveSeatMapPicker
      ticketTypes={TICKET_TYPES_NO_GA}
      layout={LAYOUT}
    />
  ),
};

/** Layout without polygon geometry falls back to cards-only view. */
export const NoGeometry: Story = {
  render: () => (
    <InteractiveSeatMapPicker
      ticketTypes={TICKET_TYPES}
      layout={{
        ...LAYOUT,
        sections: LAYOUT.sections.map((s) => ({ ...s, geometry: null })),
      }}
    />
  ),
};

/** All ticket types disabled (e.g. during payment phase). */
export const Disabled: Story = {
  render: () => (
    <InteractiveSeatMapPicker
      ticketTypes={TICKET_TYPES}
      layout={LAYOUT}
      disabled
    />
  ),
};

/** One section fully sold out. */
export const PartiallySoldOut: Story = {
  render: () => (
    <InteractiveSeatMapPicker
      ticketTypes={[
        {
          id: "tt-floor",
          name: "Floor Standing",
          priceCents: 5500,
          capacity: 0,
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
      ]}
      layout={LAYOUT}
    />
  ),
};
