import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { useCallback, useEffect, useRef } from "react";
import { Separator, XStack, YStack } from "tamagui";

import {
  NotificationAlert,
  type NotificationAlertProps,
} from "./NotificationAlert";
import { NotificationProvider } from "./NotificationProvider";
import { useNotify } from "./useNotify";
import { Button } from "../forms/Button";
import { Text } from "../typography/Text";

const meta: Meta<typeof NotificationAlert> = {
  title: "Feedback/Notifications/Alerts",
  component: NotificationAlert,
  args: {
    gap: "$3",
    maxWidth: 480,
  } satisfies Partial<NotificationAlertProps>,
  parameters: {
    layout: "padded",
    controls: {
      exclude: ["renderContainer"],
    },
  },
  argTypes: {
    renderContainer: { control: false },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const AlertsPlayground = (props: NotificationAlertProps) => {
  const { alert, removeAlert, state } = useNotify();
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;
    alert.info({
      title: "New payout available",
      message: "Yesterday's sales cleared—funds are ready to transfer.",
    });
    alert.warning({
      title: "Stripe webhook pending",
      message:
        "We haven't heard from Stripe in 15 minutes. Check the status page.",
    });
  }, [alert]);

  const pushSuccess = useCallback(() => {
    alert.success({
      title: "Buyer confirmed arrival",
      message: "We'll release payment after the event closes.",
    });
  }, [alert]);

  const pushDanger = useCallback(() => {
    alert.danger({
      title: "Identity verification required",
      message:
        "Upload a government-issued ID to keep selling high-value tickets.",
      onClose: action("alert-danger-closed"),
    });
  }, [alert]);

  const pushNeutral = useCallback(() => {
    alert.neutral({
      title: "Heads up",
      message: "You can reorder alerts to keep the most important ones on top.",
      dismissible: false,
    });
  }, [alert]);

  const removeFirst = useCallback(() => {
    const [first] = state.alerts;
    if (first) {
      removeAlert(first.id);
    }
  }, [removeAlert, state.alerts]);

  const removeAll = useCallback(() => {
    state.alerts.forEach((current) => removeAlert(current.id));
  }, [removeAlert, state.alerts]);

  return (
    <YStack
      gap="$4"
      width="100%"
      maxWidth={520}
      padding="$4"
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <Text tone="muted" margin={0}>
        Alerts stack inline and complement toasts for persistent messaging. Use
        the buttons below to push different severities and manually remove
        entries.
      </Text>
      <Text variant="bodySmall" tone="muted" margin={0}>
        Drag alerts to reorder them — the list updates instantly.
      </Text>
      <NotificationAlert {...props} />
      <Text variant="bodySmall" tone="muted" margin={0}>
        Current order:{" "}
        {state.alerts.map((alert) => alert.title ?? alert.id).join(" → ") ||
          "none"}
      </Text>
      <Separator />
      <YStack gap="$3">
        <Text weight="bold" margin={0}>
          Push alerts
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" onPress={pushSuccess}>
            Success alert
          </Button>
          <Button size="$3" onPress={pushDanger}>
            Danger alert
          </Button>
          <Button size="$3" variant="outlined" onPress={pushNeutral}>
            Sticky alert
          </Button>
        </XStack>
      </YStack>
      <YStack gap="$3">
        <Text weight="bold" margin={0}>
          Dismiss controls
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" variant="outlined" onPress={removeFirst}>
            Dismiss first alert
          </Button>
          <Button size="$3" variant="outlined" onPress={removeAll}>
            Clear alerts
          </Button>
        </XStack>
      </YStack>
    </YStack>
  );
};

const renderAlertsStory: Story["render"] = (args) => (
  <NotificationProvider>
    <AlertsPlayground {...(args as NotificationAlertProps)} />
  </NotificationProvider>
);

export const Default: Story = {
  render: renderAlertsStory,
};

export const WithTightSpacing: Story = {
  render: renderAlertsStory,
  args: {
    gap: "$2",
  } satisfies Partial<NotificationAlertProps>,
};

export const CustomContainer: Story = {
  render: renderAlertsStory,
  args: {
    renderContainer: (children) => (
      <YStack
        padding="$4"
        borderRadius="$4"
        backgroundColor="$surface"
        borderWidth={2}
        borderColor="$borderColor"
      >
        {children}
      </YStack>
    ),
  } satisfies Partial<NotificationAlertProps>,
  parameters: {
    docs: {
      description: {
        story:
          "Wrap alerts in a custom container for dashboard sidebars or banners.",
      },
    },
  },
};
