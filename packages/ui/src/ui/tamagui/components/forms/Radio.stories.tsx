import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { RadioGroup, Theme, XStack, YStack } from "tamagui";

import { Radio, RadioGroupField, type RadioProps } from "./Radio";
import { Text } from "../typography/Text";

const meta: Meta<typeof Radio> = {
  title: "Ui/Tamagui/Components/Forms/Radio",
  component: Radio,
  args: {
    size: "md",
    disabled: false,
    required: false,
    frameBackgroundColor: undefined,
    frameBorderColor: undefined,
    indicatorColor: undefined,
  },
  argTypes: {
    id: { control: false },
    label: { control: false },
    description: { control: false },
    value: { control: false },
    testIdBase: { control: { type: "text" } },
    qaId: { control: { type: "text" } },
    size: {
      control: { type: "inline-radio" },
      options: ["sm", "md", "lg"],
    },
    required: { control: { type: "boolean" } },
    disabled: { control: { type: "boolean" } },
    frameBackgroundColor: { control: { type: "color" } },
    frameBorderColor: { control: { type: "color" } },
    indicatorColor: { control: { type: "color" } },
  },
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<typeof meta>;

type ShowcaseOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  required?: boolean;
};

const defaultOptions: ShowcaseOption[] = [
  {
    value: "general",
    label: "General admission",
    description: "Balanced price and access for most guests.",
  },
  {
    value: "vip",
    label: "VIP experience",
    description: "Includes lounge and expedited entry perks.",
  },
  {
    value: "backstage",
    label: "Backstage tour",
    description: "Limited availability with behind-the-scenes access.",
    required: true,
  },
  {
    value: "soldout",
    label: "Sold out option",
    description: "Example of a disabled state.",
    disabled: true,
  },
];

const sizeVariants: Array<{ size: RadioProps["size"]; label: string }> = [
  { size: "sm", label: "Small" },
  { size: "md", label: "Medium" },
  { size: "lg", label: "Large" },
];

export const Playground: Story = {
  render: (args) => {
    const [selected, setSelected] = useState<string>(defaultOptions[0]!.value);
    const { disabled: disabledArg, required: requiredArg, ...restArgs } = args;

    return (
      <YStack gap="$5">
        <RadioGroupField value={selected} onValueChange={setSelected}>
          {defaultOptions.map(
            ({ value, label, description, disabled, required }) => (
              <Radio
                key={value}
                value={value}
                label={label}
                description={description}
                disabled={disabled ?? disabledArg}
                required={required ?? requiredArg}
                {...restArgs}
              />
            ),
          )}
        </RadioGroupField>
        <Text variant="bodySmall" tone="muted" margin={0}>
          Currently selected: {selected}
        </Text>
      </YStack>
    );
  },
};

export const SizesAndThemes: Story = {
  render: (args) => {
    const [selectedLight, setSelectedLight] = useState("swiss-md");
    const [selectedDark, setSelectedDark] = useState("ember-md");
    const { size: _ignored, ...restArgs } = args;

    const renderGroup = (
      themeName: "swiss" | "ember",
      value: string,
      onValueChange: (next: string) => void,
      prefix: "swiss" | "ember",
    ) => (
      <Theme name={themeName}>
        <YStack
          backgroundColor="$backgroundStrong"
          padding="$5"
          borderRadius="$lg"
          gap="$4"
        >
          <Text variant="body" weight="bold" margin={0}>
            {themeName === "swiss" ? "Light theme" : "Dark theme"}
          </Text>
          <RadioGroup
            value={value}
            onValueChange={onValueChange}
            orientation="vertical"
            gap="$3"
          >
            {sizeVariants.map(({ size, label }) => (
              <Radio
                key={`${prefix}-${size}`}
                value={`${prefix}-${size}`}
                label={`${label} radio`}
                size={size}
                {...restArgs}
              />
            ))}
          </RadioGroup>
        </YStack>
      </Theme>
    );

    return (
      <XStack gap="$5" flexWrap="wrap">
        {renderGroup("swiss", selectedLight, setSelectedLight, "swiss")}
        {renderGroup("ember", selectedDark, setSelectedDark, "ember")}
      </XStack>
    );
  },
};

export const CustomStyling: Story = {
  args: {
    frameBackgroundColor: "#F4F3FF",
    frameBorderColor: "#5D3BEE",
    indicatorColor: "#5D3BEE",
  },
  render: (args) => {
    const [selected, setSelected] = useState("custom-a");

    const customOptions: ShowcaseOption[] = [
      {
        value: "custom-a",
        label: "Early bird",
        description: "Preferred when offering promotional pricing.",
      },
      {
        value: "custom-b",
        label: "Premier",
        description: "Highlights brand-forward styling overrides.",
      },
    ];

    return (
      <RadioGroupField value={selected} onValueChange={setSelected}>
        {customOptions.map(({ value, label, description }) => (
          <Radio
            key={value}
            value={value}
            label={label}
            description={description}
            {...args}
          />
        ))}
      </RadioGroupField>
    );
  },
};

export default meta;
