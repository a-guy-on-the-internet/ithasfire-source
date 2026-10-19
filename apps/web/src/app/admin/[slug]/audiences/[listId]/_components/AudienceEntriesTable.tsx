import { type Dispatch, type SetStateAction } from "react";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  TextInput,
  Spinner,
  useTranslations,
} from "@th/ui";
import { Check, Plus, X } from "lucide-react";

import type {
  EntryDraft,
  EntryFieldErrors,
  EntryRow,
} from "./audience-detail-types";

interface AudienceEntriesTableProps {
  rows: EntryRow[];
  columns: DataTableColumn<EntryRow>[];
  sort: DataTableSortState;
  onSortChange: Dispatch<SetStateAction<DataTableSortState>>;
  addingDraft: EntryDraft | null;
  addErrors: EntryFieldErrors;
  setAddingDraft: Dispatch<SetStateAction<EntryDraft | null>>;
  setAddErrors: Dispatch<SetStateAction<EntryFieldErrors>>;
  isLoadingEntries: boolean;
  page: number;
  hasMore: boolean;
  setPage: Dispatch<SetStateAction<number>>;
  onStartAdding: () => void;
  onCancelAdding: () => void;
  onAddEntry: () => void;
  onImportContacts: () => void;
  isCreatingEntry: boolean;
  t: ReturnType<typeof useTranslations>;
}

export function AudienceEntriesTable({
  rows,
  columns,
  sort,
  onSortChange,
  addingDraft,
  addErrors,
  setAddingDraft,
  setAddErrors,
  isLoadingEntries,
  page,
  hasMore,
  setPage,
  onStartAdding,
  onCancelAdding,
  onAddEntry,
  onImportContacts,
  isCreatingEntry,
  t,
}: AudienceEntriesTableProps) {
  if (isLoadingEntries && !rows.length) {
    return (
      <YStack alignItems="center" padding="$6">
        <Spinner size="lg" />
      </YStack>
    );
  }

  if (rows.length === 0 && !addingDraft) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$3"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
      >
        <Text weight="bold" variant="h6">
          {String(t("admin.noContactsYet"))}
        </Text>
        <Text tone="muted" textAlign="center">
          {String(t("admin.noContactsDescription"))}
        </Text>
        <XStack gap="$2">
          <Button size="$3" variant="secondary" onPress={onStartAdding}>
            <Plus size={16} />
            {String(t("admin.addContact"))}
          </Button>
          <Button size="$3" onPress={onImportContacts}>
            {String(t("admin.importContacts"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        sort={sort}
        onSortChange={onSortChange}
        getRowKey={(row) => row.id}
        // Borderless page-flow table with no scrolling ancestor — restore
        // DataTable's own overflow wrapper for scoped horizontal panning.
        scrollContainer
      />

      {addingDraft && (
        <YStack
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          overflow="hidden"
          data-testid="add-contact-table"
        >
          <div style={{ paddingInlineEnd: 8 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "8px 12px 6px",
                      fontWeight: 700,
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase" as const,
                      borderBottom:
                        "2px solid var(--borderColorStrong, #000000)",
                    }}
                  >
                    {String(t("admin.addContactEmailLabel"))}
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "8px 12px 6px",
                      fontWeight: 700,
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase" as const,
                      borderBottom:
                        "2px solid var(--borderColorStrong, #000000)",
                    }}
                  >
                    {String(t("admin.addContactPhoneLabel"))}
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "8px 12px 6px",
                      fontWeight: 700,
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase" as const,
                      borderBottom:
                        "2px solid var(--borderColorStrong, #000000)",
                    }}
                  >
                    {String(t("admin.addContactNameLabel"))}
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "8px 12px 6px",
                      fontWeight: 700,
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase" as const,
                      borderBottom:
                        "2px solid var(--borderColorStrong, #000000)",
                    }}
                  >
                    {String(t("admin.addContactTagsLabel"))}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ background: "var(--surfaceMuted, #EFE7D6)" }}>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <YStack gap="$1">
                      <TextInput
                        size="$2"
                        value={addingDraft.contactEmail}
                        status={addErrors.contactEmail ? "error" : undefined}
                        onChangeText={(v) => {
                          setAddingDraft((d) =>
                            d ? { ...d, contactEmail: v } : d,
                          );
                          if (addErrors.contactEmail) {
                            setAddErrors((prev) => {
                              const { contactEmail: _contactEmail, ...rest } =
                                prev;
                              return rest;
                            });
                          }
                        }}
                        placeholder={
                          t("admin.addContactEmailPlaceholder") as string
                        }
                        autoFocus
                      />
                      {addErrors.contactEmail && (
                        <Text fontSize="$1" tone="error">
                          {addErrors.contactEmail}
                        </Text>
                      )}
                    </YStack>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <YStack gap="$1">
                      <TextInput
                        size="$2"
                        value={addingDraft.contactPhone}
                        status={addErrors.contactPhone ? "error" : undefined}
                        onChangeText={(v) => {
                          setAddingDraft((d) =>
                            d ? { ...d, contactPhone: v } : d,
                          );
                          if (addErrors.contactPhone) {
                            setAddErrors((prev) => {
                              const { contactPhone: _contactPhone, ...rest } =
                                prev;
                              return rest;
                            });
                          }
                        }}
                        placeholder={
                          t("admin.addContactPhonePlaceholder") as string
                        }
                      />
                      {addErrors.contactPhone && (
                        <Text fontSize="$1" tone="error">
                          {addErrors.contactPhone}
                        </Text>
                      )}
                    </YStack>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <TextInput
                      size="$2"
                      value={addingDraft.displayName}
                      onChangeText={(v) =>
                        setAddingDraft((d) =>
                          d ? { ...d, displayName: v } : d,
                        )
                      }
                      placeholder={
                        t("admin.addContactNamePlaceholder") as string
                      }
                    />
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <TextInput
                      size="$2"
                      value={addingDraft.tags}
                      onChangeText={(v) =>
                        setAddingDraft((d) => (d ? { ...d, tags: v } : d))
                      }
                      placeholder={
                        t("admin.addContactTagsPlaceholder") as string
                      }
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <XStack justifyContent="center" gap="$3" padding="$4">
            <Button size="$3" onPress={onAddEntry} disabled={isCreatingEntry}>
              <Check size={14} />
              {String(t("admin.addContactButton"))}
            </Button>
            <Button size="$3" variant="ghost" onPress={onCancelAdding}>
              <X size={14} />
              {String(t("admin.cancel"))}
            </Button>
          </XStack>
        </YStack>
      )}

      <XStack
        justifyContent="space-between"
        alignItems="center"
        paddingTop="$2"
      >
        <Button
          size="$2"
          variant="secondary"
          disabled={page === 0}
          onPress={() => setPage((p) => Math.max(0, p - 1))}
        >
          {String(t("admin.previous"))}
        </Button>
        <Text fontSize="$2" tone="muted">
          {String(t("admin.pageLabel", { page: page + 1 }))}
        </Text>
        <Button
          size="$2"
          variant="secondary"
          disabled={!hasMore}
          onPress={() => setPage((p) => p + 1)}
        >
          {String(t("admin.next"))}
        </Button>
      </XStack>
    </>
  );
}
