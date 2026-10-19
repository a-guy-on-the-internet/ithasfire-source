import { useMemo, type Dispatch, type SetStateAction } from "react";
import { YStack, XStack } from "tamagui";
import {
  type DataTableColumn,
  Button,
  Text,
  Badge,
  TextInput,
  Tooltip,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { Check, Pencil, Trash2, X } from "lucide-react";

import type {
  EntryDraft,
  EntryFieldErrors,
  EntryRow,
} from "./audience-detail-types";

interface UseAudienceEntriesColumnsOptions {
  editingDrafts: Record<string, EntryDraft>;
  setEditingDrafts: Dispatch<SetStateAction<Record<string, EntryDraft>>>;
  editErrors: Record<string, EntryFieldErrors>;
  setEditErrors: Dispatch<SetStateAction<Record<string, EntryFieldErrors>>>;
  onStartEditing: (row: EntryRow) => void;
  onCancelEditing: (entryId: string) => void;
  onUpdateEntry: (entryId: string) => void;
  onDeleteEntry: (entry: EntryRow) => void;
  isUpdatePending: boolean;
  t: ReturnType<typeof useTranslations>;
  fmt: ReturnType<typeof useFormatters>;
}

export function useAudienceEntriesColumns({
  editingDrafts,
  setEditingDrafts,
  editErrors,
  setEditErrors,
  onStartEditing,
  onCancelEditing,
  onUpdateEntry,
  onDeleteEntry,
  isUpdatePending,
  t,
  fmt,
}: UseAudienceEntriesColumnsOptions) {
  return useMemo<DataTableColumn<EntryRow>[]>(
    () => [
      {
        id: "contactEmail",
        header: String(t("admin.contactEmailColumn")),
        cell: (row) => {
          const draft = editingDrafts[row.id];
          if (draft) {
            const rowErrors = editErrors[row.id];
            return (
              <YStack gap="$1">
                <TextInput
                  size="$2"
                  value={draft.contactEmail}
                  status={rowErrors?.contactEmail ? "error" : undefined}
                  onChangeText={(v) => {
                    setEditingDrafts((prev) => ({
                      ...prev,
                      [row.id]: { ...prev[row.id]!, contactEmail: v },
                    }));
                    if (rowErrors?.contactEmail) {
                      setEditErrors((prev) => {
                        const next = { ...prev };
                        if (next[row.id]) {
                          const { contactEmail: _contactEmail, ...rest } =
                            next[row.id]!;
                          next[row.id] = rest;
                        }
                        return next;
                      });
                    }
                  }}
                  placeholder={String(t("admin.contactEmailColumn"))}
                />
                {rowErrors?.contactEmail && (
                  <Text fontSize="$1" tone="error">
                    {rowErrors.contactEmail}
                  </Text>
                )}
              </YStack>
            );
          }
          return (
            <Text variant="bodySmall" weight="medium">
              {row.contactEmail ?? "\u2014"}
            </Text>
          );
        },
      },
      {
        id: "contactPhone",
        header: String(t("admin.contactPhoneColumn")),
        cell: (row) => {
          const draft = editingDrafts[row.id];
          if (draft) {
            const rowErrors = editErrors[row.id];
            return (
              <YStack gap="$1">
                <TextInput
                  size="$2"
                  value={draft.contactPhone}
                  status={rowErrors?.contactPhone ? "error" : undefined}
                  onChangeText={(v) => {
                    setEditingDrafts((prev) => ({
                      ...prev,
                      [row.id]: { ...prev[row.id]!, contactPhone: v },
                    }));
                    if (rowErrors?.contactPhone) {
                      setEditErrors((prev) => {
                        const next = { ...prev };
                        if (next[row.id]) {
                          const { contactPhone: _contactPhone, ...rest } =
                            next[row.id]!;
                          next[row.id] = rest;
                        }
                        return next;
                      });
                    }
                  }}
                  placeholder={String(t("admin.contactPhoneColumn"))}
                />
                {rowErrors?.contactPhone && (
                  <Text fontSize="$1" tone="error">
                    {rowErrors.contactPhone}
                  </Text>
                )}
              </YStack>
            );
          }
          return (
            <Text fontSize="$2" tone="muted">
              {row.contactPhone ?? "\u2014"}
            </Text>
          );
        },
      },
      {
        id: "displayName",
        header: String(t("admin.contactNameColumn")),
        cell: (row) => {
          const draft = editingDrafts[row.id];
          if (draft) {
            return (
              <TextInput
                size="$2"
                value={draft.displayName}
                onChangeText={(v) =>
                  setEditingDrafts((prev) => ({
                    ...prev,
                    [row.id]: { ...prev[row.id]!, displayName: v },
                  }))
                }
                placeholder={String(t("admin.contactNameColumn"))}
              />
            );
          }
          return <Text fontSize="$2">{row.displayName ?? "\u2014"}</Text>;
        },
      },
      {
        id: "tags",
        header: String(t("admin.contactTagsColumn")),
        cell: (row) => {
          const draft = editingDrafts[row.id];
          if (draft) {
            return (
              <TextInput
                size="$2"
                value={draft.tags}
                onChangeText={(v) =>
                  setEditingDrafts((prev) => ({
                    ...prev,
                    [row.id]: { ...prev[row.id]!, tags: v },
                  }))
                }
                placeholder="tag1, tag2"
              />
            );
          }
          return row.tags.length > 0 ? (
            <XStack gap="$1" flexWrap="wrap">
              {row.tags.slice(0, 3).map((tg) => (
                <Badge key={tg} tone="info" size="xs">
                  {tg}
                </Badge>
              ))}
              {row.tags.length > 3 && (
                <Badge tone="neutral" size="xs">
                  +{row.tags.length - 3}
                </Badge>
              )}
            </XStack>
          ) : (
            <Text fontSize="$2" tone="muted">
              {"\u2014"}
            </Text>
          );
        },
      },
      {
        id: "status",
        header: String(t("admin.contactStatusColumn")),
        cell: (row) =>
          row.unsubscribedAt ? (
            <Badge tone="danger" size="xs">
              {String(t("admin.contactStatusUnsubscribed"))}
            </Badge>
          ) : (
            <Badge tone="success" size="xs">
              {String(t("admin.contactStatusActive"))}
            </Badge>
          ),
      },
      {
        id: "createdAt",
        header: String(t("admin.contactAddedColumn")),
        cell: (row) => (
          <Text fontSize="$2" tone="muted">
            {fmt.dateTime(row.createdAt)}
          </Text>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: (row) => {
          const isEditing = !!editingDrafts[row.id];
          if (isEditing) {
            return (
              <XStack justifyContent="flex-end" gap="$1">
                <Tooltip
                  anchor={
                    <Button
                      size="$2"
                      variant="ghost"
                      icon
                      onPress={() => onUpdateEntry(row.id)}
                      disabled={isUpdatePending}
                      aria-label={String(t("admin.saveEditsLabel"))}
                    >
                      <Check size={14} />
                    </Button>
                  }
                  placement="top"
                >
                  {String(t("admin.saveTooltip"))}
                </Tooltip>
                <Tooltip
                  anchor={
                    <Button
                      size="$2"
                      variant="ghost"
                      icon
                      onPress={() => onCancelEditing(row.id)}
                      aria-label={String(t("admin.cancelEditingLabel"))}
                    >
                      <X size={14} />
                    </Button>
                  }
                  placement="top"
                >
                  {String(t("admin.cancel"))}
                </Tooltip>
              </XStack>
            );
          }
          return (
            <XStack justifyContent="flex-end" gap="$1">
              <Tooltip
                anchor={
                  <Button
                    size="$2"
                    variant="ghost"
                    icon
                    onPress={() => onStartEditing(row)}
                    aria-label={String(t("admin.editContactLabel"))}
                  >
                    <Pencil size={14} />
                  </Button>
                }
                placement="top"
              >
                {String(t("admin.editTooltip"))}
              </Tooltip>
              <Tooltip
                anchor={
                  <Button
                    size="$2"
                    variant="ghost"
                    icon
                    onPress={() => onDeleteEntry(row)}
                    aria-label={String(t("admin.removeContactLabel"))}
                  >
                    <Trash2 size={14} />
                  </Button>
                }
                placement="top"
              >
                {String(t("admin.removeTooltip"))}
              </Tooltip>
            </XStack>
          );
        },
      },
    ],
    [
      onDeleteEntry,
      editingDrafts,
      editErrors,
      onStartEditing,
      onCancelEditing,
      onUpdateEntry,
      isUpdatePending,
      t,
      fmt,
      setEditingDrafts,
      setEditErrors,
    ],
  );
}
