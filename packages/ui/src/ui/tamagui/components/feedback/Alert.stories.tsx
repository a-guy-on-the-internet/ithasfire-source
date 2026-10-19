import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";

import { Alert, type AlertProps } from "./Alert";
import { Button } from "../forms/Button";

const meta: Meta<typeof Alert> = {
  title: "Ui/Tamagui/Components/Feedback/Alert",
  component: Alert,
  args: {
    title: "Heads up",
    description: "System maintenance tonight from 12am–2am UTC.",
    tone: "info",
    icon: <AlertCircle size={18} />,
    variant: "soft",
  },
  parameters: {
    layout: "padded",
  },
};

type Story = StoryObj<typeof meta>;

export const Info: Story = {};

export const Success: Story = {
  args: {
    tone: "success",
    title: "All systems go",
    description: "Everything is online and running smoothly.",
    icon: <CheckCircle2 size={18} />,
  },
};

export const Surface: Story = {
  args: {
    variant: "surface",
    title: "Visibility update",
    description: "We simplified alert styling for neutral notifications.",
  },
};

export const SolidWarning: Story = {
  args: {
    tone: "warning",
    variant: "solid",
    icon: <AlertTriangle size={18} />,
    title: "Deployment paused",
    description: "We detected elevated error rates during the last rollout.",
  },
};

export const WithActions: Story = {
  args: {
    tone: "success",
    actions: (
      <>
        <Button
          size="$3"
          variant="ghost"
          onPress={action("alert-remind-later")}
        >
          Remind me later
        </Button>
        <Button size="$3" onPress={action("alert-resolve-now")}>
          Resolve now
        </Button>
      </>
    ),
  } satisfies Partial<AlertProps>,
};

export const Dismissible: Story = {
  args: {
    tone: "danger",
    title: "Immediate action required",
    description:
      "Investigate the payment processor outage affecting checkouts.",
    onDismiss: action("alert-dismissed"),
  },
};

export const Compact: Story = {
  args: {
    tone: "warning",
    compact: true,
    title: "Heads up",
    description: "Limited checkout capacity for the next 30 minutes.",
  },
};

export default meta;
