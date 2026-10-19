"use client";

/**
 * ApplicationTemplatePickerDialog — "Start from a template" (spec Phase 4).
 *
 * Lists the platform starter catalogue and the owner's own library, and
 * applies the chosen one to the event through
 * `applicationFormTemplates.applyToEvent` (fork-on-use: the server copies the
 * intro + question rows onto the event's form; there is no live link back).
 *
 * The server APPENDS the template's questions after any that already exist,
 * and REFUSES outright once the event has submissions
 * (APPLICATION_SUBMISSIONS_EXIST) — the dialog surfaces that refusal as its
 * own sentence rather than a generic failure toast, because it is the one
 * outcome the organizer cannot fix by retrying.
 *
 * Rows behave as a radiogroup (keyboard-selectable), matching
 * ApplyTicketTypeTemplateDialog.
 */

import { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { XStack, YStack } from "tamagui";

import { Button, Text, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { PlatformTemplateTag } from "@/components/volunteering/PlatformTemplateTag";
import { EventEditorSheet } from "./EventEditorSheet";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";

export type ApplicationTemplatePickerDialogProps = {
  owner: TemplateOwnerRef;
  eventId: string;
  onApplied: () => void;
  onClose: () => void;
};

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  isPlatform: boolean;
  questions: Array<{ label: string; isRequired: boolean }>;
};

export function ApplicationTemplatePickerDialog({
  owner,
  eventId,
  onApplied,
  onClose,
}: ApplicationTemplatePickerDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  const templatesQuery = trpc.applicationFormTemplates.list.useQuery(
    { ownerScope: owner.ownerScope, ownerId: owner.ownerId },
    { staleTime: 30_000 },
  );

  const applyMutation = trpc.applicationFormTemplates.applyToEvent.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const platform: TemplateRow[] = useMemo(
    () => templatesQuery.data?.platform ?? [],
    [templatesQuery.data?.platform],
  );
  const own: TemplateRow[] = useMemo(
    () => templatesQuery.data?.items ?? [],
    [templatesQuery.data?.items],
  );

  const handleApply = async () => {
    if (!selectedId || applyMutation.isPending) return;
    setBlockedReason(null);
    try {
      const result = await applyMutation.mutateAsync({
        eventId,
        templateId: selectedId,
        clientKey: nanoid(12),
      });
      toast.success({
        id: "application-template-applied",
        title: t("admin.aftAppliedTitle") as string,
        message: t("admin.aftAppliedMessage", {
          count: result.created.length,
        }) as string,
      });
      onApplied();
    } catch (error) {
      const code = getAppErrorCode(error);
      if (code === "APPLICATION_SUBMISSIONS_EXIST") {
        // Inline and permanent-sounding: retrying will not help, and the
        // organizer needs to know WHY (people have already applied).
        setBlockedReason(t("admin.aftBlockedBySubmissions") as string);
        return;
      }
      toast.danger({
        id: "application-template-apply-failed",
        title: t("admin.aftApplyFailed") as string,
        message: formatErrorMessage(error, t),
      });
    }
  };

  const renderRow = (template: TemplateRow) => {
    const selected = selectedId === template.id;
    return (
      <XStack
        key={template.id}
        role="radio"
        aria-checked={selected}
        tabIndex={0}
        cursor="pointer"
        gap={12}
        padding={12}
        borderWidth={2}
        borderRadius={0}
        borderColor={selected ? "$color" : "$borderColor"}
        backgroundColor={selected ? "$surfaceMuted" : "$surface"}
        hoverStyle={{ borderColor: "$borderColorHover" }}
        onPress={() => setSelectedId(template.id)}
        data-testid={`application-template-row-${template.id}`}
      >
        <YStack flex={1} gap={4} minWidth={0}>
          <XStack gap={8} alignItems="center" flexWrap="wrap">
            <Text variant="bodySmall" weight="bold" color="$color">
              {template.name}
            </Text>
            {template.isPlatform ? <PlatformTemplateTag /> : null}
          </XStack>
          {template.description ? (
            <Text variant="caption" tone="muted">
              {template.description}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted">
            {String(
              t("admin.aftQuestionCount", {
                count: template.questions.length,
              }),
            )}
          </Text>
        </YStack>
      </XStack>
    );
  };

  const isEmpty =
    !templatesQuery.isLoading && platform.length === 0 && own.length === 0;

  const footer = (
    <>
      <Button
        variant="ghost"
        size="$3"
        onPress={onClose}
        disabled={applyMutation.isPending}
        data-testid="application-template-picker-cancel"
      >
        {String(t("admin.afCancel"))}
      </Button>
      <Button
        variant="primary"
        size="$3"
        onPress={() => {
          void handleApply();
        }}
        disabled={!selectedId || applyMutation.isPending}
        data-testid="application-template-picker-apply"
      >
        {applyMutation.isPending
          ? String(t("admin.aftApplying"))
          : String(t("admin.aftApplyCta"))}
      </Button>
    </>
  );

  return (
    <EventEditorSheet
      open
      onClose={onClose}
      title={String(t("admin.aftPickerTitle"))}
      subtitle={String(t("admin.aftPickerSubtitle"))}
      desktopWidth={560}
      footer={footer}
    >
      <YStack
        gap={16}
        role="radiogroup"
        aria-label={String(t("admin.aftPickerTitle"))}
        data-testid="application-template-picker"
      >
        {blockedReason ? (
          <Text
            variant="caption"
            tone="error"
            role="alert"
            data-testid="application-template-blocked"
          >
            {blockedReason}
          </Text>
        ) : null}

        {templatesQuery.isLoading ? (
          <Text tone="muted">{String(t("admin.afLoading"))}</Text>
        ) : null}

        {isEmpty ? (
          <Text tone="muted" data-testid="application-template-picker-empty">
            {String(t("admin.aftPickerEmpty"))}
          </Text>
        ) : null}

        {platform.length > 0 ? (
          <YStack gap={8}>
            <Text variant="overline" tone="muted">
              {String(t("admin.aftPlatformHeading"))}
            </Text>
            {platform.map(renderRow)}
          </YStack>
        ) : null}

        {own.length > 0 ? (
          <YStack gap={8}>
            <Text variant="overline" tone="muted">
              {String(t("admin.aftOwnHeading"))}
            </Text>
            {own.map(renderRow)}
          </YStack>
        ) : null}

        <Text variant="caption" tone="muted">
          {String(t("admin.aftAppendNote"))}
        </Text>
      </YStack>
    </EventEditorSheet>
  );
}

export default ApplicationTemplatePickerDialog;
