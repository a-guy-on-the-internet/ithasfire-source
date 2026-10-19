import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { Filter, Sparkles } from "lucide-react";

import { Chip } from "./Chip";

const meta: Meta<typeof Chip> = {
  title: "Ui/Tamagui/Components/Display/Chip",
  component: Chip,
  args: {
    children: "Waitlisted",
    tone: "neutral",
    variant: "subtle",
  },
  parameters: {
    layout: "padded",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Subtle: Story = {};

export const Filled: Story = {
  args: {
    tone: "success",
    variant: "filled",
    children: "Active",
  },
};

export const OutlineWithIcon: Story = {
  args: {
    tone: "info",
    variant: "outline",
    icon: <Filter size={14} />,
    children: "Filters",
    onPress: action("chip-pressed"),
  },
};

export const Removable: Story = {
  args: {
    tone: "warning",
    variant: "subtle",
    icon: <Sparkles size={14} />,
    children: "Beta",
    onRemove: action("chip-remove"),
  },
};
