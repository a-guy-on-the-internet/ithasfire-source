"use client";

import { memo } from "react";
import { XStack, YStack } from "tamagui";

import {
  Badge,
  Button,
  Modal,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

/**
 * Series reconcile confirmation — published occurrences that already have
 * orders and would be detached by a schedule change. Extracted from
 * EventBuilder (and memoized) so its rows aren't rebuilt on every keystroke.
 */

export type ReconcilePendingItem = {
  occurrenceId: string;
  eventId: string;
  eventTitle: string;
  startsAt: string;
  deferredOrderCount: number;
  capturedOrderCount: number;
};

const SPINNER_GAP = { marginRight: 6 } as const;

export type BuilderReconcileDialogProps = {
  open: boolean;
  pending: ReconcilePendingItem[];
  saving: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

function BuilderReconcileDialogImpl({
  open,
  pending,
  saving,
  onConfirm,
  onDismiss,
}: BuilderReconcileDialogProps) {
  const t = useTranslations();

  return (
    <Modal open={open} onClose={onDismiss}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={t("admin.ebReconcileConfirmTitle") as string}
          onClose={onDismiss}
        />
        <Modal.Body>
          <YStack gap={12}>
            <Text variant="body">
              {String(
                t("admin.ebReconcileConfirmBody", { count: pending.length }),
              )}
            </Text>
            <YStack
              gap={8}
              padding={12}
              backgroundColor="$surfaceMuted"
              maxHeight={240}
              overflow="scroll"
            >
              {pending.map((item) => {
                const totalOrders =
                  item.deferredOrderCount + item.capturedOrderCount;
                return (
                  <XStack
                    key={item.occurrenceId}
                    gap={8}
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <YStack gap={2} flex={1} minWidth={0}>
                      <Text
                        variant="body"
                        weight="bold"
                        overflow="hidden"
                        whiteSpace="nowrap"
                        textOverflow="ellipsis"
                      >
                        {item.eventTitle}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {new Date(item.startsAt).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </Text>
                    </YStack>
                    <Badge tone="warning" size="sm">
                      {
                        t("admin.ebReconcileOrderCount", {
                          count: totalOrders,
                        }) as string
                      }
                    </Badge>
                  </XStack>
                );
              })}
            </YStack>
            <Text variant="caption" tone="muted">
              {String(t("admin.ebReconcileConfirmNote"))}
            </Text>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={onDismiss}>
            {String(t("admin.ebGoBack"))}
          </Button>
          <Button
            variant="secondary"
            onPress={onConfirm}
            disabled={saving}
            data-testid="reconcile-confirm-btn"
          >
            {saving && (
              <Spinner
                width={14}
                height={14}
                borderWidth={2}
                style={SPINNER_GAP}
              />
            )}
            {saving
              ? String(t("admin.ebSaving"))
              : String(
                  t("admin.ebReconcileConfirmAction", {
                    count: pending.length,
                  }),
                )}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

export const BuilderReconcileDialog = memo(BuilderReconcileDialogImpl);

BuilderReconcileDialog.displayName = "BuilderReconcileDialog";
