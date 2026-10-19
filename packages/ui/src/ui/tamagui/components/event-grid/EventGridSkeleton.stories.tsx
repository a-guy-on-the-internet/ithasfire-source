import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

import {
  EventGridSkeleton,
  type EventGridSkeletonProps,
} from "./EventGridSkeleton";
import { EVENT_CARD_SIZE_OPTIONS } from "./sizes";

// @ts-ignore -- Storybook uses direct source imports for provider configuration.
import { IthasFireProvider, themes } from "../../../tamagui";

type EventGridSkeletonStoryProps = EventGridSkeletonProps;

const meta: Meta<EventGridSkeletonStoryProps> = {
  title: "Experiences/EventGrid/EventGridSkeleton",
  component: EventGridSkeleton,
  args: {
    rows: 3,
    columns: 3,
    layout: "grid",
    animate: true,
    size: "md",
  },
  argTypes: {
    size: {
      options: EVENT_CARD_SIZE_OPTIONS,
      control: { type: "inline-radio" },
    },
  },
  parameters: {
    controls: {
      sort: "alpha",
    },
  },
  render: (args) => {
    const surfaceColor = themes.swiss.background;

    return (
      <IthasFireProvider theme="swiss">
        <YStack
          backgroundColor={surfaceColor}
          padding="$6"
          maxWidth={720}
          alignItems="center"
        >
          <EventGridSkeleton {...args} />
        </YStack>
      </IthasFireProvider>
    );
  },
};

type Story = StoryObj<EventGridSkeletonStoryProps>;

export const Grid: Story = {};

export const Carousel: Story = {
  args: {
    layout: "carousel",
    columns: 4,
  },
};

export const Static: Story = {
  args: {
    animate: false,
  },
};

export default meta;
