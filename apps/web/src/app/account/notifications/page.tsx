"use client";

import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";
import { ArrowLeft, Bell, Settings } from "lucide-react";
import { Text, Button, useTranslations } from "@th/ui";

import { NotificationInboxContainer } from "@/components/notifications/NotificationInboxContainer";

// ─────────────────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  name: "NotificationsPage",
  gap: "$4",
  padding: "$4",
  width: "100%",
  maxWidth: 640,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

// Standard clip pattern (same as HomeLayout's hidden h1).
const SR_ONLY = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  borderWidth: 0,
} as const;

// Ghost icon buttons are 40x34 at size="$2". On narrow viewports and coarse
// pointers grow the hit area to the 44px floor; negative margins hand the extra
// space back so the row's layout does not move (same trick as the
// NotificationItem dismiss button).
const TOUCH_HIT_AREA = {
  minWidth: 44,
  minHeight: 44,
  marginHorizontal: -2,
  marginVertical: -5,
} as const;

// ─────────────────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const router = useRouter();
  const t = useTranslations();

  return (
    <PageContainer>
      {/* Header */}
      <YStack
        gap="$2"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        paddingBottom="$3"
      >
        <XStack alignItems="center" gap="$3">
          <Button
            variant="ghost"
            size="$2"
            $sm={TOUCH_HIT_AREA}
            $pointerCoarse={TOUCH_HIT_AREA}
            onPress={() => router.push("/account")}
            aria-label={String(t("account.notificationsBack"))}
          >
            <ArrowLeft size={16} strokeWidth={2.5} aria-hidden />
          </Button>

          <XStack alignItems="center" gap="$2" flex={1}>
            {/* On narrow viewports the shell h1 already names the page: drop
                the bell and visually hide this title (kept for screen readers). */}
            <YStack $sm={{ display: "none" }}>
              <Bell size={18} color="var(--accent, #E2481D)" />
            </YStack>
            <Text
              variant="h3"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.5}
              $sm={SR_ONLY}
            >
              {String(t("account.notificationsTitle"))}
            </Text>
          </XStack>

          <Button
            variant="ghost"
            size="$2"
            $sm={TOUCH_HIT_AREA}
            $pointerCoarse={TOUCH_HIT_AREA}
            onPress={() => router.push("/account/settings/notifications")}
            aria-label={String(t("account.notificationsSettingsLabel"))}
          >
            <Settings size={16} aria-hidden />
          </Button>
        </XStack>

        <Text
          variant="bodySmall"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          {String(t("account.notificationsSubtitle"))}
        </Text>
      </YStack>

      {/* Full notification inbox */}
      <NotificationInboxContainer />
    </PageContainer>
  );
}
