import { action } from "@storybook/addon-actions";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { YStack } from "tamagui";

import {
  EventGridFilters,
  type EventGridFiltersProps,
} from "./EventGridFilters";
import { storyFilterConfig, storyFilterState } from "./story-helpers";

// @ts-ignore -- Storybook uses direct source imports for provider configuration.
import { IthasFireProvider, themes } from "../../../tamagui";

type EventGridFiltersStoryProps = EventGridFiltersProps;

const meta: Meta<EventGridFiltersStoryProps> = {
  title: "Experiences/EventGrid/EventGridFilters",
  component: EventGridFilters,
  args: {
    state: storyFilterState,
    onChange: action("filters-change"),
    variant: "inline",
    showSearch: true,
    align: "start",
    availableCategories: storyFilterConfig.availableCategories,
    availableVenues: storyFilterConfig.availableVenues,
    availableOrganizers: storyFilterConfig.availableOrganizers,
    dateLimits: storyFilterConfig.dateLimits,
    priceRange: storyFilterConfig.priceRange,
  },
  argTypes: {
    state: {
      control: false,
    },
    onChange: {
      control: false,
    },
    availableCategories: {
      control: false,
    },
    availableVenues: {
      control: false,
    },
    availableOrganizers: {
      control: false,
    },
  },
  parameters: {
    controls: {
      sort: "alpha",
    },
  },
  render: (args) => {
    const [state, setState] = useState(args.state);

    useEffect(() => {
      setState(args.state);
    }, [args.state]);

    const handleChange: EventGridFiltersProps["onChange"] = (next) => {
      setState(next);
      args.onChange?.(next);
    };

    const surfaceColor = themes.swiss.background;

    return (
      <IthasFireProvider theme="swiss">
        <YStack backgroundColor={surfaceColor} padding="$6" maxWidth={420}>
          <EventGridFilters {...args} state={state} onChange={handleChange} />
        </YStack>
      </IthasFireProvider>
    );
  },
};

type Story = StoryObj<EventGridFiltersStoryProps>;

export const Default: Story = {};

export const CenterAligned: Story = {
  args: {
    align: "center",
  },
};

export const WithoutSearch: Story = {
  args: {
    showSearch: false,
  },
};

export const CompactSheetVariant: Story = {
  args: {
    variant: "sheet",
  },
};

export default meta;
