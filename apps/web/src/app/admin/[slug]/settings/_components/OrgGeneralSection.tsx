"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  FormErrorBanner,
  LabeledTextInput,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";

import { OrgSaveBar, SectionHeading } from "./org-settings-primitives";

/**
 * "General" — the group's name, and nothing else.
 *
 * DIRTY STATE: this route owns its own local state and its own `updateOrg`
 * call, and the call carries ONLY `name`. `updateOrgInputSchemaBase` marks
 * every field optional (and refuses an all-empty patch), so a partial update is
 * the contract, not a workaround. That is the whole point of the per-route
 * split: before, one Save submitted `name` + `contactEmail` + `physicalAddress`
 * together, so a stale value in a field the user never opened could ride along.
 * Now Contact's fields are not in this component's scope at all — they cannot
 * be submitted from here even by mistake.
 *
 * `orgs.getOrg` is queried here rather than threaded down from the view: it is
 * the same react-query key the view (and every sibling section) uses, so the
 * cache serves it and no extra round-trip happens.
 */
export function OrgGeneralSection({
  orgId,
  canEdit,
}: {
  orgId: string;
  canEdit: boolean;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const { formError, setError, clearAll } = useFormErrors();

  const orgQuery = trpc.orgs.getOrg.useQuery({ orgId }, { enabled: !!orgId });

  const [name, setName] = useState("");
  useEffect(() => {
    if (orgQuery.data) setName(orgQuery.data.name);
  }, [orgQuery.data]);

  const updateMutation = trpc.orgs.updateOrg.useMutation({
    onSuccess: () => {
      void utils.orgs.getOrg.invalidate({ orgId });
      toast.success({
        id: "org-settings-saved",
        title: String(t("admin.settingsSaved")),
      });
    },
    onError: (error) => setError(error),
  });

  const hasChanges = useMemo(
    () => Boolean(orgQuery.data) && name.trim() !== orgQuery.data?.name,
    [orgQuery.data, name],
  );

  const handleSave = useCallback(() => {
    if (!orgQuery.data || !hasChanges) return;
    clearAll();
    updateMutation.mutate({ orgId, name: name.trim() });
  }, [orgQuery.data, hasChanges, clearAll, updateMutation, orgId, name]);

  if (orgQuery.isLoading) {
    return (
      <YStack gap="$4">
        <SectionHeading title={String(t("admin.settingsGeneral"))} />
        <XStack gap="$2" alignItems="center">
          <Spinner size="sm" />
          <Text variant="caption" tone="muted">
            {String(t("admin.loadingSettings"))}
          </Text>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$4">
      <SectionHeading title={String(t("admin.settingsGeneral"))} />

      <FormErrorBanner message={formError} onDismiss={clearAll} />

      <LabeledTextInput
        label={String(t("admin.orgNameLabel"))}
        name="orgName"
        value={name}
        onChangeText={setName}
        placeholder={String(t("admin.orgNamePlaceholder"))}
        helperText={String(t("admin.orgNameHelp"))}
        editable={canEdit}
        testId="org-settings-name"
      />

      {canEdit && (
        <OrgSaveBar
          hasChanges={hasChanges}
          isPending={updateMutation.isPending}
          onSave={handleSave}
        />
      )}
    </YStack>
  );
}
