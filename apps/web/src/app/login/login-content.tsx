"use client";

import { YStack } from "tamagui";

import { Button, NextLinkAnchor, Text, useTranslations } from "@th/ui";

import { LoginCard } from "@/components/auth/LoginCard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export const LoginPageContent = () => {
  const t = useTranslations();

  useDocumentTitle(String(t("auth.loginTitle")));

  return (
    <YStack
      minHeight="100vh"
      alignItems="center"
      justifyContent="center"
      padding="$6"
      backgroundColor="$background"
    >
      <YStack width="100%" maxWidth={960} alignItems="center" gap="$6">
        <YStack
          gap="$2"
          alignItems="center"
          maxWidth={520}
          paddingBottom="$3"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
          width="100%"
        >
          <Text
            variant="h2"
            weight="bold"
            textAlign="center"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("auth.loginTitle"))}
          </Text>
          <Text
            variant="body"
            color="$colorMuted"
            textAlign="center"
            textTransform="uppercase"
            letterSpacing={0.5}
          >
            {String(
              t("auth.loginSubtitle", {
                appTitle: String(t("common.appTitle")),
              }),
            )}
          </Text>
        </YStack>
        {/* No Suspense boundary of its own. It used to have one, for the
          static-route `useSearchParams()` bailout `page.tsx` now prevents —
          and a boundary here still split the card into its own streamed
          segment, painted after the heading, so the column jumped exactly as
          before. Inside the page's single boundary the two arrive together. */}
        <LoginCard />
        <Button variant="outlined" asChild size="$3">
          <NextLinkAnchor href="/">
            {String(t("auth.returnHome"))}
          </NextLinkAnchor>
        </Button>
      </YStack>
    </YStack>
  );
};
