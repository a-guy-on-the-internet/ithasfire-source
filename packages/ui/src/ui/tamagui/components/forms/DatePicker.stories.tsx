import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { YStack } from "tamagui";

import { IthasFireProvider, themes } from "../..";
import { DatePicker, type DatePickerProps } from "./DatePicker";
import { Text } from "../typography/Text";

type DatePickerStoryProps = DatePickerProps & {
  theme?: "swiss" | "ember";
};

const meta: Meta<DatePickerStoryProps> = {
  title: "Ui/Tamagui/Components/Forms/Date Picker",
  component: DatePicker,
  args: {
    theme: "swiss",
    placeholder: "Select date",
    disabled: false,
    fullWidth: false,
    variant: "picker",
    label: "Date",
    forceOpen: true,
    alignment: "horizontal",
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
      table: {
        category: "Environment",
      },
    },
    variant: {
      control: { type: "inline-radio" },
      options: ["picker", "input"],
    },
    alignment: {
      control: { type: "inline-radio" },
      options: ["horizontal", "vertical"],
    },
    value: {
      control: false,
    },
    onChange: {
      control: false,
    },
  },
  parameters: {
    layout: "padded",
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
  render: (args) => {
    const { theme: _theme, value: _value, onChange: _onChange, ...rest } = args;
    const [selectedDate, setSelectedDate] = useState<string | undefined>(
      _value,
    );
    const themeName = (args.theme ?? "swiss") as "swiss" | "ember";
    const surfaceColor =
      themeName === "ember"
        ? themes.ember.backgroundStrong
        : themes.swiss.backgroundStrong;

    return (
      <YStack
        gap="$3"
        backgroundColor={surfaceColor}
        padding="$4"
        borderRadius="$lg"
        maxWidth={320}
      >
        <Text variant="body" tone="muted" margin={0}>
          Showcase how the combined picker/input control behaves across both
          interaction modes.
        </Text>
        <DatePicker
          {...rest}
          value={selectedDate}
          onChange={setSelectedDate}
          testId="date-picker-story"
        />
      </YStack>
    );
  },
};

type Story = StoryObj<DatePickerStoryProps>;

export const Default: Story = {};

export const PreselectedValue: Story = {
  args: {
    value: "2025-07-04",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const WithDateLimits: Story = {
  args: {
    min: "2025-01-01",
    max: "2025-12-31",
  },
};

export const InputVariant: Story = {
  args: {
    variant: "input",
  },
};

export const ForceOpen: Story = {
  args: {
    forceOpen: true,
    fullWidth: true,
  },
};

export default meta;
