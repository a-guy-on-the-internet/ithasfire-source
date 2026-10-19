"use client";

import { useState } from "react";
import { YStack, XStack } from "tamagui";
import { HelpCircle } from "lucide-react";
import {
  Modal,
  Button,
  TextInput,
  Text,
  Tooltip,
  useTranslations,
  useNotify,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { DateTimeLocalInput } from "@/components/forms/DateTimeLocalInput";
import { isoToLocalInput, localInputToIso } from "@/lib/datetime-local";

const NATIVE_DATETIME_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--borderColor)",
  borderRadius: 0,
  backgroundColor: "var(--surface)",
  color: "var(--color)",
  fontFamily: "inherit",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

export interface ShiftDialogInitial {
  label: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number | null;
  notes: string | null;
}

interface ShiftDialogProps {
  mode: "create" | "edit";
  roleId: string;
  shiftId?: string;
  initial?: ShiftDialogInitial;
  onClose: () => void;
  onSuccess: () => void;
}

export function ShiftDialog({
  mode,
  roleId,
  shiftId,
  initial,
  onClose,
  onSuccess,
}: ShiftDialogProps) {
  const t = useTranslations();
  const notify = useNotify();

  const [label, setLabel] = useState(initial?.label ?? "");
  const [startsAt, setStartsAt] = useState<string | undefined>(
    initial?.startsAt ? initial.startsAt.toISOString() : undefined,
  );
  const [endsAt, setEndsAt] = useState<string | undefined>(
    initial?.endsAt ? initial.endsAt.toISOString() : undefined,
  );
  const [capacity, setCapacity] = useState(
    initial?.capacity != null ? String(initial.capacity) : "",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const createMutation = trpc.volunteer.shifts.create.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-shift-created",
        title: String(t("admin.volunteerShiftCreated")),
      });
      onSuccess();
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-shift-save-failed",
        title: String(t("admin.volunteerShiftSaveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const updateMutation = trpc.volunteer.shifts.update.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-shift-updated",
        title: String(t("admin.volunteerShiftUpdated")),
      });
      onSuccess();
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-shift-save-failed",
        title: String(t("admin.volunteerShiftSaveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const parseCapacity = (): number | null => {
    const trimmed = capacity.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    return Math.floor(parsed);
  };

  const handleSubmit = () => {
    if (!startsAt || !endsAt) return;
    if (new Date(endsAt) <= new Date(startsAt)) return;
    const trimmedLabel = label.trim();
    const trimmedNotes = notes.trim();
    const capacityValue = parseCapacity();

    if (mode === "create") {
      createMutation.mutate({
        roleId,
        label: trimmedLabel || null,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        capacity: capacityValue,
        notes: trimmedNotes || null,
      });
    } else if (shiftId) {
      updateMutation.mutate({
        id: shiftId,
        label: trimmedLabel || null,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        capacity: capacityValue,
        notes: trimmedNotes || null,
      });
    }
  };

  const canSubmit =
    !isPending &&
    !!startsAt &&
    !!endsAt &&
    new Date(endsAt) > new Date(startsAt);

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(
            mode === "create"
              ? t("admin.volunteerShiftDialogCreateTitle")
              : t("admin.volunteerShiftDialogEditTitle"),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerShiftFieldLabelLabel"))}
              </Text>
              <TextInput
                value={label}
                onChangeText={setLabel}
                placeholder={String(
                  t("admin.volunteerShiftFieldLabelPlaceholder"),
                )}
                maxLength={200}
                fullWidth
                testId="volunteer-shift-label"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerShiftFieldStartsAtLabel"))}
              </Text>
              <DateTimeLocalInput
                type="datetime-local"
                value={isoToLocalInput(startsAt)}
                onChange={(e) => setStartsAt(localInputToIso(e.target.value))}
                data-testid="volunteer-shift-starts-at"
                style={NATIVE_DATETIME_STYLE}
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerShiftFieldEndsAtLabel"))}
              </Text>
              <DateTimeLocalInput
                type="datetime-local"
                value={isoToLocalInput(endsAt)}
                onChange={(e) => setEndsAt(localInputToIso(e.target.value))}
                data-testid="volunteer-shift-ends-at"
                style={NATIVE_DATETIME_STYLE}
              />
            </YStack>

            <YStack gap="$1">
              <XStack gap="$2" alignItems="center">
                <Text variant="label">
                  {String(t("admin.volunteerShiftFieldCapacityLabel"))}
                </Text>
                <Tooltip
                  anchor={
                    <button
                      type="button"
                      aria-label={String(
                        t("admin.volunteerShiftFieldCapacityHint"),
                      )}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        background: "transparent",
                        border: "none",
                        color: "var(--colorMuted)",
                        cursor: "help",
                      }}
                    >
                      <HelpCircle size={12} />
                    </button>
                  }
                  placement="top"
                >
                  {String(t("admin.volunteerShiftFieldCapacityHint"))}
                </Tooltip>
              </XStack>
              <TextInput
                value={capacity}
                onChangeText={setCapacity}
                placeholder={String(
                  t("admin.volunteerShiftFieldCapacityPlaceholder"),
                )}
                inputMode="numeric"
                fullWidth
                testId="volunteer-shift-capacity"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerShiftFieldNotesLabel"))}
              </Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                placeholder={String(
                  t("admin.volunteerShiftFieldNotesPlaceholder"),
                )}
                multiline
                numberOfLines={3}
                maxLength={2000}
                fullWidth
                testId="volunteer-shift-notes"
              />
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
              disabled={!canSubmit}
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
