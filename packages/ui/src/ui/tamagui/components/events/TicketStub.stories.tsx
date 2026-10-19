import { action } from "@storybook/addon-actions";
import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

import {
  IthasFireProvider,
  type IthasFireThemeName,
} from "../../../tamagui";
import { TicketStub, type TicketStubProps } from "./TicketStub";

/**
 * Design System v2 section 06, renderer B — curated lists (4–10 events),
 * editorial feel, max 2 columns. Never in auto-fill grids.
 */
type TicketStubStoryProps = TicketStubProps & {
  theme: IthasFireThemeName;
};

const meta: Meta<TicketStubStoryProps> = {
  title: "Experiences/Events/TicketStub",
  component: TicketStub,
  args: {
    theme: "ember",
    date: { month: "Aug", day: "02", weekday: "Sun" },
    category: "Food & Drink",
    title: "Smoke & Ember BBQ Cookoff",
    where: "Franklin Fairgrounds · 12:00 PM",
    price: { amount: "FREE", label: "RSVP", free: true },
    claimedPercent: 88,
    onPress: action("stub-press"),
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember", "stub"],
      table: { category: "Environment" },
    },
    onPress: { control: false },
  },
  parameters: {
    layout: "padded",
  },
  render: ({ theme, ...args }) => (
    <IthasFireProvider theme={theme}>
      <YStack backgroundColor="$background" padding="$6" alignItems="center">
        <TicketStub {...args} />
      </YStack>
    </IthasFireProvider>
  ),
};

type Story = StoryObj<TicketStubStoryProps>;

/** The doc's example: FREE price block + 88% hot claimed footer. */
export const SmokeAndEmber: Story = {};

export const PaidWithModerateClaim: Story = {
  args: {
    date: { month: "Aug", day: "15", weekday: "Sat" },
    category: "Music",
    title: "Hearth & Howl Music Festival",
    where: "Riverfront Park, Nashville · 2:00 PM",
    price: { amount: "$45", label: "From", free: false },
    claimedPercent: 72,
  },
};

export const NoClaimData: Story = {
  args: {
    claimedPercent: undefined,
  },
};

export const StubTheme: Story = {
  args: { theme: "stub" },
};

export const LightTheme: Story = {
  args: { theme: "swiss" },
};

export default meta;
