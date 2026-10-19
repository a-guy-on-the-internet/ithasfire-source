"use client";

import { YStack } from "tamagui";

import {
  Button,
  Modal,
  Radio,
  RadioGroupField,
  Spinner,
  Text,
} from "@th/ui";

import type { InviteTranslate } from "./event-invite-helpers";

/** Keep = action RESET; remove = action RESET_AND_REMOVE. */
export type SharedInviteResetChoice = "keep" | "remove";

export type SharedInviteResetDialogProps = {
  open: boolean;
  value: SharedInviteResetChoice;
  /** Busy through the whole reset round trip. */
  running: boolean;
  t: InviteTranslate;
  onChange: (choice: SharedInviteResetChoice) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * "Reset invite link?" (invite opt-out board, decision 3, option B, owner
 * pick 2026-10-06): one Reset button on the panel, and this dialog asks
 * whether the people the old link let in stay. Built on the
 * SeriesEditScopeDialog pattern (Modal + RadioGroupField + Radio with
 * descriptions). "Keep" is preselected; the confirm button names what will
 * happen: primary "Reset link" for keep, danger "Reset and remove" for
 * remove. The Modal returns focus to the Reset button when it closes.
 */
export function SharedInviteResetDialog({
  open,
  value,
  running,
  t,
  onChange,
  onCancel,
  onConfirm,
}: SharedInviteResetDialogProps) {
  const remove = value === "remove";
  const title = t("admin.ginLinkResetTitle");

  return (
    <Modal open={open} onClose={running ? () => {} : onCancel}>
      <Modal.Panel width={480} data-testid="invite-link-reset-dialog">
        {/* No X while running: closing mid-flight would hide a failure. */}
        <Modal.Header title={title} onClose={running ? undefined : onCancel} />
        <Modal.Body>
          <YStack gap="$3">
            <Text style={{ fontSize: 14 }}>{t("admin.ginLinkResetBody")}</Text>
            <RadioGroupField
              value={value}
              onValueChange={(next: string) =>
                onChange(next === "remove" ? "remove" : "keep")
              }
              aria-label={title}
            >
              <YStack gap="$3">
                <Radio
                  value="keep"
                  testIdBase="invite-link-reset-keep"
                  disabled={running}
                  label={t("admin.ginLinkResetKeepLabel")}
                  description={t("admin.ginLinkResetKeepDesc")}
                />
                <Radio
                  value="remove"
                  testIdBase="invite-link-reset-remove"
                  disabled={running}
                  label={t("admin.ginLinkResetRemoveLabel")}
                  description={t("admin.ginLinkResetRemoveDesc")}
                />
              </YStack>
            </RadioGroupField>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            size="$3"
            onPress={onCancel}
            disabled={running}
            data-testid="invite-link-reset-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant={remove ? "destructive" : "primary"}
            size="$3"
            onPress={onConfirm}
            disabled={running}
            aria-busy={running || undefined}
            data-testid="invite-link-reset-confirm"
            data-tone={remove ? "danger" : "primary"}
          >
            {running && (
              <Spinner
                width={14}
                height={14}
                borderWidth={2}
                style={{ marginRight: 6 }}
              />
            )}
            {remove
              ? t(
                  running
                    ? "admin.ginLinkResetRemoving"
                    : "admin.ginLinkResetRemoveConfirm",
                )
              : t(running ? "admin.ginLinkResetting" : "admin.ginLinkReset")}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

SharedInviteResetDialog.displayName = "SharedInviteResetDialog";
