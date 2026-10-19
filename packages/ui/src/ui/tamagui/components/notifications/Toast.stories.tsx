import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { useCallback } from "react";
import { Separator, XStack, YStack } from "tamagui";

import { NotificationProvider } from "./NotificationProvider";
import { useNotify } from "./useNotify";
import type { NotificationProviderProps } from "./types";
import { Button } from "../forms/Button";
import { Text } from "../typography/Text";

const meta: Meta<typeof NotificationProvider> = {
  title: "Feedback/Notifications/Toast",
  component: NotificationProvider,
  args: {
    position: "top-right",
    maxVisible: 3,
    pauseOnHover: true,
    durationMs: 4000,
  } satisfies Partial<NotificationProviderProps>,
  parameters: {
    layout: "fullscreen",
    controls: {
      exclude: ["children", "renderContainer"],
    },
  },
  argTypes: {
    renderContainer: { control: false },
    children: { control: false },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const ToastControls = () => {
  const { toast, notify, clear } = useNotify();

  const triggerInfo = useCallback(() => {
    toast.info({
      title: "Heads up",
      message: "We saved your draft and will remind the buyer in 24 hours.",
    });
  }, [toast]);

  const triggerSuccess = useCallback(() => {
    toast.success({
      title: "Tickets sent",
      message: "The buyer just got your transfer email.",
      action: {
        label: "View transfer",
        onPress: action("toast-action-view-transfer"),
      },
      intent: "user",
    });
  }, [toast]);

  const triggerWarning = useCallback(() => {
    toast.warning({
      title: "Low inventory",
      message: "Only 4 VIP seats remain for Saturday.",
    });
  }, [toast]);

  const triggerDanger = useCallback(() => {
    toast.danger({
      title: "Transfer failed",
      message:
        "The buyer needs to accept the invite before we can move tickets.",
      intent: "payment",
    });
  }, [toast]);

  const triggerPersistent = useCallback(() => {
    notify({
      title: "Live scoreboard pinned",
      message: "We will keep this toast visible until you close it.",
      variant: "neutral",
      durationMs: Infinity,
    });
  }, [notify]);

  const triggerBurst = useCallback(() => {
    [triggerInfo, triggerSuccess, triggerWarning, triggerDanger].forEach(
      (fire, index) => {
        setTimeout(fire, index * 120);
      },
    );
  }, [triggerDanger, triggerInfo, triggerSuccess, triggerWarning]);

  const handleClearAll = useCallback(() => {
    clear();
  }, [clear]);

  return (
    <YStack
      gap="$4"
      width="100%"
      maxWidth={420}
      padding="$4"
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <Text tone="muted" margin={0}>
        Use the actions below to trigger notifications and preview the toast
        experience. The refreshed frames keep things monochrome while intent
        badges and the accent stripe inject the right amount of color so alerts
        still pop.
      </Text>
      <YStack gap="$3">
        <Text weight="bold" margin={0}>
          Single events
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" onPress={triggerInfo}>
            Info toast
          </Button>
          <Button size="$3" onPress={triggerSuccess}>
            Success toast
          </Button>
          <Button size="$3" onPress={triggerWarning}>
            Warning toast
          </Button>
          <Button size="$3" onPress={triggerDanger}>
            Danger toast
          </Button>
          <Button size="$3" variant="outlined" onPress={triggerPersistent}>
            Persistent toast
          </Button>
        </XStack>
      </YStack>
      <Separator />
      <YStack gap="$3">
        <Text weight="bold" margin={0}>
          Stress test
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" onPress={triggerBurst}>
            Fire queue burst
          </Button>
          <Button size="$3" variant="outlined" onPress={handleClearAll}>
            Clear all toasts
          </Button>
        </XStack>
      </YStack>
    </YStack>
  );
};

const renderToastStory: Story["render"] = (args) => (
  <NotificationProvider {...(args as NotificationProviderProps)}>
    <ToastControls />
  </NotificationProvider>
);

export const TopRight: Story = {
  render: renderToastStory,
};

export const TopCenter: Story = {
  render: renderToastStory,
  args: {
    position: "top-center",
  } satisfies Partial<NotificationProviderProps>,
};

export const TopLeft: Story = {
  render: renderToastStory,
  args: {
    position: "top-left",
  } satisfies Partial<NotificationProviderProps>,
};

export const MiddleRight: Story = {
  render: renderToastStory,
  args: {
    position: "middle-right",
  } satisfies Partial<NotificationProviderProps>,
};

export const MiddleCenter: Story = {
  render: renderToastStory,
  args: {
    position: "middle-center",
  } satisfies Partial<NotificationProviderProps>,
};

export const MiddleLeft: Story = {
  render: renderToastStory,
  args: {
    position: "middle-left",
  } satisfies Partial<NotificationProviderProps>,
};

export const BottomRight: Story = {
  render: renderToastStory,
  args: {
    position: "bottom-right",
  } satisfies Partial<NotificationProviderProps>,
};

export const BottomCenter: Story = {
  render: renderToastStory,
  args: {
    position: "bottom-center",
  } satisfies Partial<NotificationProviderProps>,
};

export const BottomLeft: Story = {
  render: renderToastStory,
  args: {
    position: "bottom-left",
  } satisfies Partial<NotificationProviderProps>,
};

export const SingleVisible: Story = {
  render: renderToastStory,
  args: {
    maxVisible: 1,
  } satisfies Partial<NotificationProviderProps>,
  parameters: {
    docs: {
      description: {
        story:
          "Queue up multiple toasts to see how the provider buffers events when only one is visible at a time.",
      },
    },
  },
};
