"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { UserPlus, UserX } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";

import { volunteerConflictMessageKey } from "./volunteering-helpers";

export type CoordinatorInfo = {
  humanId: string;
  name: string | null;
};

export type CoordinatorPickerProps = {
  groupId: string;
  coordinator: CoordinatorInfo | null;
  onChanged: () => void;
};

/**
 * Assign / replace / clear a group's single coordinator (FR-004). Email is
 * the one input the server needs: an address that resolves to an existing
 * account assigns that Human directly, and an unknown address mints a
 * shadow profile + sends the invite email — so a separate "search humans"
 * control would duplicate what `coordinatorEmail` already does.
 */
export function CoordinatorPicker({
  groupId,
  coordinator,
  onChanged,
}: CoordinatorPickerProps) {
  const t = useTranslations();
  const notify = useNotify();
  const [email, setEmail] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const assignMutation = trpc.volunteer.groups.assignCoordinator.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-coordinator-updated",
        title: String(t("volunteering.coordinatorUpdated")),
      });
      setEmail("");
      setEditing(false);
      setConfirmClear(false);
      onChanged();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-coordinator-update-failed",
        title: String(t("volunteering.coordinatorUpdateFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  const trimmedEmail = email.trim();
  const emailInputId = `coordinator-email-${groupId}`;

  return (
    <YStack gap="$2">
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="label" color="$colorMuted">
          {String(t("volunteering.coordinatorLabel"))}
        </Text>
        {coordinator ? (
          <Text variant="bodySmall" style={{ fontWeight: 600 }}>
            {coordinator.name ??
              String(t("volunteering.coordinatorUnnamed"))}
          </Text>
        ) : (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.coordinatorNone"))}
          </Text>
        )}
        <Button
          variant="ghost"
          size="$2"
          minHeight={44}
          onPress={() => setEditing((v) => !v)}
          aria-expanded={editing}
          data-testid={`volunteer-coordinator-edit-${groupId}`}
        >
          <XStack gap="$2" alignItems="center">
            <UserPlus size={14} />
            <Text variant="bodySmall">
              {String(
                t(
                  coordinator
                    ? "volunteering.coordinatorReplaceCta"
                    : "volunteering.coordinatorAssignCta",
                ),
              )}
            </Text>
          </XStack>
        </Button>
        {coordinator ? (
          <Button
            variant="ghost"
            size="$2"
            minHeight={44}
            disabled={assignMutation.isPending}
            onPress={() => setConfirmClear(true)}
            data-testid={`volunteer-coordinator-clear-${groupId}`}
          >
            <XStack gap="$2" alignItems="center">
              <UserX size={14} />
              <Text variant="bodySmall">
                {String(t("volunteering.coordinatorClearCta"))}
              </Text>
            </XStack>
          </Button>
        ) : null}
      </XStack>

      {editing ? (
        <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
          <YStack gap="$1" flex={1} minWidth={220}>
            <label htmlFor={emailInputId}>
              <Text variant="label" color="$colorMuted">
                {String(t("volunteering.coordinatorEmailLabel"))}
              </Text>
            </label>
            <TextInput
              id={emailInputId}
              value={email}
              onChangeText={setEmail}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={String(
                t("volunteering.coordinatorEmailPlaceholder"),
              )}
              fullWidth
              minHeight={44}
              testId={`volunteer-coordinator-email-${groupId}`}
            />
          </YStack>
          <Button
            variant="primary"
            size="$3"
            minHeight={44}
            disabled={assignMutation.isPending || trimmedEmail.length === 0}
            onPress={() =>
              assignMutation.mutate({ groupId, coordinatorEmail: trimmedEmail })
            }
            data-testid={`volunteer-coordinator-assign-${groupId}`}
          >
            {assignMutation.isPending
              ? String(t("common.loading"))
              : String(t("volunteering.coordinatorAssignCta"))}
          </Button>
        </XStack>
      ) : null}

      {editing ? (
        <Text variant="caption" tone="muted">
          {String(t("volunteering.coordinatorInviteHint"))}
        </Text>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title={String(t("volunteering.coordinatorClearConfirmTitle"))}
        description={String(t("volunteering.coordinatorClearConfirmBody"))}
        confirmLabel={String(t("volunteering.coordinatorClearCta"))}
        cancelLabel={String(t("common.cancel"))}
        loading={assignMutation.isPending}
        onConfirm={() => assignMutation.mutate({ groupId })}
        onCancel={() => setConfirmClear(false)}
      />
    </YStack>
  );
}
