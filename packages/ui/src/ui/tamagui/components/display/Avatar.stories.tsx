import type { Meta, StoryObj } from "@storybook/react";
import { XStack } from "tamagui";

import { Avatar, type AvatarProps } from "./Avatar";

const meta: Meta<typeof Avatar> = {
  title: "Ui/Tamagui/Components/Display/Avatar",
  component: Avatar,
  args: {
    initials: "TH",
    alt: "Ticket Hunter",
    size: "md",
    shape: "circle",
  },
  argTypes: {
    size: {
      control: {
        type: "inline-radio",
      },
      options: ["sm", "md", "lg"],
      description: "Visual scale of the avatar frame",
      table: {
        category: "Appearance",
      },
    },
    shape: {
      control: {
        type: "inline-radio",
      },
      options: ["circle", "square"],
      description: "Border radius style for the avatar",
      table: {
        category: "Appearance",
      },
    },
    initials: {
      control: "text",
      description: "Fallback initials shown when no image is provided",
    },
    src: {
      control: "text",
      description: "Image source URL for the avatar",
    },
    alt: {
      control: "text",
      description: "Accessible label for the avatar image",
    },
  },
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<typeof meta>;

export const Initials: Story = {
  render: (args) => <Avatar {...args} />,
};

export const Sizes: Story = {
  render: (args) => (
    <XStack space="$3" alignItems="center">
      <Avatar {...args} size="sm" />
      <Avatar {...args} size="md" />
      <Avatar {...args} size="lg" />
    </XStack>
  ),
  parameters: {
    controls: {
      exclude: ["size"],
    },
  },
};

export const WithImage: Story = {
  args: {
    src: "https://i.pravatar.cc/80?img=65",
  },
};

export const Square: Story = {
  args: {
    shape: "square",
  } satisfies Partial<AvatarProps>,
};

export default meta;
