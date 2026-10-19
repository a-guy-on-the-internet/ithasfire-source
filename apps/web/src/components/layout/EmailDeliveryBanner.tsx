"use client";

import { AlertTriangle } from "lucide-react";
import { XStack, YStack } from "tamagui";
import { Button, NextLinkAnchor, Text, useTranslations } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import {
  SHELL_GUTTER,
  SHELL_GUTTER_MOBILE,
  SHELL_MAX_WIDTH,
} from "@/components/layout/shell-metrics";

type DeliveryStatus = "BOUNCED" | "COMPLAINED";

type SessionUserWithDelivery = {
  email?: string | null;
  emailDeliveryStatus?: string | null;
};

const getDeliveryStatus = (
  value: string | null | undefined,
): DeliveryStatus | null =>
  value === "BOUNCED" || value === "COMPLAINED" ? value : null;

export const EmailDeliveryBanner = () => {
  const t = useTranslations();
  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user as SessionUserWithDelivery | undefined;
  const status = getDeliveryStatus(user?.emailDeliveryStatus);

  if (!status) {
    return null;
  }

  const email = user?.email ?? String(t("account.emailDeliveryUnknownEmail"));
  const titleKey =
    status === "COMPLAINED"
      ? "account.emailDeliveryComplaintTitle"
      : "account.emailDeliveryBouncedTitle";
  const bodyKey =
    status === "COMPLAINED"
      ? "account.emailDeliveryComplaintBody"
      : "account.emailDeliveryBouncedBody";

  return (
    <YStack
      role="status"
      aria-live="polite"
      width="100%"
      backgroundColor="$surface"
      borderTopWidth={2}
      borderBottomWidth={2}
      borderColor="$warning"
      style={{ position: "relative", zIndex: 2 }}
    >
      {/* AppShell renders this band between the navbar and <main>, so it is on
          the shell's shared horizontal grid — a banner inset differently from
          the two bands it sits between reads as a misprint. */}
      <XStack
        width="100%"
        maxWidth={SHELL_MAX_WIDTH}
        alignSelf="center"
        gap="$3"
        alignItems="center"
        paddingHorizontal={SHELL_GUTTER}
        $sm={{ paddingHorizontal: SHELL_GUTTER_MOBILE }}
        paddingVertical="$3"
        flexWrap="wrap"
      >
        {/* Lucide is a plain SVG — it can't resolve a Tamagui $token, so
            feed the warning color through its generated CSS custom prop. */}
        <AlertTriangle size={22} color="var(--warning)" aria-hidden />
        <YStack flex={1} minWidth={240} gap="$1">
          <Text variant="bodySmall" weight="bold" textTransform="uppercase">
            {String(t(titleKey))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t(bodyKey, { email }))}
          </Text>
        </YStack>
        {/* The Email card is its own route now. The old `#email` anchor still
            resolves (the settings index replace-navigates on mount), but link
            straight at the destination — one navigation, no flash. */}
        <NextLinkAnchor href="/account/settings/email">
          <Button tag="span" variant="primary" size="$3">
            {String(t("account.emailDeliveryUpdateCta"))}
          </Button>
        </NextLinkAnchor>
      </XStack>
    </YStack>
  );
};

EmailDeliveryBanner.displayName = "EmailDeliveryBanner";
