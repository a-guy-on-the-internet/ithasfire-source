"use client";

import { useEffect, useState } from "react";
import { YStack, XStack } from "tamagui";
import { Modal, Button, TextInput, Text, useTranslations } from "@th/ui";

interface RejectSignupDialogProps {
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (notes: string) => void;
  /** Override the dialog title (e.g. batch reject). Defaults to the single-signup title. */
  title?: string;
  /** Override the confirm CTA label. Defaults to the single-signup CTA. */
  confirmLabel?: string;
}

export function RejectSignupDialog({
  open,
  pending,
  onCancel,
  onConfirm,
  title,
  confirmLabel,
}: RejectSignupDialogProps) {
  const t = useTranslations();
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) setNotes("");
  }, [open]);

  return (
    <Modal open={open} onClose={onCancel}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={title ?? String(t("admin.volunteerSignupsRejectDialogTitle"))}
          onClose={onCancel}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerSignupsRejectDialogNoteLabel"))}
              </Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                placeholder={String(
                  t("admin.volunteerSignupsRejectDialogNotePlaceholder"),
                )}
                multiline
                numberOfLines={3}
                maxLength={2000}
                fullWidth
                testId="volunteer-signup-reject-notes"
              />
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button variant="ghost" onPress={onCancel} disabled={pending}>
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={() => onConfirm(notes.trim())}
              disabled={pending}
            >
              {confirmLabel ??
                String(t("admin.volunteerSignupsRejectConfirmCta"))}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
