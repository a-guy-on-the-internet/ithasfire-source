"use client";

import { useEffect, useState } from "react";
import { YStack } from "tamagui";

import { Button, Modal, Text, TextInput, useTranslations } from "@th/ui";

import { FieldLabel } from "../../../new/_components/_form-bits";

export type SkipDateDialogProps = {
  open: boolean;
  /** Formatted mono date label of the occurrence being skipped. */
  dateLabel: string;
  submitting: boolean;
  /** Server error to show inline (dialog stays open). */
  error: string | null;
  onClose: () => void;
  onConfirm: (note: string) => void;
};

/**
 * Small confirm for skipping a planned date, with an optional note that is
 * stored on the occurrence (series.skipOccurrence) and shown on the row.
 */
export function SkipDateDialog({
  open,
  dateLabel,
  submitting,
  error,
  onClose,
  onConfirm,
}: SkipDateDialogProps) {
  const t = useTranslations();
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  return (
    <Modal open={open} onClose={submitting ? () => {} : onClose}>
      <Modal.Panel width={440}>
        {/* Hide the X while submitting — closing mid-flight would silently
            drop a later failure. Overlay/Esc are guarded the same way. */}
        <Modal.Header
          title={String(t("admin.sdSkipTitle"))}
          onClose={submitting ? undefined : onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body" color="$colorMuted">
              {String(t("admin.sdSkipBody", { date: dateLabel }))}
            </Text>
            <YStack gap="$2">
              <FieldLabel>{String(t("admin.sdSkipNoteLabel"))}</FieldLabel>
              <TextInput
                value={note}
                onChangeText={setNote}
                maxLength={200}
                fullWidth
                containerWidth="100%"
                aria-label={String(t("admin.sdSkipNoteLabel"))}
                data-testid="sd-skip-note"
              />
            </YStack>
            {error ? (
              <Text variant="bodySmall" color="$dangerSoft" role="alert">
                {error}
              </Text>
            ) : null}
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            size="$3"
            onPress={onClose}
            disabled={submitting}
          >
            {String(t("common.cancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            onPress={() => onConfirm(note.trim())}
            disabled={submitting}
            data-testid="sd-skip-confirm"
          >
            {String(t(submitting ? "common.loading" : "admin.sdSkipConfirm"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

SkipDateDialog.displayName = "SkipDateDialog";
