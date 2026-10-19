import { useState, useCallback } from "react";
import type { Meta, StoryObj, Decorator } from "@storybook/react";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json";
import enApp from "../../../../../i18n/messages/en";

import { TicketTypeGrid, type TicketTypeGridProps } from "./TicketTypeGrid";
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
    <div style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
      <Story />
    </div>
  </TranslationProvider>
);

// TODO(money-i18n): currency not in scope at this story callsite — using USD default.
const formatPrice = (cents: number) =>
  cents === 0 ? "Free" : formatMoneyCents(cents);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TICKET_TYPES: TicketTypeGridProps["ticketTypes"] = [
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

const MIXED_AVAILABILITY: TicketTypeGridProps["ticketTypes"] = [
  // Authored capacity stays put; what varies is what is LEFT — the tier is
  // sold out because every unit went, not because someone edited the column.
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
    remainingCapacity: 0,
    soldOut: true,
  },
  {
    id: "tt-early",
    name: "Early Bird",
    priceCents: 2000,
    capacity: 40,
    remainingCapacity: 5,
  },
];

const FREE_EVENT: TicketTypeGridProps["ticketTypes"] = [
  {
    id: "tt-free",
    name: "Free Entry",
    priceCents: 0,
    capacity: 500,
    remainingCapacity: 500,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Stateful wrapper
// ─────────────────────────────────────────────────────────────────────────────

function InteractiveTicketTypeGrid({
  ticketTypes,
  disabled,
}: {
  ticketTypes: TicketTypeGridProps["ticketTypes"];
  disabled?: boolean;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(ticketTypes.map((tt) => [tt.id, 0])),
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

  return (
    <TicketTypeGrid
      ticketTypes={ticketTypes}
      quantities={quantities}
      onQuantityChange={handleQuantityChange}
      formatPrice={formatPrice}
      disabled={disabled}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

const meta: Meta<typeof TicketTypeGrid> = {
  title: "Checkout/TicketTypeGrid",
  component: TicketTypeGrid,
  decorators: [withTranslations],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof TicketTypeGrid>;

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/** Standard grid with multiple ticket tiers. */
export const Default: Story = {
  render: () => <InteractiveTicketTypeGrid ticketTypes={TICKET_TYPES} />,
};

/** Mix of available and sold-out ticket types. */
export const MixedAvailability: Story = {
  render: () => <InteractiveTicketTypeGrid ticketTypes={MIXED_AVAILABILITY} />,
};

/** Free event with a single ticket type. */
export const FreeEvent: Story = {
  render: () => <InteractiveTicketTypeGrid ticketTypes={FREE_EVENT} />,
};

/** All controls disabled (payment phase). */
export const Disabled: Story = {
  render: () => (
    <InteractiveTicketTypeGrid ticketTypes={TICKET_TYPES} disabled />
  ),
};

/** Empty state when no ticket types exist. */
export const Empty: Story = {
  render: () => <InteractiveTicketTypeGrid ticketTypes={[]} />,
};
