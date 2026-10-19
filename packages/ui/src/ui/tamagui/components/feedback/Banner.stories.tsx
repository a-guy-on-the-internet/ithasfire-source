import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { Megaphone, ShieldAlert } from "lucide-react";
import { Button, XStack } from "tamagui";

import { Banner } from "./Banner";

const meta: Meta<typeof Banner> = {
  title: "Ui/Tamagui/Components/Feedback/Banner",
  component: Banner,
  args: {
    title: "Heads up",
    description: "System maintenance tonight from 12am–2am UTC.",
    tone: "info",
    variant: "surface",
    icon: <Megaphone size={18} />,
  },
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<typeof meta>;

export const SurfaceInfo: Story = {};

export const SoftSuccess: Story = {
  args: {
    tone: "success",
    variant: "soft",
    description:
      "Ticket payouts have been released to every connected account.",
  },
};

export const WithActions: Story = {
  args: {
    actions: (
      <XStack gap="$2">
        <Button
          size="$3"
          variant="outlined"
          onPress={action("banner-view-details")}
        >
          View details
        </Button>
        <Button size="$3" onPress={action("banner-subscribe")}>
          Subscribe
        </Button>
      </XStack>
    ),
  },
};

export const SolidWarning: Story = {
  args: {
    tone: "warning",
    variant: "solid",
    icon: <ShieldAlert size={18} />,
    description:
      "Billing will be unavailable while we migrate payment providers.",
    onDismiss: () => {
      // eslint-disable-next-line no-console
      console.log("Banner dismissed");
    },
  },
};

export const Compact: Story = {
  args: {
    compact: true,
    description: "New scanner builds are ready for QA.",
    onDismiss: action("banner-dismiss"),
  },
};

export default meta;
