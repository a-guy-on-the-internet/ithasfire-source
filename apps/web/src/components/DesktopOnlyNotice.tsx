"use client";

import { ArrowLeft, Monitor } from "lucide-react";
import { YStack } from "tamagui";

import { Button, Text, useTranslations } from "@th/ui";

export interface DesktopOnlyNoticeProps {
  /** Overrides the default title (`admin.desktopOnlyTitle`). */
  title?: string;
  /** Overrides the default body copy (`admin.desktopOnlyBody`). */
  body?: string;
  /** When provided together with `onBack`, renders a back button. */
  backLabel?: string;
  onBack?: () => void;
}

/**
 * Strict-Swiss empty state for desk tools that cannot meaningfully run on a
 * phone (e.g. the seat-map layout designer). Render it INSTEAD of the tool
 * when `useIsMobile()` is true so the heavy canvas never mounts.
 */
export function DesktopOnlyNotice({
  title,
  body,
  backLabel,
  onBack,
}: DesktopOnlyNoticeProps) {
  const t = useTranslations();

  return (
    <YStack
      data-testid="desktop-only-notice"
      alignItems="center"
      justifyContent="center"
      gap="$4"
      padding="$6"
      margin="$4"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      backgroundColor="$surface"
    >
      <YStack
        width={64}
        height={64}
        borderRadius={0}
        backgroundColor="$surfaceMuted"
        alignItems="center"
        justifyContent="center"
      >
        <Monitor size={28} color="var(--colorMuted)" aria-hidden="true" />
      </YStack>

      <YStack gap="$2" alignItems="center">
        <Text
          variant="h4"
          weight="bold"
          textTransform="uppercase"
          textAlign="center"
        >
          {title ?? String(t("admin.desktopOnlyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={360}>
          {body ?? String(t("admin.desktopOnlyBody"))}
        </Text>
      </YStack>

      {onBack && backLabel ? (
        <Button variant="outlined" size="$3" minHeight={44} onPress={onBack}>
          <ArrowLeft size={16} />
          {backLabel}
        </Button>
      ) : null}
    </YStack>
  );
}

DesktopOnlyNotice.displayName = "DesktopOnlyNotice";
