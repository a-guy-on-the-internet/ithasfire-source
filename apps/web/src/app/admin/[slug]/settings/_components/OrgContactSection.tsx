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
 * "Contact" — reply-to email and the CAN-SPAM mailing address.
 *
 * DIRTY STATE: see the note on `OrgGeneralSection`. This route's Save sends
 * only the contact fields, and only the ones that actually changed — so
 * clearing just the address never re-submits a stale email, and the group's
 * NAME is not reachable from this component at all.
 */
export function OrgContactSection({
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

  const [contactEmail, setContactEmail] = useState("");
  const [physicalAddress, setPhysicalAddress] = useState("");
  useEffect(() => {
    if (orgQuery.data) {
      setContactEmail(orgQuery.data.contactEmail ?? "");
      setPhysicalAddress(orgQuery.data.physicalAddress ?? "");
    }
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

  /** Only the fields that differ from the server copy. */
  const changes = useMemo(() => {
    const original = orgQuery.data;
    if (!original) return null;
    const patch: { contactEmail?: string | null; physicalAddress?: string | null } =
      {};
    if ((contactEmail || null) !== (original.contactEmail ?? null)) {
      patch.contactEmail = contactEmail || null;
    }
    if ((physicalAddress || null) !== (original.physicalAddress ?? null)) {
      patch.physicalAddress = physicalAddress || null;
    }
    return patch;
  }, [orgQuery.data, contactEmail, physicalAddress]);

  const hasChanges = changes !== null && Object.keys(changes).length > 0;

  const handleSave = useCallback(() => {
    if (!changes || Object.keys(changes).length === 0) return;
    clearAll();
    updateMutation.mutate({ orgId, ...changes });
  }, [changes, clearAll, updateMutation, orgId]);

  if (orgQuery.isLoading) {
    return (
      <YStack gap="$4">
        <SectionHeading title={String(t("admin.settingsContact"))} />
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
      <SectionHeading title={String(t("admin.settingsContact"))} />

      <FormErrorBanner message={formError} onDismiss={clearAll} />

      <LabeledTextInput
        label={String(t("admin.contactEmailLabel"))}
        name="contactEmail"
        value={contactEmail}
        onChangeText={setContactEmail}
        placeholder={String(t("admin.contactEmailPlaceholder"))}
        helperText={String(t("admin.contactEmailHelp"))}
        keyboardType="email-address"
        autoCapitalize="none"
        editable={canEdit}
        testId="org-settings-contact-email"
      />

      <LabeledTextInput
        label={String(t("admin.physicalAddressLabel"))}
        name="physicalAddress"
        value={physicalAddress}
        onChangeText={setPhysicalAddress}
        placeholder={String(t("admin.physicalAddressPlaceholder"))}
        helperText={String(t("admin.physicalAddressHelp"))}
        editable={canEdit}
        testId="org-settings-physical-address"
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
