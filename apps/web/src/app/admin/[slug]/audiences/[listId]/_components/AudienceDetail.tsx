"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack } from "tamagui";
import {
  type DataTableSortState,
  Button,
  Text,
  TextInput,
  Spinner,
  Tooltip,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { ArrowLeft, Download, Plus, Trash2 } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { type CsvColumnDef, rowsToCsv, downloadCsv } from "@/lib/csv-export";
import { AudienceEntriesTable } from "./AudienceEntriesTable";
import { useAudienceEntriesColumns } from "./useAudienceEntriesColumns";
import {
  type EntryRow,
  type EntryDraft,
  type EntryFieldErrors,
  EMPTY_DRAFT,
  PAGE_SIZE,
} from "./audience-detail-types";
import { validateDraft } from "./audience-entry-validation";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function AudienceDetail() {
  const { toast } = useNotify();
  const router = useRouter();
  const { slug, listId } = useParams<{ slug: string; listId: string }>();
  const utils = trpc.useUtils();
  const t = useTranslations();
  const fmt = useFormatters();

  // ── Audience header query ─────────────────────────────────────────────

  const {
    data: audience,
    isLoading: isLoadingAudience,
    error: audienceError,
  } = trpc.comms.getAudience.useQuery(
    { listId },
    { enabled: !!listId, staleTime: 15_000 },
  );

  // ── Stable ids for label/htmlFor binding ─────────────────────────────
  // `useId` keeps SSR + CSR in sync and avoids hand-rolled string ids
  // colliding when multiple AudienceDetail instances mount on the same
  // page (e.g. a multi-pane preview).
  const idPrefix = useId();
  const nameInputId = `${idPrefix}-name`;
  const descriptionInputId = `${idPrefix}-description`;

  // ── Local editing state ───────────────────────────────────────────────

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (audience) {
      setName(audience.name);
      setDescription(audience.description ?? "");
      setIsDirty(false);
    }
  }, [audience]);

  const handleNameChange = useCallback((v: string) => {
    setName(v);
    setIsDirty(true);
  }, []);

  const handleDescriptionChange = useCallback((v: string) => {
    setDescription(v);
    setIsDirty(true);
  }, []);

  // ── Entries query ─────────────────────────────────────────────────────

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "contactEmail",
    direction: "asc",
  });

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const {
    data: entriesRaw,
    isLoading: isLoadingEntries,
    isFetching: isFetchingEntries,
  } = trpc.comms.listAudienceEntries.useQuery(
    {
      listId,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search: debouncedSearch || undefined,
    },
    {
      enabled: !!listId,
      staleTime: 10_000,
      placeholderData: keepPreviousData,
    },
  );

  const entries = useMemo<EntryRow[]>(() => {
    if (!entriesRaw) return [];
    return entriesRaw.map((e) => ({
      id: e.id,
      contactEmail: e.contactEmail,
      contactPhone: e.contactPhone,
      displayName: e.displayName,
      tags: e.tags,
      consentSource: e.consentSource,
      unsubscribedAt: e.unsubscribedAt ? new Date(e.unsubscribedAt) : null,
      createdAt: new Date(e.createdAt),
    }));
  }, [entriesRaw]);

  // ── Client-side sort (within the page) ────────────────────────────────

  const sortedEntries = useMemo(() => {
    const rows = [...entries];
    const { columnId, direction } = sort;
    const m = direction === "asc" ? 1 : -1;

    rows.sort((a, b) => {
      switch (columnId) {
        case "contactEmail":
          return (a.contactEmail ?? "").localeCompare(b.contactEmail ?? "") * m;
        case "displayName":
          return (a.displayName ?? "").localeCompare(b.displayName ?? "") * m;
        case "createdAt":
          return (a.createdAt.getTime() - b.createdAt.getTime()) * m;
        default:
          return 0;
      }
    });
    return rows;
  }, [entries, sort]);

  // ── Mutations ─────────────────────────────────────────────────────────

  const updateMutation = trpc.comms.updateAudience.useMutation({
    meta: { silent: true },
  });
  const deleteEntryMutation = trpc.comms.deleteAudienceEntry.useMutation({
    meta: { silent: true },
  });
  const createEntryMutation = trpc.comms.createAudienceEntry.useMutation({
    meta: { silent: true },
  });
  const updateEntryMutation = trpc.comms.updateAudienceEntry.useMutation({
    meta: { silent: true },
  });
  const deleteAudienceMutation = trpc.comms.deleteAudience.useMutation({
    meta: { silent: true },
  });

  // ── Inline editing state ──────────────────────────────────────────────

  /** `null` = not adding; otherwise the draft fields for a new row. */
  const [addingDraft, setAddingDraft] = useState<EntryDraft | null>(null);
  /** Field-level validation errors for the add form. */
  const [addErrors, setAddErrors] = useState<EntryFieldErrors>({});
  /** Map from entryId → draft for in-place editing. */
  const [editingDrafts, setEditingDrafts] = useState<
    Record<string, EntryDraft>
  >({});
  /** Map from entryId → field errors for inline editing. */
  const [editErrors, setEditErrors] = useState<
    Record<string, EntryFieldErrors>
  >({});

  const startAdding = useCallback(() => {
    setAddingDraft({ ...EMPTY_DRAFT });
    setAddErrors({});
  }, []);
  const cancelAdding = useCallback(() => {
    setAddingDraft(null);
    setAddErrors({});
  }, []);

  const startEditing = useCallback((row: EntryRow) => {
    setEditingDrafts((prev) => ({
      ...prev,
      [row.id]: {
        contactEmail: row.contactEmail ?? "",
        contactPhone: row.contactPhone ?? "",
        displayName: row.displayName ?? "",
        tags: row.tags.join(", "),
      },
    }));
    setEditErrors((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
  }, []);

  const cancelEditing = useCallback((entryId: string) => {
    setEditingDrafts((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    setEditErrors((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
  }, []);

  const parseTags = (raw: string): string[] =>
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

  const invalidateEntries = useCallback(async () => {
    await utils.comms.listAudienceEntries.invalidate({ listId });
    await utils.comms.getAudience.invalidate({ listId });
  }, [listId, utils]);

  const handleAddEntry = useCallback(async () => {
    if (!addingDraft || !listId) return;

    const errors = validateDraft(addingDraft, t);
    if (errors) {
      setAddErrors(errors);
      return;
    }
    setAddErrors({});

    const email = addingDraft.contactEmail.trim() || null;
    const phone = addingDraft.contactPhone.trim() || null;
    try {
      await createEntryMutation.mutateAsync({
        listId,
        contactEmail: email,
        contactPhone: phone,
        displayName: addingDraft.displayName.trim() || null,
        tags: parseTags(addingDraft.tags),
      });
      setAddingDraft(null);
      setAddErrors({});
      toast.success({
        id: "entry-added",
        title: t("admin.contactAdded") as string,
        message: t("admin.contactAddedMessage") as string,
      });
      await invalidateEntries();
    } catch (err) {
      toast.danger({
        id: "entry-add-failed",
        title: t("admin.addFailed") as string,
        message: formatErrorMessage(err, t),
      });
    }
  }, [addingDraft, listId, createEntryMutation, toast, invalidateEntries, t]);

  const handleUpdateEntry = useCallback(
    async (entryId: string) => {
      const draft = editingDrafts[entryId];
      if (!draft || !listId) return;

      const errors = validateDraft(draft, t);
      if (errors) {
        setEditErrors((prev) => ({ ...prev, [entryId]: errors }));
        return;
      }
      setEditErrors((prev) => {
        const next = { ...prev };
        delete next[entryId];
        return next;
      });

      const email = draft.contactEmail.trim() || null;
      const phone = draft.contactPhone.trim() || null;
      try {
        await updateEntryMutation.mutateAsync({
          listId,
          entryId,
          contactEmail: email,
          contactPhone: phone,
          displayName: draft.displayName.trim() || null,
          tags: parseTags(draft.tags),
        });
        cancelEditing(entryId);
        toast.success({
          id: "entry-updated",
          title: t("admin.contactUpdated") as string,
          message: t("admin.contactUpdatedMessage") as string,
        });
        await invalidateEntries();
      } catch (err) {
        toast.danger({
          id: "entry-update-failed",
          title: t("admin.updateFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [
      editingDrafts,
      listId,
      updateEntryMutation,
      toast,
      cancelEditing,
      invalidateEntries,
      t,
    ],
  );

  const handleSave = useCallback(async () => {
    if (!listId || !isDirty) return;

    try {
      await updateMutation.mutateAsync({
        listId,
        name: name.trim() || undefined,
        description: description.trim() || null,
      });
      setIsDirty(false);
      toast.success({
        id: "audience-saved",
        title: t("admin.audienceSaved") as string,
        message: t("admin.audienceSavedMessage") as string,
      });
      await utils.comms.getAudience.invalidate({ listId });
      await utils.comms.listAudiences.invalidate();
    } catch (err) {
      toast.danger({
        id: "audience-save-failed",
        title: t("admin.saveFailed") as string,
        message: formatErrorMessage(err, t),
      });
    }
  }, [listId, isDirty, name, description, updateMutation, toast, utils, t]);

  const handleDeleteEntry = useCallback(
    async (entry: EntryRow) => {
      const label =
        entry.contactEmail ?? entry.displayName ?? entry.id.slice(0, 8);
      if (!confirm(String(t("admin.removeEntryConfirm", { label })))) return;

      try {
        await deleteEntryMutation.mutateAsync({ listId, entryId: entry.id });
        toast.success({
          id: "entry-deleted",
          title: t("admin.entryRemoved") as string,
          message: t("admin.entryRemovedMessage", { label }) as string,
        });
        await utils.comms.listAudienceEntries.invalidate({ listId });
        await utils.comms.getAudience.invalidate({ listId });
      } catch (err) {
        toast.danger({
          id: "entry-delete-failed",
          title: t("admin.removeFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [listId, deleteEntryMutation, toast, utils, t],
  );

  const backToList = useCallback(() => {
    // Match PromoFormDialog's discard pattern — confirm before walking
    // the user away from in-progress edits to the name/description.
    if (isDirty) {
      const confirmed = window.confirm(
        String(
          t("admin.audienceDiscardConfirm") ??
            "Discard changes? Anything you typed will be lost.",
        ),
      );
      if (!confirmed) return;
    }
    router.push(`/admin/${slug}/audiences`);
  }, [router, slug, isDirty, t]);

  const handleDeleteAudience = useCallback(async () => {
    if (!listId) return;
    const label = audience?.name ?? "this audience";
    if (!confirm(String(t("admin.deleteAudienceConfirm", { name: label }))))
      return;

    try {
      await deleteAudienceMutation.mutateAsync({ listId });
      toast.success({
        id: "audience-deleted",
        title: t("admin.audienceDeletedDetail") as string,
        message: t("admin.audienceDeletedDetailMessage", {
          name: label,
        }) as string,
      });
      await utils.comms.listAudiences.invalidate();
      router.push(`/admin/${slug}/audiences`);
    } catch (err) {
      toast.danger({
        id: "audience-delete-failed",
        title: t("admin.deleteFailed") as string,
        message: formatErrorMessage(err, t),
      });
    }
  }, [
    listId,
    audience?.name,
    deleteAudienceMutation,
    toast,
    utils,
    router,
    slug,
    t,
  ]);

  // ── Export CSV ────────────────────────────────────────────────────────

  const [isExporting, setIsExporting] = useState(false);

  const handleExportCsv = useCallback(async () => {
    if (!listId) return;
    setIsExporting(true);
    try {
      const allEntries = await utils.comms.exportAudienceEntries.fetch({
        listId,
      });
      const csvColumns: CsvColumnDef<(typeof allEntries)[number]>[] = [
        { header: "Email", value: (r) => r.contactEmail },
        { header: "Phone", value: (r) => r.contactPhone },
        { header: "Name", value: (r) => r.displayName },
        { header: "Tags", value: (r) => r.tags.join(", ") },
        { header: "Consent Source", value: (r) => r.consentSource },
        {
          header: "Unsubscribed",
          value: (r) => (r.unsubscribedAt ? "Yes" : ""),
        },
        {
          header: "Added",
          value: (r) =>
            r.createdAt ? new Date(r.createdAt).toISOString() : "",
        },
      ];
      const csv = rowsToCsv(allEntries, csvColumns);
      const filename = `${(audience?.name ?? "audience").replace(/\s+/g, "-").toLowerCase()}-export.csv`;
      downloadCsv(csv, filename);
    } catch (err) {
      toast.danger({
        id: "export-failed",
        title: String(t("admin.exportFailed")),
        message: formatErrorMessage(err),
      });
    } finally {
      setIsExporting(false);
    }
  }, [listId, audience?.name, utils, toast, t]);

  // ── Columns ───────────────────────────────────────────────────────────

  const columns = useAudienceEntriesColumns({
    editingDrafts,
    setEditingDrafts,
    editErrors,
    setEditErrors,
    onStartEditing: startEditing,
    onCancelEditing: cancelEditing,
    onUpdateEntry: (entryId) => {
      void handleUpdateEntry(entryId);
    },
    onDeleteEntry: (entry) => {
      void handleDeleteEntry(entry);
    },
    isUpdatePending: updateEntryMutation.isPending,
    t,
    fmt,
  });

  // ── Pagination helpers ────────────────────────────────────────────────

  const hasMore = entries.length === PAGE_SIZE;

  // ── Render ────────────────────────────────────────────────────────────

  if (isLoadingAudience) {
    return (
      <YStack flex={1} alignItems="center" justifyContent="center" padding="$8">
        <Spinner size="lg" />
      </YStack>
    );
  }

  if (audienceError || !audience) {
    return (
      <YStack padding="$4" gap="$3">
        <Button size="$2" variant="ghost" onPress={backToList}>
          <ArrowLeft size={16} />
          <Text>{String(t("admin.backToAudiences"))}</Text>
        </Button>
        <Text tone="error">
          {audienceError
            ? formatErrorMessage(audienceError)
            : String(t("admin.audienceNotFound"))}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack flex={1} gap="$4" padding="$4">
      {/* Back + title bar — name promoted to h3, count promoted to bold
			    body so the eye lands on the audience identity first. */}
      <XStack gap="$3" alignItems="center">
        <Button size="$2" variant="ghost" icon onPress={backToList}>
          <ArrowLeft size={16} />
        </Button>
        <YStack flex={1} gap="$1">
          <Text variant="h3" weight="bold">
            {audience.name}
          </Text>
          <Text variant="body" weight="bold" tone="muted">
            {String(t("admin.nContacts", { count: audience.contactCount }))}
          </Text>
        </YStack>
        {/* Action bar — Import is primary (filled) when the list is
				    empty (the recommended path); demoted to outlined once
				    contacts exist. Save reserves its slot to avoid horizontal
				    reflow. Delete is icon-only at the far right with a
				    divider before it (Fitts: separate destructive from
				    primary). */}
        <XStack gap="$2" alignItems="center">
          <Button
            size="$2"
            variant={audience.contactCount === 0 ? "primary" : "outlined"}
            onPress={() =>
              router.push(`/admin/${slug}/audiences/import?listId=${listId}`)
            }
          >
            {String(t("admin.importContacts"))}
          </Button>
          <Button
            size="$2"
            variant="secondary"
            onPress={() => {
              void handleExportCsv();
            }}
            disabled={isExporting}
          >
            {isExporting ? <Spinner size="sm" /> : <Download size={14} />}
            {String(t("admin.exportCsv"))}
          </Button>
          <Button
            size="$2"
            onPress={() => {
              void handleSave();
            }}
            disabled={!isDirty || updateMutation.isPending}
          >
            {String(t("admin.saveChanges"))}
          </Button>
          {/* Visual separator before the destructive action. */}
          <YStack
            width={1}
            height={24}
            backgroundColor="$borderColor"
            marginHorizontal="$1"
          />
          <Tooltip
            anchor={
              <Button
                size="$2"
                variant="ghost"
                icon
                onPress={() => {
                  void handleDeleteAudience();
                }}
                disabled={deleteAudienceMutation.isPending}
                aria-label={String(t("admin.deleteAudience"))}
              >
                <Trash2 size={14} color="var(--danger)" />
              </Button>
            }
          >
            {String(t("admin.deleteAudience"))}
          </Tooltip>
        </XStack>
      </XStack>

      {/* Edit fields — labels properly bound via htmlFor/useId so screen
			    readers and click-to-focus work. */}
      <YStack gap="$3" maxWidth={600}>
        <YStack gap="$1">
          <Text
            tag="label"
            variant="bodySmall"
            weight="bold"
            htmlFor={nameInputId}
          >
            {String(t("admin.audienceNameLabel"))}
          </Text>
          <TextInput
            id={nameInputId}
            value={name}
            onChangeText={handleNameChange}
            placeholder={String(t("admin.audienceNamePlaceholder"))}
          />
        </YStack>
        <YStack gap="$1">
          <Text
            tag="label"
            variant="bodySmall"
            weight="bold"
            htmlFor={descriptionInputId}
          >
            {String(t("admin.audienceDescriptionLabel"))}
          </Text>
          {/* Multiline — descriptions are long-form context, not
					    one-liners. `multiline` + a row count gives the affordance. */}
          <TextInput
            id={descriptionInputId}
            value={description}
            onChangeText={handleDescriptionChange}
            placeholder={String(t("admin.audienceDescriptionPlaceholder"))}
            {...({ multiline: true, numberOfLines: 3 } as Record<
              string,
              unknown
            >)}
          />
        </YStack>
      </YStack>

      {/* Entries section */}
      <YStack gap="$3" flex={1}>
        <XStack justifyContent="space-between" alignItems="center">
          <XStack gap="$2" alignItems="center">
            <Text variant="h6" weight="bold">
              {String(t("admin.contactsHeading"))}
            </Text>
            {isFetchingEntries && <Spinner size="sm" />}
          </XStack>
          {!addingDraft && (
            <Button size="$2" variant="secondary" onPress={startAdding}>
              <Plus size={14} />
              {String(t("admin.addContact"))}
            </Button>
          )}
        </XStack>

        <XStack gap="$2" alignItems="center" maxWidth={360}>
          <TextInput
            placeholder={t("admin.searchContactsPlaceholder") as string}
            value={search}
            onChangeText={setSearch}
            flex={1}
            aria-label={String(t("admin.searchContactsPlaceholder"))}
          />
        </XStack>

        <AudienceEntriesTable
          rows={sortedEntries}
          columns={columns}
          sort={sort}
          onSortChange={setSort}
          addingDraft={addingDraft}
          addErrors={addErrors}
          setAddingDraft={setAddingDraft}
          setAddErrors={setAddErrors}
          isLoadingEntries={isLoadingEntries}
          page={page}
          hasMore={hasMore}
          setPage={setPage}
          onStartAdding={startAdding}
          onCancelAdding={cancelAdding}
          onAddEntry={() => {
            void handleAddEntry();
          }}
          onImportContacts={() =>
            router.push(`/admin/${slug}/audiences/import?listId=${listId}`)
          }
          isCreatingEntry={createEntryMutation.isPending}
          t={t}
        />
      </YStack>
    </YStack>
  );
}
