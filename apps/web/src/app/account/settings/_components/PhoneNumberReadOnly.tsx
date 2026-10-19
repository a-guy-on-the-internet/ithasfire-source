"use client";

import { XStack, YStack } from "tamagui";
import { Phone, ShieldCheck } from "lucide-react";
import { Text, useTranslations } from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { SectionCard } from "./settings-primitives";

/**
 * The phone number on file, shown read-only while SMS is switched off.
 *
 * With no SMS provider the editable PhoneNumberSection is hidden (nothing can
 * be texted to verify a new number), but a number the person already gave us
 * is still a detail we hold about them, so it stays visible here. Renders
 * nothing when there is no number on file.
 */
export function PhoneNumberReadOnly() {
  const t = useTranslations();
  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user as
    | (NonNullable<typeof sessionQuery.data>["user"] & {
        phoneNumber?: string | null;
        phoneNumberVerified?: boolean | null;
      })
    | undefined;

  const currentNumber = user?.phoneNumber ?? null;
  if (!currentNumber) return null;
  const isVerified = Boolean(user?.phoneNumberVerified);

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Phone size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {t("account.phoneReadOnlyTitle")}
        </Text>
      </XStack>

      <YStack gap="$2">
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Text variant="body" fontFamily="$mono">
            {currentNumber}
          </Text>
          <XStack
            paddingHorizontal="$2"
            paddingVertical="$1"
            borderRadius={0}
            backgroundColor={isVerified ? "$green3" : "$surfaceMuted"}
            alignItems="center"
            gap="$1"
          >
            {isVerified ? (
              <ShieldCheck size={12} color="var(--success, #166534)" />
            ) : null}
            <Text
              variant="bodySmall"
              weight="bold"
              color={isVerified ? "$green10" : "$colorMuted"}
            >
              {isVerified
                ? t("account.phoneReadOnlyVerified")
                : t("account.phoneReadOnlyUnverified")}
            </Text>
          </XStack>
        </XStack>

        <Text variant="caption" tone="muted">
          {t("account.phoneReadOnlySmsOff")}
        </Text>
      </YStack>
    </SectionCard>
  );
}
