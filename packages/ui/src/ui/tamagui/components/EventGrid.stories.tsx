import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { YStack } from "tamagui";

// @ts-ignore -- Storybook uses direct source imports for provider configuration.
import { IthasFireProvider, themes } from "../../tamagui";
import { EventGrid, type EventGridProps } from "./event-grid";
import {
  storyEvents,
  storyFilterConfig,
  storyFilterState,
} from "./event-grid/story-helpers";
import { EVENT_CARD_SIZE_OPTIONS } from "./event-grid/sizes";

type EventGridStoryProps = EventGridProps & {
  enableFilters?: boolean;
  spacingRow?: EventGridProps["spacing"] extends { row?: infer R }
    ? R
    : number | string;
  spacingColumn?: EventGridProps["spacing"] extends { column?: infer C }
    ? C
    : number | string;
};

const resolveSpacing = (args: EventGridStoryProps) => {
  const { spacingRow, spacingColumn, spacing } = args;
  const nextSpacing: EventGridProps["spacing"] = {
    ...(spacing ?? {}),
    ...(typeof spacingRow !== "undefined" && spacingRow !== "auto"
      ? { row: spacingRow }
      : {}),
    ...(typeof spacingColumn !== "undefined" && spacingColumn !== "auto"
      ? { column: spacingColumn }
      : {}),
  };

  if (Object.keys(nextSpacing).length === 0) {
    return undefined;
  }

  return nextSpacing;
};

const withFilters = (args: EventGridStoryProps): EventGridProps => {
  const {
    enableFilters,
    filters: providedFilters,
    spacingRow,
    spacingColumn,
    spacing,
    ...rest
  } = args;

  const spacingOverride = resolveSpacing(args);
  const gridProps: EventGridProps = {
    ...rest,
    ...(spacingOverride ? { spacing: spacingOverride } : {}),
  };

  if (providedFilters) {
    return {
      ...gridProps,
      filters: {
        defaultState: providedFilters.defaultState ?? storyFilterState,
        onChange: providedFilters.onChange ?? action("filters-change"),
        ...storyFilterConfig,
        ...providedFilters,
      },
    };
  }

  if (!enableFilters) {
    return gridProps;
  }

  return {
    ...gridProps,
    filters: {
      enabled: true,
      defaultState: storyFilterState,
      onChange: action("filters-change"),
      ...storyFilterConfig,
    },
  };
};

const meta: Meta<EventGridStoryProps> = {
  title: "Experiences/EventGrid",
  component: EventGrid,
  args: {
    events: storyEvents,
    variant: "auto",
    cardSize: "md",
    enableFilters: true,
    onCardPress: action("card-press"),
    onFavoriteToggle: action("favorite-toggle"),
    spacingPreset: "default",
  },
  argTypes: {
    enableFilters: {
      control: { type: "boolean" },
      table: {
        category: "State",
      },
    },
    variant: {
      control: { type: "inline-radio" },
      options: ["auto", "grid", "carousel"],
      table: {
        category: "Layout",
      },
    },
    groupBy: {
      control: { type: "inline-radio" },
      options: ["none", "date", "venue"],
      table: {
        category: "Grouping",
      },
    },
    pageSize: {
      control: { type: "number" },
      table: {
        category: "Pagination",
      },
    },
    onCardPress: {
      control: false,
    },
    onFavoriteToggle: {
      control: false,
    },
    cardSize: {
      control: { type: "inline-radio" },
      options: EVENT_CARD_SIZE_OPTIONS,
      table: {
        category: "Layout",
      },
    },
    spacingColumn: {
      name: "Column spacing",
      control: { type: "select" },
      options: ["auto", "$0", "$1", "$2", "$3", "$4", "$5", "$6"],
      table: {
        category: "Layout",
      },
    },
    spacingRow: {
      name: "Row spacing",
      control: { type: "select" },
      options: ["auto", "$0", "$1", "$2", "$3", "$4", "$5", "$6"],
      table: {
        category: "Layout",
      },
    },
    spacingPreset: {
      name: "Spacing preset",
      control: { type: "inline-radio" },
      options: ["default", "flush", "packed"],
      table: {
        category: "Layout",
      },
    },
  },
  parameters: {
    layout: "fullscreen",
    controls: {
      sort: "alpha",
    },
  },
  render: (args) => {
    const surfaceColor = themes.swiss.background;

    return (
      <IthasFireProvider theme="swiss">
        <YStack backgroundColor={surfaceColor} padding="$6" minHeight="100vh">
          <EventGrid {...withFilters(args)} />
        </YStack>
      </IthasFireProvider>
    );
  },
};

type Story = StoryObj<EventGridStoryProps>;

export const ResponsiveGrid: Story = {};

export const Carousel: Story = {
  args: {
    variant: "carousel",
    pageSize: undefined,
  },
};

export const GroupedByVenue: Story = {
  args: {
    groupBy: "venue",
    enableFilters: false,
  },
};

export const SmallCards: Story = {
  args: {
    cardSize: "sm",
  },
};

export const LargeCards: Story = {
  args: {
    cardSize: "lg",
  },
};

export default meta;
