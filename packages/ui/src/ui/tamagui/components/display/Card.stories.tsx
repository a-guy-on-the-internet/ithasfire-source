import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { YStack } from "tamagui";

// @ts-ignore -- Storybook story relies on direct source import; bundler resolution flags this within isolated lint checks.
import { IthasFireProvider, themes } from "../..";
import { Card, type CardProps, type CardVariant } from "./Card";

type CardStoryProps = CardProps & {
  containerTheme?: "swiss" | "ember";
};

const meta: Meta<CardStoryProps> = {
  title: "Ui/Tamagui/Components/Display/Card",
  component: Card,
  args: {
    variant: "dark",
    eyebrow: "Spotlight playbook",
    title: "Bundle VIP access with on-site perks",
    description:
      "Give superfans a reason to convert early. Combine merch, guaranteed check-in, and rapid pickup to lift margin without surprise fees.",
    stats: [
      {
        label: "Attachment rate",
        value: "38%",
        helperText: "↑ 6 pts vs Oct cohort",
      },
      {
        label: "Net promoter impact",
        value: "+12",
        helperText: "Surveyed night-of check-in",
      },
      {
        label: "Refund risk",
        value: "0.4%",
        helperText: "Steady week over week",
      },
      {
        label: "Average margin",
        value: "$64.20",
        helperText: "+$23.10 vs baseline",
      },
    ],
    primaryMetricLabel: "Projected uplift",
    primaryMetricValue: "+$12,640",
    primaryMetricHelper: "Modeled across next 6 events",
    ctaLabel: "Plan the bundle",
    onCtaPress: action("card-cta"),
    borderRadius: 0,
    containerTheme: "ember",
  },
  argTypes: {
    variant: {
      control: { type: "inline-radio" },
      options: ["dark", "light"],
    },
    borderRadius: {
      control: {
        type: "select",
      },
      options: [0],
      description: "Corner radius token applied to the card surface",
      table: {
        category: "Layout",
      },
    },
    containerTheme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
      table: {
        category: "Environment",
      },
    },
    onCtaPress: {
      control: false,
    },
    stats: {
      control: false,
    },
  },
  parameters: {
    layout: "padded",
    controls: {
      sort: "alpha",
    },
  },
  decorators: [
    (Story, { args }) => {
      const variant = (args.variant ?? "dark") as CardVariant;
      const themeName = (args.containerTheme ??
        (variant === "dark" ? "ember" : "swiss")) as "swiss" | "ember";
      const surfaceColor =
        themeName === "ember"
          ? themes.ember.background
          : themes.swiss.background;
      return (
        <IthasFireProvider theme={themeName}>
          <YStack
            backgroundColor={surfaceColor}
            padding="$6"
            minHeight={400}
            justifyContent="center"
          >
            <Story />
          </YStack>
        </IthasFireProvider>
      );
    },
  ],
};

type Story = StoryObj<CardStoryProps>;

export const Dark: Story = {};

export const Light: Story = {
  args: {
    variant: "light",
    containerTheme: "swiss",
    eyebrow: "Presale momentum",
    title: "Unlock 72-hour fan club access",
    description:
      "Invite top attendees into an early window with transparent pricing. Automate codes, schedule drops, and keep capacity honest.",
    stats: [
      {
        label: "Early conversion",
        value: "62%",
        helperText: "↑ 9 pts vs open sale",
      },
      {
        label: "Waitlist cleared",
        value: "412",
        helperText: "Released within 15 minutes",
      },
    ],
    primaryMetricLabel: "Revenue locked",
    primaryMetricValue: "$84,220",
    primaryMetricHelper: "Across first 24 hours",
    ctaLabel: "Launch presale",
  },
};

export const Minimal: Story = {
  args: {
    stats: undefined,
    primaryMetricLabel: undefined,
    primaryMetricValue: undefined,
    primaryMetricHelper: undefined,
    ctaLabel: undefined,
    eyebrow: "Crew briefing",
    title: "Streamline doors-open check-in",
    description:
      "Use scanner roles, offline QR fallbacks, and auto device provisioning to cut queues in half without burning staff.",
  },
};

export default meta;
