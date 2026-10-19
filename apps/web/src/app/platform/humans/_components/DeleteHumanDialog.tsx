"use client";

import { useCallback, useState } from "react";
import { YStack } from "tamagui";
import {
  Button,
  Modal,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Trash2 } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DeleteHumanDialogProps {
  open: boolean;
  onClose: () => void;
  humanId: string;
  humanEmail: string;
  humanName: string;
  onDeleted: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function DeleteHumanDialog({
  open,
  onClose,
  humanId,
  humanEmail,
  humanName,
  onDeleted,
}: DeleteHumanDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [confirmPhrase, setConfirmPhrase] = useState("");

  const deleteMut = trpc.platform.deleteHuman.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      utils.platform.listHumans.invalidate();
      onDeleted();
    },
  });

  const isMatch =
    confirmPhrase.trim().toLowerCase() === humanEmail.toLowerCase();

  const handleDelete = useCallback(async () => {
    if (!isMatch) return;
    try {
      await deleteMut.mutateAsync({
        humanId,
        confirmationPhrase: confirmPhrase.trim(),
      });
      toast.success({
        title: String(t("admin.phHumanDeleted")),
      });
      setConfirmPhrase("");
      onClose();
    } catch (err) {
      toast.danger({
        title: String(t("admin.phDeleteFailed")),
        message: formatErrorMessage(err, t),
      });
    }
  }, [isMatch, confirmPhrase, humanId, deleteMut, toast, t, onClose]);

  const handleClose = useCallback(() => {
    if (deleteMut.isPending) return;
    setConfirmPhrase("");
    onClose();
  }, [deleteMut.isPending, onClose]);

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("admin.phDeleteHumanTitle"))}
          onClose={handleClose}
        />
        <Modal.Body>
          <YStack gap="$4">
            <Text variant="body">
              {String(t("admin.phDeleteWarning", { name: humanName }))}
            </Text>

            <YStack
              padding="$3"
              borderWidth={2}
              borderColor="$red8"
              borderRadius={0}
              backgroundColor="$red2"
              gap="$2"
            >
              <Text variant="bodySmall" weight="bold" color="$red11">
                {String(t("admin.phDeleteCascadeWarning"))}
              </Text>
              <Text variant="bodySmall" color="$red11">
                {String(t("admin.phDeleteCascadeDetail"))}
              </Text>
            </YStack>

            <YStack gap="$2">
              <Text variant="label">
                {String(
                  t("admin.phDeleteConfirmLabel", {
                    email: humanEmail,
                  }),
                )}
              </Text>
              <TextInput
                value={confirmPhrase}
                onChangeText={(v) => setConfirmPhrase(v)}
                placeholder={humanEmail}
                autoFocus
                fullWidth
                testId="delete-human-confirm-input"
              />
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="ghost"
            onPress={handleClose}
            disabled={deleteMut.isPending}
          >
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="destructive"
            onPress={handleDelete}
            disabled={!isMatch || deleteMut.isPending}
          >
            <Trash2 size={14} />
            {deleteMut.isPending
              ? String(t("admin.phDeleting"))
              : String(t("admin.phConfirmDelete"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
