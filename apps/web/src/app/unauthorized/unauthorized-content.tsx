"use client";

import { YStack } from "tamagui";
import { CardSurface, Text, useTranslations } from "@th/ui";
import { UnauthorizedActions } from "./unauthorized-actions";

export function UnauthorizedContent() {
  const t = useTranslations();

  return (
    <YStack
      minHeight="100vh"
      alignItems="center"
      justifyContent="center"
      padding="$6"
      backgroundColor="$background"
    >
      <CardSurface
        width="100%"
        maxWidth={520}
        borderColor="$borderColor"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
        padding="$5"
        gap="$3"
      >
        <Text
          variant="h3"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {String(t("auth.unauthorizedTitle"))}
        </Text>
        <Text
          variant="body"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          {String(t("auth.unauthorizedMessage"))}
        </Text>
        <UnauthorizedActions />
      </CardSurface>
    </YStack>
  );
}
