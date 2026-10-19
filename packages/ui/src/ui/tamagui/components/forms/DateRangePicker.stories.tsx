import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { YStack } from "tamagui";

import { IthasFireProvider, themes } from "../..";
import { DateRangePicker } from "./DateRangePicker";
import type {
  DateRangePickerProps,
  DateRangeValue,
} from "./DateRangePicker.types";

type DateRangeStoryProps = DateRangePickerProps & {
  theme?: "swiss" | "ember";
};

const meta: Meta<DateRangeStoryProps> = {
  title: "Ui/Tamagui/Components/Forms/Date Range Picker",
  component: DateRangePicker,
  args: {
    theme: "swiss",
    alignment: "horizontal",
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
    },
    value: {
      control: false,
    },
    onChange: {
      control: false,
    },
  },
  decorators: [
    (Story, { args }) => (
      <IthasFireProvider
        theme={(args as { theme?: "swiss" | "ember" }).theme ?? "swiss"}
      >
        <Story />
      </IthasFireProvider>
    ),
  ],
  parameters: {
    layout: "padded",
  },
  render: (args) => {
    const {
      theme: _theme,
      value: controlledValue,
      onChange: _onChange,
      ...rest
    } = args;
    const [range, setRange] = useState<DateRangeValue>(controlledValue ?? {});
    const themeName = (args.theme ?? "swiss") as "swiss" | "ember";
    const surfaceColor =
      themeName === "ember"
        ? themes.ember.backgroundStrong
        : themes.swiss.backgroundStrong;

    return (
      <YStack
        gap="$4"
        backgroundColor={surfaceColor}
        padding="$4"
        borderRadius="$lg"
      >
        <DateRangePicker
          {...rest}
          value={range}
          onChange={setRange}
          testIdBase="date-range-picker-story"
          forceOpen
        />
      </YStack>
    );
  },
};

type Story = StoryObj<DateRangeStoryProps>;

export const Default: Story = {};

export const Vertical: Story = {
  args: {
    alignment: "vertical",
  },
};

export const WithInitialRange: Story = {
  args: {
    value: {
      start: "2025-06-01",
      end: "2025-06-10",
    },
  },
};

export const CustomLabels: Story = {
  args: {
    alignment: "horizontal",
    startLabel: "Opens",
    endLabel: "Wraps (optional)",
    startPlaceholder: "Select opening date",
    endPlaceholder: "Leave blank to keep open",
  },
};

export const EuropeanFormat: Story = {
  args: {
    displayFormat: "single",
    startLabel: "Arrival",
    endLabel: "Departure",
  },
};

export default meta;
