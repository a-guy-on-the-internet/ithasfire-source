import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

import {
  EventCardSkeleton,
  EventCardSkeletonGroup,
  type EventCardSkeletonProps,
} from "./EventCardSkeleton";
import { EVENT_CARD_SIZE_OPTIONS, getEventCardWidthForLayout } from "./sizes";

// @ts-ignore -- Storybook uses direct source imports for provider configuration.
import { IthasFireProvider, themes } from "../../../tamagui";

type EventCardSkeletonStoryProps = EventCardSkeletonProps;

const meta: Meta<EventCardSkeletonStoryProps> = {
  title: "Experiences/EventGrid/EventCardSkeleton",
  component: EventCardSkeleton,
  args: {
    layout: "vertical",
    animate: true,
    loading: true,
    size: "md",
  },
  argTypes: {
    size: {
      options: EVENT_CARD_SIZE_OPTIONS,
      control: { type: "inline-radio" },
    },
    loading: {
      control: { type: "boolean" },
      description:
        "Toggles the loading state that drives the skeleton animation.",
    },
  },
  parameters: {
    controls: {
      sort: "alpha",
    },
    docs: {
      description: {
        component:
          "The refreshed skeleton mirrors the event card layout with media overlays, tag pills, and CTA placeholders. Animations respect reduced-motion preferences on every surface.",
      },
    },
  },
  render: (args) => {
    const surfaceColor = themes.swiss.surface;
    const size = args.size ?? "md";
    const layout = args.layout ?? "vertical";
    const cardWidth = getEventCardWidthForLayout(size, layout);

    return (
      <IthasFireProvider theme="swiss">
        <YStack backgroundColor={surfaceColor} padding="$6" alignItems="center">
          <YStack width={cardWidth} maxWidth={cardWidth}>
            <EventCardSkeleton {...args} />
          </YStack>
        </YStack>
      </IthasFireProvider>
    );
  },
};

type Story = StoryObj<EventCardSkeletonStoryProps>;

export const Vertical: Story = {};

export const Horizontal: Story = {
  args: {
    layout: "horizontal",
  },
};

export const WithoutAnimation: Story = {
  args: {
    animate: false,
  },
};

export const NotLoading: Story = {
  args: {
    loading: false,
  },
};

export const Gallery: Story = {
  parameters: {
    controls: { disable: true },
  },
  render: (args) => {
    const layout = args.layout ?? "vertical";
    const size = args.size ?? "md";
    const animate = args.animate ?? true;
    const loading = args.loading ?? true;

    return (
      <IthasFireProvider theme="swiss">
        <YStack backgroundColor={themes.swiss.surface} padding="$6">
          <EventCardSkeletonGroup
            count={3}
            layout={layout}
            size={size}
            animate={animate}
            loading={loading}
          />
        </YStack>
      </IthasFireProvider>
    );
  },
};

export default meta;
