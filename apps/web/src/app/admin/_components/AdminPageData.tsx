"use client";

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { YStack } from "tamagui";
import { Spinner, Text, useTranslations } from "@th/ui";

type AdminPageDataProps = {
  isLoading: boolean;
  isError?: boolean;
  error?: { message?: string | null } | null;
  loadingMessage?: string;
  errorMessage?: string;
  /** Override the default min height of the loading/error placeholder. */
  minHeight?: number;
  children: ReactNode;
};

export function AdminPageData({
  isLoading,
  isError = false,
  error = null,
  loadingMessage,
  errorMessage,
  minHeight = 300,
  children,
}: AdminPageDataProps) {
  const t = useTranslations();

  if (isLoading) {
    return (
      <YStack
        padding="$5"
        gap="$4"
        alignItems="center"
        justifyContent="center"
        minHeight={minHeight}
        data-qa="admin-page-data-loading"
      >
        <Spinner size="lg" />
        <Text variant="body" color="$colorMuted">
          {loadingMessage ?? String(t("common.loading"))}
        </Text>
      </YStack>
    );
  }

  if (isError) {
    return (
      <YStack
        padding="$5"
        gap="$3"
        alignItems="center"
        justifyContent="center"
        minHeight={minHeight}
        data-qa="admin-page-data-error"
      >
        <AlertCircle size={28} color="var(--brandSecondary)" aria-hidden />
        <Text variant="body" weight="bold">
          {errorMessage ?? "Something went wrong"}
        </Text>
        {error?.message ? (
          <Text variant="caption" color="$colorMuted" textAlign="center">
            {error.message}
          </Text>
        ) : null}
      </YStack>
    );
  }

  return <>{children}</>;
}

AdminPageData.displayName = "AdminPageData";
