"use client";

import { useState, useCallback } from "react";
import { YStack, XStack } from "tamagui";
import { AlertCircle, Clock, ArrowUpRight } from "lucide-react";
import {
  Button,
  Modal,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatQuotaValue, isStorageKind } from "@/lib/format";
import type { QuotaExceededMeta } from "@/lib/quota-error";

// ─────────────────────────────────────────────────────────────────────────────
// Kind → translation key
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABEL_KEYS: Record<string, string> = {
  ORGS_OWNED: "admin.pqKindOrgsOwned",
  ORGS_JOINED: "admin.pqKindOrgsJoined",
  STORAGE_BYTES_ORG: "admin.pqKindStorageBytesOrg",
  STORAGE_BYTES_HUMAN: "admin.pqKindStorageBytesHuman",
  STORAGE_BYTES_PLACE: "admin.pqKindStorageBytesPlace",
  EVENTS_PER_ORG: "admin.pqKindEventsPerOrg",
  MEMBERS_PER_ORG: "admin.pqKindMembersPerOrg",
  ANNOUNCEMENTS_PER_DAY: "admin.pqKindAnnouncementsPerDay",
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export interface QuotaExceededDialogProps {
  open: boolean;
  onClose: () => void;
  meta: QuotaExceededMeta | null;
}

export function QuotaExceededDialog({
  open,
  onClose,
  meta,
}: QuotaExceededDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [reason, setReason] = useState("");
  const [requestedLimitRaw, setRequestedLimitRaw] = useState("");

  const requestMutation = trpc.quotas.requestExpansion.useMutation({
    onSuccess: () => {
      toast.success(String(t("admin.quotaRequestSuccess")));
      setReason("");
      setRequestedLimitRaw("");
      onClose();
    },
    onError: (err) => {
      toast.danger(err.message ?? String(t("admin.quotaRequestError")));
    },
  });

  const handleSubmit = useCallback(() => {
    if (!meta) return;
    const requestedLimitValue = requestedLimitRaw.trim();
    if (!requestedLimitValue || !reason.trim()) return;

    requestMutation.mutate({
      subjectType: meta.subjectType as any,
      subjectId: meta.subjectId,
      kind: meta.kind as any,
      requestedLimitValue,
      reason: reason.trim(),
    });
  }, [meta, requestedLimitRaw, reason, requestMutation]);

  const handleClose = useCallback(() => {
    if (requestMutation.isPending) return;
    setReason("");
    setRequestedLimitRaw("");
    onClose();
  }, [requestMutation.isPending, onClose]);

  if (!meta) return null;

  const kindLabel = KIND_LABEL_KEYS[meta.kind]
    ? String(t(KIND_LABEL_KEYS[meta.kind]!))
    : meta.kind;
  const currentLimit = formatQuotaValue(meta.kind, meta.limitValue);
  const currentUsage = formatQuotaValue(meta.kind, meta.currentUsage);
  const isStorage = isStorageKind(meta.kind);
  // A place's quota (images community moderators add to an unowned place's
  // page) has nobody to ask for more on its behalf: no expansion request.
  const isPlace = meta.subjectType === "PLACE";
  const canRequestExpansion = !isPlace && !meta.hasPendingExpansionRequest;

  const canSubmit =
    reason.trim().length >= 10 &&
    requestedLimitRaw.trim().length > 0 &&
    !requestMutation.isPending;

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("admin.quotaExceededTitle"))}
          onClose={handleClose}
        />
        <Modal.Body>
          <YStack gap="$4">
            {/* Summary */}
            <XStack gap="$3" alignItems="flex-start">
              <AlertCircle size={20} color="var(--danger)" />
              <YStack gap="$1" flex={1}>
                <Text variant="body">
                  {String(
                    t(
                      isPlace
                        ? "admin.quotaExceededPlaceStorage"
                        : "admin.quotaExceededBody",
                    ),
                  )}
                </Text>
                <XStack gap="$4" paddingTop="$2">
                  <YStack>
                    <Text variant="caption" tone="muted">
                      Limit
                    </Text>
                    <Text variant="body" weight="bold">
                      {currentLimit}
                    </Text>
                  </YStack>
                  <YStack>
                    <Text variant="caption" tone="muted">
                      Usage
                    </Text>
                    <Text variant="body" weight="bold">
                      {currentUsage}
                    </Text>
                  </YStack>
                  <YStack>
                    <Text variant="caption" tone="muted">
                      Resource
                    </Text>
                    <Text variant="body" weight="bold">
                      {kindLabel}
                    </Text>
                  </YStack>
                </XStack>
              </YStack>
            </XStack>

            {/* Already-pending notice */}
            {isPlace ? null : meta.hasPendingExpansionRequest ? (
              <XStack
                gap="$2"
                alignItems="center"
                padding="$3"
                borderRadius={0}
                backgroundColor="$yellow3"
              >
                <Clock size={16} color="var(--warning)" />
                <Text variant="bodySmall" color="$yellow11">
                  {String(t("admin.quotaExceededPending"))}
                </Text>
              </XStack>
            ) : (
              /* Expansion request form */
              <YStack
                gap="$3"
                paddingTop="$2"
                borderTopWidth={2}
                borderTopColor="$borderColor"
              >
                <XStack gap="$2" alignItems="center">
                  <ArrowUpRight size={16} />
                  <Text variant="subtitle" weight="bold">
                    {String(t("admin.quotaRequestExpansion"))}
                  </Text>
                </XStack>

                <YStack gap="$1">
                  <Text variant="label">
                    {String(t("admin.quotaRequestNewLimit"))}
                  </Text>
                  <TextInput
                    value={requestedLimitRaw}
                    onChangeText={setRequestedLimitRaw}
                    placeholder={
                      isStorage ? "e.g. 2147483648 (2 GiB in bytes)" : "e.g. 10"
                    }
                    fullWidth
                    testId="quota-request-limit-input"
                  />
                </YStack>

                <YStack gap="$1">
                  <Text variant="label">
                    {String(t("admin.quotaRequestReasonLabel"))}
                  </Text>
                  <TextInput
                    value={reason}
                    onChangeText={setReason}
                    placeholder={String(
                      t("admin.quotaRequestReasonPlaceholder"),
                    )}
                    fullWidth
                    multiline
                    numberOfLines={3}
                    maxLength={1000}
                    testId="quota-request-reason-input"
                  />
                </YStack>
              </YStack>
            )}
          </YStack>
        </Modal.Body>

        {canRequestExpansion && (
          <Modal.Footer>
            <Button
              variant="ghost"
              onPress={handleClose}
              disabled={requestMutation.isPending}
            >
              {String(t("admin.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {requestMutation.isPending
                ? "Submitting..."
                : String(t("admin.quotaRequestSubmit"))}
            </Button>
          </Modal.Footer>
        )}
      </Modal.Panel>
    </Modal>
  );
}
