"use client";

import type { ReactNode } from "react";
import { Modal, Button, Text } from "@th/ui";
import { AlertTriangle } from "lucide-react";
import { XStack, YStack } from "tamagui";

export interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" renders the confirm button in red. */
  tone?: "default" | "danger";
  loading?: boolean;
  /** Label shown while loading. Defaults to "Processing...". */
  loadingLabel?: string;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  loadingLabel = "Processing...",
}: ConfirmDialogProps) {
  const isDanger = tone === "danger";

  return (
    <Modal open={open} onClose={onCancel}>
      <Modal.Panel width={440}>
        <Modal.Header title={title} onClose={onCancel} />
        <Modal.Body>
          <XStack gap="$3" alignItems="flex-start">
            {isDanger && (
              <YStack
                width={36}
                height={36}
                borderRadius={18}
                // v2 accent tint (#E2481D at 15%), matching the icon below; was the pre-v2
                // #FF5721 (255,87,33) — an off-palette rgba that slips both colour gates.
                backgroundColor="rgba(226,72,29,0.15)"
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
              >
                <AlertTriangle
                  size={18}
                  color="var(--brandSecondary, #E2481D)"
                />
              </YStack>
            )}
            <YStack flex={1} gap="$2">
              {typeof description === "string" ? (
                <Text variant="body" color="$colorMuted">
                  {description}
                </Text>
              ) : (
                description
              )}
            </YStack>
          </XStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            size="$3"
            onPress={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={isDanger ? "destructive" : "primary"}
            size="$3"
            onPress={onConfirm}
            disabled={loading}
          >
            {loading ? loadingLabel : confirmLabel}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

ConfirmDialog.displayName = "ConfirmDialog";
