"use client";

/**
 * SaveApplicationFormTemplateDialog — "Save as template" (spec Phase 4).
 *
 * Snapshots the event's CURRENTLY SAVED application form into the owner's
 * library via `applicationFormTemplates.saveFromEvent`.
 *
 * IMPORTANT, and said out loud in the dialog: the server reads the form from
 * the DATABASE, so unsaved edits in the builder are not included. Anything
 * else would mean two sources of truth for "what is this form", and the
 * organizer would silently template a version that never existed.
 *
 * A TEMPLATE_NAME_TAKEN rejection renders as an inline field error (the
 * SaveTicketTypeTemplateDialog idiom) so the user can rename in place.
 */

import { useState } from "react";
import { nanoid } from "nanoid";
import { YStack } from "tamagui";

import {
  Button,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { EventEditorSheet } from "./EventEditorSheet";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";

export type SaveApplicationFormTemplateDialogProps = {
  owner: TemplateOwnerRef;
  eventId: string;
  /** Questions currently in the builder — shown so the count is not a surprise. */
  questionCount: number;
  onClose: () => void;
};

export function SaveApplicationFormTemplateDialog({
  owner,
  eventId,
  questionCount,
  onClose,
}: SaveApplicationFormTemplateDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const saveMutation = trpc.applicationFormTemplates.saveFromEvent.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saveMutation.isPending) return;

    try {
      const result = await saveMutation.mutateAsync({
        eventId,
        ownerScope: owner.ownerScope,
        ownerId: owner.ownerId,
        name: trimmed,
        description: description.trim() || null,
        clientKey: nanoid(12),
      });
      void utils.applicationFormTemplates.list.invalidate({
        ownerScope: owner.ownerScope,
        ownerId: owner.ownerId,
      });
      toast.success({
        id: "application-template-saved",
        title: t("admin.aftSavedTitle") as string,
        message: t("admin.aftSavedMessage", {
          name: trimmed,
          count: result.questionCount,
        }) as string,
      });
      onClose();
    } catch (error) {
      if (getAppErrorCode(error) === "TEMPLATE_NAME_TAKEN") {
        setNameError(t("admin.aftNameTaken", { name: trimmed }) as string);
        return;
      }
      toast.danger({
        id: "application-template-save-failed",
        title: t("admin.aftSaveFailed") as string,
        message: formatErrorMessage(error, t),
      });
    }
  };

  const isSaving = saveMutation.isPending;

  const footer = (
    <>
      <Button
        variant="ghost"
        size="$3"
        onPress={onClose}
        disabled={isSaving}
        data-testid="application-template-save-cancel"
      >
        {String(t("admin.afCancel"))}
      </Button>
      <Button
        variant="primary"
        size="$3"
        onPress={() => {
          void handleSave();
        }}
        disabled={!name.trim() || isSaving}
        data-testid="application-template-save-submit"
      >
        {isSaving
          ? String(t("admin.aftSaving"))
          : String(t("admin.aftSaveCta"))}
      </Button>
    </>
  );

  return (
    <EventEditorSheet
      open
      onClose={onClose}
      title={String(t("admin.aftSaveDialogTitle"))}
      subtitle={String(t("admin.aftSaveDialogSubtitle"))}
      desktopWidth={520}
      footer={footer}
    >
      <YStack gap={16} data-testid="application-template-save-dialog">
        <YStack gap={4}>
          <Text
            variant="caption"
            tone="muted"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.aftNameLabel"))}
          </Text>
          <TextInput
            value={name}
            onChangeText={(v: string) => {
              setName(v);
              if (nameError) setNameError(null);
            }}
            placeholder={t("admin.aftNamePlaceholder") as string}
            maxLength={80}
            fullWidth
            autoFocus
            onSubmitEditing={() => {
              void handleSave();
            }}
            returnKeyType="done"
            testId="application-template-name"
          />
          {nameError ? (
            <Text
              variant="caption"
              tone="error"
              role="alert"
              data-testid="application-template-name-error"
            >
              {nameError}
            </Text>
          ) : null}
        </YStack>

        <YStack gap={4}>
          <Text
            variant="caption"
            tone="muted"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.aftDescriptionLabel"))}
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t("admin.aftDescriptionPlaceholder") as string}
            maxLength={500}
            fullWidth
            testId="application-template-description"
          />
        </YStack>

        {/* The "unsaved edits are not included" warning — see the file header. */}
        <Text
          variant="caption"
          tone="muted"
          data-testid="application-template-save-note"
        >
          {String(t("admin.aftSaveFromSavedNote", { count: questionCount }))}
        </Text>
      </YStack>
    </EventEditorSheet>
  );
}

export default SaveApplicationFormTemplateDialog;
