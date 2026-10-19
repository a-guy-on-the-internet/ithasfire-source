import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { YStack, XStack } from "tamagui";

// @ts-ignore - storybook direct import path
import { IthasFireProvider, themes } from "../../tamagui";
import {
  QuantityStepper,
  type QuantityStepperProps,
} from "./forms/QuantityStepper";
import { Text } from "./typography/Text";

type StoryArgs = QuantityStepperProps & { theme: "swiss" | "ember" };

const meta: Meta<StoryArgs> = {
  title: "Forms/QuantityStepper",
  component: QuantityStepper,
  args: {
    value: 2,
    min: 0,
    max: 10,
    disabled: false,
    orientation: "horizontal",
  },
  decorators: [
    (Story, context) => {
      const themeName = context.args.theme === "ember" ? "ember" : "swiss";
      const surfaceColor =
        themeName === "ember" ? themes.ember.background : themes.swiss.background;

      return (
        <IthasFireProvider theme={themeName}>
          <YStack
            padding="$6"
            backgroundColor={surfaceColor}
            minHeight={200}
            gap="$4"
          >
            <Story />
          </YStack>
        </IthasFireProvider>
      );
    },
  ],
  argTypes: {
    orientation: {
      control: { type: "inline-radio" },
      options: ["horizontal", "vertical"],
    },
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
    },
  },
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  args: { orientation: "horizontal", theme: "swiss" },
};

export const Vertical: Story = {
  args: { orientation: "vertical", theme: "swiss" },
};

export const Disabled: Story = {
  args: { disabled: true, theme: "swiss" },
};

export const AtMinimum: Story = {
  args: { value: 0, min: 0, theme: "swiss" },
};

export const AtMaximum: Story = {
  args: { value: 10, max: 10, theme: "swiss" },
};

/** Interactive demo showing both orientations side-by-side */
const InteractiveDemo = () => {
  const [hQty, setHQty] = useState(1);
  const [vQty, setVQty] = useState(3);

  return (
    <XStack gap="$8" alignItems="center">
      <YStack gap="$2" alignItems="center">
        <Text variant="bodySmall" tone="muted">
          Horizontal
        </Text>
        <QuantityStepper
          value={hQty}
          onStep={(d) => setHQty((v) => Math.max(0, Math.min(10, v + d)))}
          min={0}
          max={10}
          aria-label="Horizontal demo"
        />
        <Text variant="bodySmall" tone="muted">
          {hQty} of 10
        </Text>
      </YStack>

      <YStack gap="$2" alignItems="center">
        <Text variant="bodySmall" tone="muted">
          Vertical
        </Text>
        <QuantityStepper
          value={vQty}
          onStep={(d) => setVQty((v) => Math.max(0, Math.min(8, v + d)))}
          min={0}
          max={8}
          orientation="vertical"
          aria-label="Vertical demo"
        />
        <Text variant="bodySmall" tone="muted">
          {vQty} of 8
        </Text>
      </YStack>
    </XStack>
  );
};

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
  args: { theme: "swiss" },
};
