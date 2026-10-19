import type { Meta, StoryObj } from "@storybook/react";
import { XStack, YStack } from "tamagui";

import {
  IthasFireProvider,
  type IthasFireThemeName,
} from "../../../tamagui";
import { Text } from "../typography/Text";
import { ClaimedBar } from "./ClaimedBar";
import { DateBlock } from "./DateBlock";
import { MetaList } from "./MetaList";
import { PriceBlock } from "./PriceBlock";

/**
 * Design System v2 section 05 — the event-display molecules the section-06
 * organisms (EventCard / TicketStub / LineupRow) are assembled from.
 */
type MoleculesStoryProps = {
  theme: IthasFireThemeName;
};

const meta: Meta<MoleculesStoryProps> = {
  title: "Experiences/Events/Molecules",
  args: {
    theme: "ember",
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember", "stub"],
      table: { category: "Environment" },
    },
  },
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<MoleculesStoryProps>;

const SectionLabel = ({ children }: { children: string }) => (
  <Text variant="kicker" tone="accent">
    {children}
  </Text>
);

const MoleculesShowcase = ({ theme }: MoleculesStoryProps) => (
  <IthasFireProvider theme={theme}>
    <YStack backgroundColor="$background" padding="$6" gap="$6" maxWidth={640}>
      <YStack gap="$3">
        <SectionLabel>Date block</SectionLabel>
        <XStack>
          <DateBlock
            month="Aug"
            day="15"
            weekday="Sat"
            borderWidth={2}
            borderColor="$borderColorSoft"
          />
        </XStack>
      </YStack>

      <YStack gap="$3">
        <SectionLabel>Price block</SectionLabel>
        <XStack gap="$4">
          <PriceBlock amount="$45" label="From" />
          <PriceBlock amount="FREE" label="RSVP" free />
        </XStack>
      </YStack>

      <YStack gap="$3">
        <SectionLabel>Meta list</SectionLabel>
        <MetaList
          items={[
            { kind: "time", label: "SAT AUG 15 · 2:00 PM" },
            { kind: "place", label: "RIVERFRONT PARK, NASHVILLE" },
          ]}
        />
      </YStack>

      <YStack gap="$4">
        <SectionLabel>Claimed bar — accent &lt;80% · support ≥80%</SectionLabel>
        <ClaimedBar percent={34} />
        <ClaimedBar percent={67} />
        <ClaimedBar percent={88} />
      </YStack>
    </YStack>
  </IthasFireProvider>
);

export const Ember: Story = {
  args: { theme: "ember" },
  render: (args) => <MoleculesShowcase {...args} />,
};

export const Light: Story = {
  args: { theme: "swiss" },
  render: (args) => <MoleculesShowcase {...args} />,
};

export const Stub: Story = {
  args: { theme: "stub" },
  render: (args) => <MoleculesShowcase {...args} />,
};

export default meta;
