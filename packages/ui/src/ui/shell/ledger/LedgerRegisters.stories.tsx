import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { YStack } from "tamagui";

import { Button, Text } from "../../tamagui/components";
import { LedgerContextStrip } from "./LedgerContextStrip";
import { LedgerSectionTabs } from "./LedgerSectionTabs";
import { LedgerTopbar } from "./LedgerTopbar";

const meta: Meta<typeof LedgerTopbar> = {
  title: "Ui/Shell/Ledger Registers",
  component: LedgerTopbar,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const sections = [
  { href: "/dash/overview", label: "Overview" },
  { href: "/dash/attendees", label: "Attendees", count: 1284 },
  { href: "/dash/orders", label: "Orders" },
  { href: "/dash/checkin", label: "Check-in" },
  { href: "/dash/payouts", label: "Payouts" },
];

const manySections = [
  ...sections,
  { href: "/dash/promos", label: "Promos" },
  { href: "/dash/team", label: "Team" },
  { href: "/dash/settings", label: "Settings" },
  { href: "/dash/bookings", label: "Bookings", count: 3 },
];

/** The three registers stacked as the ledger shell composes them. */
export const ThreeRegisters: Story = {
  render: () => (
    <YStack minHeight="100vh" backgroundColor="$surfaceMuted">
      <LedgerTopbar
        surfaceRole="Organizer"
        right={
          <Button size="$2" variant="ghost" onPress={action("account")}>
            Account
          </Button>
        }
      />
      <LedgerSectionTabs
        items={sections}
        current="/dash/attendees"
        label="Sections"
        onSelect={action("section-select")}
      />
      <LedgerContextStrip
        items={["Aug 15 · Riverfront Park", "Published"]}
        right="1,284 / 1,500 sold"
      />
      <YStack padding="$5">
        <Text variant="body" tone="muted">
          Page content sits below the registers at full width.
        </Text>
      </YStack>
    </YStack>
  ),
};

/** Topbar only — brand, role chip, left and right slots. */
export const TopbarOnly: Story = {
  render: () => (
    <LedgerTopbar
      surfaceRole="Admin"
      left={
        <Text variant="overline" tone="muted">
          ← All events
        </Text>
      }
      right={
        <Button size="$2" variant="ghost" onPress={action("account")}>
          Account
        </Button>
      }
    />
  ),
};

/** Past the six-item ceiling the row scrolls; resize below 640px for snap. */
export const SectionTabsOverflowing: Story = {
  render: () => (
    <LedgerSectionTabs
      items={manySections}
      current="/dash/promos"
      label="Sections"
      overflow={
        <Button size="$2" variant="ghost" onPress={action("overflow")}>
          More
        </Button>
      }
    />
  ),
};

/** Register 3 alone — facts only, no controls. */
export const ContextStripOnly: Story = {
  render: () => (
    <LedgerContextStrip
      items={["Acme Organizers", "3 events this week", "Stripe connected"]}
      right="Synced 2m ago"
    />
  ),
};
