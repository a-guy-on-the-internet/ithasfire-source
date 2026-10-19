import { action } from "@storybook/addon-actions";
import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

import {
  IthasFireProvider,
  type IthasFireThemeName,
} from "../../../tamagui";
import { LineupRow } from "./LineupRow";

/**
 * Design System v2 section 06, renderer C — maximum density, text-first.
 * Full catalogs and schedule pages, 10+ events; needs ≥5 rows to read as a
 * lineup (the two-row story is a grammar demo, not a usage endorsement).
 */
type LineupRowStoryProps = {
  theme: IthasFireThemeName;
};

const meta: Meta<LineupRowStoryProps> = {
  title: "Experiences/Events/LineupRow",
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

type Story = StoryObj<LineupRowStoryProps>;

const rows = [
  {
    dateLabel: "JUL 24",
    timeLabel: "FRI · 10 PM",
    name: "Midnight Vinyl",
    category: "Music",
    price: "$12",
  },
  {
    dateLabel: "JUL 18",
    timeLabel: "SAT · 8:30 PM",
    name: "Neon Run 5K",
    category: "Sports",
    price: "$30",
  },
  {
    dateLabel: "JUL 30",
    timeLabel: "THU · 7 PM",
    name: "Ash & Oak Supper Club",
    category: "Food & Drink",
    price: "$65",
  },
  {
    dateLabel: "AUG 01",
    timeLabel: "SAT · NOON",
    name: "Printmakers Market",
    category: "Art",
    price: "FREE",
  },
  {
    dateLabel: "AUG 02",
    timeLabel: "SUN · 12 PM",
    name: "Smoke & Ember BBQ Cookoff",
    category: "Food & Drink",
    price: "FREE",
  },
] as const;

const LineupShowcase = ({ theme }: LineupRowStoryProps) => (
  <IthasFireProvider theme={theme}>
    <YStack backgroundColor="$background" padding="$6" gap={0}>
      {rows.map((row, index) => (
        <LineupRow
          key={row.name}
          {...row}
          // Collapse doubled hairlines between adjacent rows (doc pattern:
          // subsequent rows drop their top border).
          borderTopWidth={index === 0 ? 1 : 0}
          onPress={action(`row-press-${index}`)}
        />
      ))}
    </YStack>
  </IthasFireProvider>
);

export const Lineup: Story = {
  render: (args) => <LineupShowcase {...args} />,
};

export const StubTheme: Story = {
  args: { theme: "stub" },
  render: (args) => <LineupShowcase {...args} />,
};

export const LightTheme: Story = {
  args: { theme: "swiss" },
  render: (args) => <LineupShowcase {...args} />,
};

/**
 * Subtitle + dateless variant — the search adoption: no structured start time,
 * so the when-column drops out and the venue/date meta rides `subtitle`.
 */
export const WithSubtitleNoDate: Story = {
  render: ({ theme }) => (
    <IthasFireProvider theme={theme}>
      <YStack backgroundColor="$background" padding="$6" gap={0}>
        {[
          {
            name: "Midnight Vinyl",
            subtitle: "The Basement East · Sat, Jul 24, 10:00 PM",
            category: "Password",
            price: "From $12",
          },
          {
            name: "Neon Run 5K",
            subtitle: "Riverfront Park · Sun, Jul 18, 8:30 AM",
            price: "$30",
          },
          {
            name: "Ash & Oak Supper Club",
            subtitle: "Germantown · Thu, Jul 30, 7:00 PM",
            category: "Application",
            price: "From $65",
          },
        ].map((row, index) => (
          <LineupRow
            key={row.name}
            {...row}
            borderTopWidth={index === 0 ? 1 : 0}
            onPress={action(`row-press-${index}`)}
          />
        ))}
      </YStack>
    </IthasFireProvider>
  ),
};

/** Compact density — narrow container: 72px when-column, no category chip. */
export const Compact: Story = {
  render: ({ theme }) => (
    <IthasFireProvider theme={theme}>
      <YStack backgroundColor="$background" padding="$4" gap={0} maxWidth={380}>
        {rows.map((row, index) => (
          <LineupRow
            key={row.name}
            {...row}
            compact
            borderTopWidth={index === 0 ? 1 : 0}
            onPress={action(`row-press-${index}`)}
          />
        ))}
      </YStack>
    </IthasFireProvider>
  ),
};

export default meta;
