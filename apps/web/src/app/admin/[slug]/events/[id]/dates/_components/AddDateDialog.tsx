"use client";

import { useEffect, useState } from "react";
import { YStack } from "tamagui";

import { Button, Modal, Text, TextInput, useTranslations } from "@th/ui";

import { FieldLabel, NativeDateTimeInput } from "../../../new/_components/_form-bits";

export type AddDateDialogProps = {
  open: boolean;
  /** IANA timezone of the series — the wall-clock the input is entered in. */
  timezone: string;
  submitting: boolean;
  /** Server/validation error to show inline (dialog stays open). */
  error: string | null;
  onClose: () => void;
  /**
   * `startsAtLocal` is the raw datetime-local value ("YYYY-MM-DDTHH:mm"),
   * interpreted by the caller in the SERIES timezone.
   */
  onSubmit: (startsAtLocal: string, note: string) => void;
};

/**
 * "Add date" — small inline sheet for a manual one-off occurrence
 * (series.addSeriesOccurrence). Native datetime input + optional note.
 */
export function AddDateDialog({
  open,
  timezone,
  submitting,
  error,
  onClose,
  onSubmit,
}: AddDateDialogProps) {
  const t = useTranslations();
  const [startsAtLocal, setStartsAtLocal] = useState("");
  const [note, setNote] = useState("");

  // Reset the fields whenever the dialog reopens.
  useEffect(() => {
    if (open) {
      setStartsAtLocal("");
      setNote("");
    }
  }, [open]);

  const canSubmit = startsAtLocal.length > 0 && !submitting;

  return (
    <Modal open={open} onClose={submitting ? () => {} : onClose}>
      <Modal.Panel width={440}>
        {/* Hide the X while submitting — closing mid-flight would silently
            drop a later failure. Overlay/Esc are guarded the same way. */}
        <Modal.Header
          title={String(t("admin.sdAddDateTitle"))}
          onClose={submitting ? undefined : onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$2">
              <FieldLabel>{String(t("admin.sdAddDateStartLabel"))}</FieldLabel>
              <NativeDateTimeInput
                type="datetime-local"
                value={startsAtLocal}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setStartsAtLocal(e.target.value)
                }
                aria-label={String(t("admin.sdAddDateStartLabel"))}
                data-testid="sd-add-date-start"
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.sdAddDateTimezoneNote", { timezone }))}
              </Text>
            </YStack>
            <YStack gap="$2">
              <FieldLabel>{String(t("admin.sdAddDateNoteLabel"))}</FieldLabel>
              <TextInput
                value={note}
                onChangeText={setNote}
                maxLength={200}
                fullWidth
                containerWidth="100%"
                aria-label={String(t("admin.sdAddDateNoteLabel"))}
                data-testid="sd-add-date-note"
              />
            </YStack>
            <Text variant="caption" tone="muted">
              {String(t("admin.sdAddDateHint"))}
            </Text>
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
            onPress={() => onSubmit(startsAtLocal, note.trim())}
            disabled={!canSubmit}
            data-testid="sd-add-date-submit"
          >
            {String(
              t(submitting ? "common.loading" : "admin.sdAddDateSubmit"),
            )}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

AddDateDialog.displayName = "AddDateDialog";
