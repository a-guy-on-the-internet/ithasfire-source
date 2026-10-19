"use client";

import { useEffect } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { CardSurface, Text, useTranslations } from "@th/ui";

/**
 * Legacy redirect stub.
 *
 * Email verification migrated from a clickable link to a 6-digit OTP that
 * the user types into the verify-email card on sign-up. Any in-flight
 * link-style emails (sent in the brief window before the deploy that
 * removed the link template) land here. We bounce them home with a brief
 * explainer; the user can request a fresh OTP from the verify-email card
 * when they next sign in / sign up.
 *
 * TODO: Remove this route after one release cycle once no link-style
 * emails can still be in transit.
 */
const VerifyEmailPage = () => {
  const router = useRouter();
  const t = useTranslations();

  useEffect(() => {
    const id = setTimeout(() => router.replace("/"), 3_000);
    return () => clearTimeout(id);
  }, [router]);

  return (
    <YStack
      flex={1}
      minHeight="100vh"
      alignItems="center"
      justifyContent="center"
      padding="$6"
      backgroundColor="$background"
    >
      <CardSurface width="100%" maxWidth={520} padding="$6" gap="$3">
        <Text
          variant="h4"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          {String(t("auth.verifyTitle"))}
        </Text>
        <Text variant="body" color="$colorMuted">
          {String(t("auth.verifyLegacyRedirect"))}
        </Text>
      </CardSurface>
    </YStack>
  );
};

export default VerifyEmailPage;
