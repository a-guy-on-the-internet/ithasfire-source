"use client";

import { useState } from "react";
import { YStack, XStack } from "tamagui";
import {
  Modal,
  Button,
  TextInput,
  Text,
  useTranslations,
  useNotify,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export interface RoleDialogInitial {
  name: string;
  description: string | null;
  capacity: number | null;
  autoApprove: boolean | null;
}

interface RoleDialogProps {
  mode: "create" | "edit";
  eventId: string;
  roleId?: string;
  initial?: RoleDialogInitial;
  onClose: () => void;
  onSuccess: () => void;
}

export function RoleDialog({
  mode,
  eventId,
  roleId,
  initial,
  onClose,
  onSuccess,
}: RoleDialogProps) {
  const t = useTranslations();
  const notify = useNotify();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [capacity, setCapacity] = useState(
    initial?.capacity != null ? String(initial.capacity) : "",
  );
  // Tri-state: null = inherit the event's default, true = always
  // auto-approve, false = always require manual review. New roles default
  // to "inherit" so an untouched control never silently overrides the
  // event-level default.
  const [autoApprove, setAutoApprove] = useState<boolean | null>(
    initial?.autoApprove ?? null,
  );

  const autoApproveOptions = [
    {
      value: null as boolean | null,
      label: String(t("admin.volunteerRoleFieldAutoApproveInherit")),
      testId: "volunteer-role-auto-approve-inherit",
    },
    {
      value: true as boolean | null,
      label: String(t("admin.volunteerRoleFieldAutoApproveAlways")),
      testId: "volunteer-role-auto-approve-always",
    },
    {
      value: false as boolean | null,
      label: String(t("admin.volunteerRoleFieldAutoApproveNever")),
      testId: "volunteer-role-auto-approve-never",
    },
  ] as const;

  const createMutation = trpc.volunteer.roles.create.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-role-created",
        title: String(t("admin.volunteerRoleCreated")),
      });
      onSuccess();
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-role-save-failed",
        title: String(t("admin.volunteerRoleSaveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const updateMutation = trpc.volunteer.roles.update.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-role-updated",
        title: String(t("admin.volunteerRoleUpdated")),
      });
      onSuccess();
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-role-save-failed",
        title: String(t("admin.volunteerRoleSaveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const parsedCapacity = capacity.trim() === "" ? null : Number(capacity);
    const capacityValue =
      parsedCapacity !== null &&
      Number.isFinite(parsedCapacity) &&
      parsedCapacity >= 1
        ? Math.floor(parsedCapacity)
        : null;
    const trimmedDescription = description.trim();

    if (mode === "create") {
      createMutation.mutate({
        eventId,
        name: trimmedName,
        description: trimmedDescription || null,
        capacity: capacityValue,
        autoApprove,
      });
    } else if (roleId) {
      updateMutation.mutate({
        id: roleId,
        name: trimmedName,
        description: trimmedDescription || null,
        capacity: capacityValue,
        autoApprove,
      });
    }
  };

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={String(
            mode === "create"
              ? t("admin.volunteerRoleDialogCreateTitle")
              : t("admin.volunteerRoleDialogEditTitle"),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerRoleFieldNameLabel"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={String(
                  t("admin.volunteerRoleFieldNamePlaceholder"),
                )}
                maxLength={120}
                fullWidth
                testId="volunteer-role-name"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerRoleFieldDescriptionLabel"))}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder={String(
                  t("admin.volunteerRoleFieldDescriptionPlaceholder"),
                )}
                multiline
                numberOfLines={3}
                maxLength={2000}
                fullWidth
                testId="volunteer-role-description"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerRoleFieldCapacityLabel"))}
              </Text>
              <TextInput
                value={capacity}
                onChangeText={setCapacity}
                placeholder={String(
                  t("admin.volunteerRoleFieldCapacityPlaceholder"),
                )}
                inputMode="numeric"
                fullWidth
                testId="volunteer-role-capacity"
              />
            </YStack>

            <YStack gap="$1" paddingTop="$1">
              <Text variant="label">
                {String(t("admin.volunteerRoleFieldAutoApproveLabel"))}
              </Text>
              <XStack
                borderWidth={2}
                borderColor="$borderColor"
                borderRadius={0}
                overflow="hidden"
                data-testid="volunteer-role-auto-approve-toggle"
              >
                {autoApproveOptions.map((option, index) => {
                  const selected = autoApprove === option.value;
                  return (
                    <XStack key={String(option.value)} flex={1}>
                      {index > 0 ? (
                        <XStack
                          width={1}
                          alignSelf="stretch"
                          backgroundColor="$borderColor"
                        />
                      ) : null}
                      <XStack
                        tag="button"
                        flex={1}
                        minHeight={44}
                        paddingHorizontal="$2"
                        paddingVertical="$2"
                        alignItems="center"
                        justifyContent="center"
                        cursor="pointer"
                        aria-pressed={selected}
                        aria-label={option.label}
                        backgroundColor={selected ? "$accent" : "transparent"}
                        onPress={() => setAutoApprove(option.value)}
                        focusStyle={{
                          outlineWidth: 2,
                          outlineStyle: "solid",
                          outlineColor: "$accent",
                          outlineOffset: 2,
                        }}
                        data-testid={option.testId}
                      >
                        <Text
                          variant="overline"
                          weight={selected ? "semibold" : "regular"}
                          // Solid $accent + $onBrandSecondary matches this dialog's own
                          // SAVE button and clears WCAG AA (5.61:1) — $accentSoft's
                          // translucent bg only cleared 4.05:1 against $accent text,
                          // under the 4.5:1 floor for text this small.
                          color={selected ? "$onBrandSecondary" : "$colorMuted"}
                          style={{
                            textAlign: "center",
                          }}
                        >
                          {option.label}
                        </Text>
                      </XStack>
                    </XStack>
                  );
                })}
              </XStack>
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerRoleFieldAutoApproveHelp"))}
              </Text>
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button variant="ghost" onPress={onClose} disabled={isPending}>
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={isPending || !name.trim()}
            >
              {String(
                mode === "create" ? t("common.create") : t("common.save"),
              )}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
