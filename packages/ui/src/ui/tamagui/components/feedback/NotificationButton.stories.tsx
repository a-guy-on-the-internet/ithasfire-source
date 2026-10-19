import type { Meta, StoryObj } from "@storybook/react";
import { Mail } from "lucide-react";

import { NotificationButton } from "./NotificationButton";

const meta = {
  title: "Ui/Tamagui/Components/Feedback/Notification Button",
  component: NotificationButton,
  args: {
    "aria-label": "View alerts",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof NotificationButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithCount: Story = {
  args: {
    count: 12,
  },
};

export const Indicator: Story = {
  args: {
    showIndicator: true,
  },
};

export const CustomGlyph: Story = {
  args: {
    count: 3,
    glyph: <Mail size={18} />,
    tone: "info",
  },
};
