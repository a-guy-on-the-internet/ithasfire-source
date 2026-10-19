"use client";

import { useCallback } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import {
  Button,
  FormErrorBanner,
  Switch,
  Text,
  useTranslations,
} from "@th/ui";
import { Globe } from "lucide-react";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";

import { SectionHeading } from "./org-settings-primitives";

/**
 * "Public page" — the live/hidden switch for the group's EntityPage, plus the
 * way into the page builder.
 *
 * No save bar: the visibility switch commits immediately (it is a single
 * boolean with an optimistic-free `saving` state on the control), so there is
 * no dirty state to lose here and nothing for a Save button to batch.
 */
export function OrgPublicPageSection({
  orgId,
  slug,
  canEdit,
}: {
  orgId: string;
  slug: string;
  canEdit: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const utils = trpc.useUtils();
  const { formError, setError, clearAll } = useFormErrors();

  // `retry: false` so a "no page yet" (NOT_FOUND) resolves quickly to the
  // create-first hint instead of spinning.
  const pageQuery = trpc.entityPages.getMyPage.useQuery(
    { ownerType: "ORGANIZATION", ownerId: orgId },
    { enabled: Boolean(orgId) && canEdit, retry: false },
  );
  const pageExists = Boolean(pageQuery.data);
  const isPagePublic = pageQuery.data?.page.visibility === "PUBLIC";

  const visibilityMutation = trpc.entityPages.updatePage.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyPage.invalidate({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });
    },
    onError: (error) => setError(error),
  });

  const handleTogglePageVisibility = useCallback(
    (next: boolean) => {
      if (!orgId) return;
      clearAll();
      visibilityMutation.mutate({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        visibility: next ? "PUBLIC" : "PRIVATE",
      });
    },
    [orgId, visibilityMutation, clearAll],
  );

  return (
    <YStack gap="$4">
      <SectionHeading
        title={String(t("admin.settingsPublicPage"))}
        description={String(t("admin.settingsPublicPageDescription"))}
      />

      <FormErrorBanner message={formError} onDismiss={clearAll} />

      {canEdit && pageExists && (
        <YStack
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          padding="$4"
          gap="$2"
        >
          <XStack justifyContent="space-between" alignItems="center" gap="$3">
            <Text variant="body" weight="bold" flex={1}>
              {String(t("admin.settingsPublicPageVisible"))}
            </Text>
            <Switch
              checked={isPagePublic}
              onCheckedChange={handleTogglePageVisibility}
              saving={visibilityMutation.isPending}
              aria-label={String(t("admin.settingsPublicPageVisible"))}
              testId="org-settings-page-visible"
            />
          </XStack>
          <Text variant="caption" tone="muted">
            {String(
              isPagePublic
                ? t("admin.settingsPublicPageVisibleHelp")
                : t("admin.settingsPublicPageHiddenHelp"),
            )}
          </Text>
        </YStack>
      )}

      {canEdit && !pageExists && !pageQuery.isLoading && (
        <Text variant="caption" tone="muted">
          {String(t("admin.settingsPublicPageCreateFirst"))}
        </Text>
      )}

      <XStack>
        <Button
          variant="primary"
          onPress={() => router.push(`/admin/${slug}/page`)}
          testID="org-settings-edit-page"
        >
          <Globe size={14} />
          {String(t("admin.editPublicPageButton"))}
        </Button>
      </XStack>
    </YStack>
  );
}
