import type { Meta, StoryObj } from "@storybook/react";
import { useCallback, useEffect, useRef } from "react";
import { Separator, XStack, YStack } from "tamagui";

import { AlertsSidebar, type AlertsSidebarProps } from "./AlertsSidebar";
import { NotificationProvider } from "./NotificationProvider";
import { useNotify } from "./useNotify";
import { Button } from "../forms/Button";
import { Text } from "../typography/Text";

const meta: Meta<typeof AlertsSidebar> = {
  title: "Feedback/Notifications/Alerts Sidebar",
  component: AlertsSidebar,
  args: {
    showClearAll: true,
  } satisfies Partial<AlertsSidebarProps>,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A bell-triggered slide-out panel that keeps slower-moving alerts visible until the user clears them.",
      },
    },
  },
  argTypes: {
    renderEmptyState: { control: false },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const SidebarPlayground = (props: AlertsSidebarProps) => {
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
    state.alerts.forEach((entry) => removeAlert(entry.id));
  }, [removeAlert, state.alerts]);

  const activeCount = state.alerts.length;

  return (
    <YStack
      flex={1}
      minHeight="100vh"
      padding="$6"
      gap="$5"
      backgroundColor="$surfaceMuted"
    >
      <YStack gap="$3" maxWidth={420}>
        <Text weight="bold" margin={0}>
          Click the bell to reveal the sidebar.
        </Text>
        <Text tone="muted" margin={0}>
          Alerts persist until you dismiss them here, making this a good
          companion to toast notifications.
        </Text>
        <Text variant="bodySmall" tone="muted" margin={0}>
          Drag alerts inside the sidebar to reprioritise them. The updated order
          sticks until you clear items.
        </Text>
      </YStack>

      <AlertsSidebar {...props} />

      <Separator />

      <YStack gap="$3" maxWidth={520}>
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

      <YStack gap="$3" maxWidth={520}>
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
        <Text tone="muted" margin={0}>
          Active alerts: {activeCount} · Current order:{" "}
          {state.alerts.map((alert) => alert.title ?? alert.id).join(" → ") ||
            "none"}
        </Text>
      </YStack>
    </YStack>
  );
};

const renderSidebarStory: Story["render"] = (args) => (
  <NotificationProvider>
    <SidebarPlayground {...(args as AlertsSidebarProps)} />
  </NotificationProvider>
);

export const Default: Story = {
  render: renderSidebarStory,
};

export const WithoutClearAll: Story = {
  render: renderSidebarStory,
  args: {
    showClearAll: false,
  } satisfies Partial<AlertsSidebarProps>,
  parameters: {
    docs: {
      description: {
        story:
          "Hide the clear-all control when alerts should only disappear one-by-one.",
      },
    },
  },
};

const CustomEmptyState = () => (
  <YStack gap="$2" padding="$4" alignItems="center">
    <Text weight="bold" margin={0}>
      No alerts right now
    </Text>
    <Text tone="muted" textAlign="center" margin={0}>
      We'll keep this space warm—fresh alerts slide in instantly when something
      needs attention.
    </Text>
  </YStack>
);

export const WithCustomEmptyState: Story = {
  render: renderSidebarStory,
  args: {
    renderEmptyState: () => <CustomEmptyState />,
  } satisfies Partial<AlertsSidebarProps>,
  parameters: {
    docs: {
      description: {
        story:
          "Provide custom empty-state content to personalise the quiet moments.",
      },
    },
  },
};

export const MobileBottomSheet: Story = {
  render: renderSidebarStory,
  args: {
    defaultOpen: true,
    platformOverride: "ios",
  } satisfies Partial<AlertsSidebarProps>,
  parameters: {
    viewport: {
      defaultViewport: "iphone14",
    },
    docs: {
      description: {
        story:
          "Preview the native bottom-sheet presentation by forcing the iOS platform override and opening the drawer on load.",
      },
    },
  },
};
