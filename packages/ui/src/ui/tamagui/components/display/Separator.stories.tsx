import type { Meta, StoryObj } from "@storybook/react";
import { XStack, YStack } from "tamagui";

import { Separator, type SeparatorProps } from "./Separator";
import { Text } from "../typography/Text";

const meta: Meta<typeof Separator> = {
  title: "Ui/Tamagui/Components/Display/Separator",
  component: Separator,
  args: {
    orientation: "horizontal",
    thickness: 1,
  },
  parameters: {
    layout: "padded",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const HorizontalPreview = (args: SeparatorProps) => (
  <YStack width={360} gap="$3">
    <Text variant="body">Upcoming</Text>
    <Separator {...args} />
    <Text variant="body">Past</Text>
  </YStack>
);

export const Horizontal: Story = {
  render: (args) => <HorizontalPreview {...args} />,
};

export const Vertical: Story = {
  args: {
    orientation: "vertical",
    thickness: 2,
    height: 56,
  },
  render: (args) => (
    <XStack gap="$3" alignItems="center">
      <Text variant="body">Filters</Text>
      <Separator {...args} />
      <Text variant="body">Actions</Text>
    </XStack>
  ),
};

export const AccentToken: Story = {
  args: {
    colorToken: "accent",
    thickness: 2,
  },
  render: (args) => <HorizontalPreview {...args} />,
};
