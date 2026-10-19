import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Paragraph, YStack } from "tamagui";

import { IthasFireProvider } from "../..";
import { Text, type TextProps } from "./Text";

const meta: Meta<typeof Text> = {
  title: "Ui/Tamagui/Components/Typography/Text",
  component: Text,
  args: {
    children: "Ithas Fire brings events to life.",
    tone: "default",
    weight: "regular",
    emphasis: "normal",
    truncate: false,
    qaId: undefined,
    testId: undefined,
  },
  argTypes: {
    tone: {
      control: { type: "inline-radio" },
      options: [
        "default",
        "warning",
        "accent",
        "brandPrimary",
        "brandSecondary",
        "error",
      ],
    },
    weight: {
      control: { type: "inline-radio" },
      options: ["regular", "medium", "semibold", "bold"],
    },
    emphasis: {
      control: { type: "inline-radio" },
      options: ["normal", "muted", "subtle"],
    },
    truncate: {
      control: { type: "boolean" },
    },
    testId: {
      control: { type: "text" },
    },
    qaId: {
      control: { type: "text" },
    },
    asChild: {
      control: false,
    },
  },
  decorators: [
    (Story) => (
      <IthasFireProvider theme="swiss">
        <Story />
      </IthasFireProvider>
    ),
  ],
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<typeof meta>;

const tones: Array<{ label: string; tone: TextProps["tone"] }> = [
  { label: "Default", tone: "default" },
  { label: "Warning", tone: "warning" },
  { label: "Accent", tone: "accent" },
  { label: "Brand Primary", tone: "brandPrimary" },
  { label: "Brand Secondary", tone: "brandSecondary" },
  { label: "Error", tone: "error" },
];

export const Playground: Story = {
  render: (args) => <Text {...args} />,
};

export const ToneShowcase: Story = {
  render: (args) => (
    <YStack gap="$3">
      {tones.map(({ label, tone }) => (
        <YStack key={tone} gap="$1">
          <Paragraph fontSize="$2" color="$colorMuted">
            {label}
          </Paragraph>
          <Text {...args} tone={tone}>
            Ithas Fire chooses the right tone for each semantic state.
          </Text>
        </YStack>
      ))}
    </YStack>
  ),
};

export const Truncation: Story = {
  args: {
    truncate: true,
  },
  render: (args) => (
    <YStack width={280} gap="$2">
      <Text {...args}>
        Ithas Fire surfaces a concise, truncated snippet when space is
        constrained.
      </Text>
      <Paragraph fontSize="$2" color="$colorMuted">
        Resize the canvas to observe ellipsis behavior.
      </Paragraph>
    </YStack>
  ),
};

export const EmphasisControl: Story = {
  render: (args) => {
    const [emphasis, setEmphasis] = useState<TextProps["emphasis"]>(
      args.emphasis ?? "normal",
    );

    return (
      <YStack gap="$3">
        <YStack gap="$2">
          <Paragraph fontSize="$2" color="$colorMuted">
            Emphasis
          </Paragraph>
          <YStack gap="$1">
            {(
              ["normal", "muted", "subtle"] satisfies Array<
                TextProps["emphasis"]
              >
            ).map((value) => (
              <Text
                key={value}
                tone={args.tone}
                weight="medium"
                emphasis={value}
                onPress={() => setEmphasis(value)}
                {...args}
              >
                {value === emphasis ? "Selected" : "Tap to select"}: {value}
              </Text>
            ))}
          </YStack>
        </YStack>

        <Text tone={args.tone} weight="bold" emphasis={emphasis}>
          Active emphasis: {emphasis}
        </Text>
      </YStack>
    );
  },
};

export default meta;
