import type { Meta, StoryObj } from "@storybook/react";
import { Check, Dot, ShieldAlert } from "lucide-react";
import { XStack, YStack } from "tamagui";

import { Badge, type BadgeProps } from "./Badge";

const meta: Meta<typeof Badge> = {
  title: "Ui/Tamagui/Components/Feedback/Badge",
  component: Badge,
  args: {
    children: "Pending",
    tone: "neutral",
    variant: "soft",
  },
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};

export const Tones: Story = {
  render: (args) => (
    <XStack space="$2">
      <Badge {...args} tone="info">
        Info
      </Badge>
      <Badge {...args} tone="success">
        Success
      </Badge>
      <Badge {...args} tone="warning">
        Warning
      </Badge>
      <Badge {...args} tone="danger">
        Danger
      </Badge>
    </XStack>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <XStack space="$2">
      <Badge {...args} size="xs">
        Mini
      </Badge>
      <Badge {...args} size="sm">
        Small
      </Badge>
      <Badge {...args} size="md">
        Medium
      </Badge>
      <Badge {...args} size="lg">
        Large
      </Badge>
    </XStack>
  ),
  args: {
    tone: "info",
  } satisfies Partial<BadgeProps>,
};

export const Variants: Story = {
  render: (args) => (
    <XStack space="$2" flexWrap="wrap">
      <Badge {...args} variant="soft">
        Soft
      </Badge>
      <Badge {...args} variant="solid">
        Solid
      </Badge>
      <Badge {...args} variant="outline">
        Outline
      </Badge>
    </XStack>
  ),
  args: {
    tone: "warning",
  } satisfies Partial<BadgeProps>,
};

export const WithIcons: Story = {
  render: (args) => (
    <YStack gap="$2">
      <Badge
        {...args}
        tone="success"
        leadingIcon={<Check size={14} strokeWidth={2} />}
      >
        Payout sent
      </Badge>
      <Badge
        {...args}
        tone="danger"
        variant="outline"
        leadingIcon={<ShieldAlert size={14} strokeWidth={2} />}
        trailingIcon={<Dot size={14} strokeWidth={2} />}
      >
        Action needed
      </Badge>
    </YStack>
  ),
};

export const DotOnly: Story = {
  args: {
    tone: "success",
    dot: true,
    children: undefined,
  } satisfies Partial<BadgeProps>,
  render: (args) => (
    <XStack space="$2">
      <Badge {...args} />
      <Badge {...args} tone="warning" />
      <Badge {...args} tone="danger" />
    </XStack>
  ),
};

export default meta;
