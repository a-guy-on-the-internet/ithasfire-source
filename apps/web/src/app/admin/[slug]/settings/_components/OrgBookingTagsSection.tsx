"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Spinner,
  StyledSelect,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { trpc } from "@/trpc";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { formatErrorMessage } from "@/lib/format-error-message";
import { BookingTagChip } from "@/components/bookings/BookingTagChip";
import {
  BOOKING_TAG_COLORS,
  bookingTagColorStyle,
  isBookingTagColor,
  type BookingTagColor,
} from "@/components/bookings/booking-tag-color";

import { SectionHeading } from "./org-settings-primitives";

// ─────────────────────────────────────────────────────────────────────────────
// "Booking tags" — the org's venue-internal filing vocabulary for received
// booking requests (booking-holds spec 2026-08-25, FR-017). Tags are created
// inline from a request too (BookingTagInput); this is where they get
// renamed, recoloured, reordered and deleted. Delete DETACHES — the server
// drops the join rows — so the confirm names that.
//
// Config, not a queue: one row per tag, editable in place, no save bar. Each
// edit is its own write (rename on blur / Enter, colour on change, order on
// the arrows), which is how the rest of the settings rail behaves and avoids
// a dirty-state model for a list of six words.
//
// Colour is a NAME from the theme's intent set, never a hex — the chip on the
// left of each row is the live preview, drawn by the same `BookingTagChip`
// the inbox uses, so what is picked here is what the inbox shows.
// ─────────────────────────────────────────────────────────────────────────────

type TagRow = {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
};

const NAME_MAX = 40;

export function OrgBookingTagsSection({ orgId }: { orgId: string }) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const listQuery = trpc.bookingTags.list.useQuery(
    { orgId },
    { staleTime: 60_000, retry: 1 },
  );
  const tags = useMemo<TagRow[]>(
    () =>
      (listQuery.data?.tags ?? [])
        .map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          sortOrder: tag.sortOrder,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [listQuery.data?.tags],
  );

  const invalidate = useCallback(() => {
    void utils.bookingTags.list.invalidate({ orgId });
    // Rows carry tag name + colour; a rename must reach the inbox chips.
    void utils.bookingRequests.list.invalidate();
  }, [orgId, utils.bookingRequests.list, utils.bookingTags.list]);

  const fail = useCallback(
    (err: unknown) => {
      toast.danger({
        id: "booking-tag-save-failed",
        title: String(t("admin.bkTagSaveFailed")),
        message: formatErrorMessage(err, t),
      });
      invalidate();
    },
    [invalidate, t, toast],
  );

  const opts = { retry: false, meta: { silent: true } } as const;
  const createMutation = trpc.bookingTags.create.useMutation(opts);
  const updateMutation = trpc.bookingTags.update.useMutation(opts);
  const deleteMutation = trpc.bookingTags.delete.useMutation(opts);
  const busy =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  // ── Add ──────────────────────────────────────────────────────────────────
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<BookingTagColor>("neutral");
  const canAdd = newName.trim().length > 0 && !busy;
  const handleAdd = useCallback(() => {
    if (!canAdd) return;
    createMutation.mutate(
      { orgId, name: newName.trim(), color: newColor },
      {
        onSuccess: () => {
          setNewName("");
          setNewColor("neutral");
          invalidate();
        },
        onError: fail,
      },
    );
  }, [canAdd, createMutation, fail, invalidate, newColor, newName, orgId]);

  // ── Rename (draft per row; commits on blur / Enter) ──────────────────────
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const commitRename = useCallback(
    (tag: TagRow) => {
      const draft = drafts[tag.id];
      if (draft === undefined) return;
      const name = draft.trim();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[tag.id];
        return next;
      });
      if (name.length === 0 || name === tag.name) return;
      updateMutation.mutate(
        { orgId, tagId: tag.id, name },
        { onSuccess: invalidate, onError: fail },
      );
    },
    [drafts, fail, invalidate, orgId, updateMutation],
  );

  const recolor = useCallback(
    (tag: TagRow, color: string) => {
      if (!isBookingTagColor(color) || color === tag.color) return;
      updateMutation.mutate(
        { orgId, tagId: tag.id, color },
        { onSuccess: invalidate, onError: fail },
      );
    },
    [fail, invalidate, orgId, updateMutation],
  );

  // Reorder = swap with the neighbour, then RENUMBER the whole list 0..n-1
  // in its new order. Tags created inline all arrive with the same default
  // sortOrder, so a pairwise swap of equal values would move nothing;
  // renumbering makes every order explicit. Writes are sequential (a handful
  // of rows); the list is re-read after the last, and a failure mid-way
  // leaves a visible, re-orderable state rather than a silent half-swap.
  const move = useCallback(
    async (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (busy || index < 0 || target < 0 || target >= tags.length) return;
      const next = tags.slice();
      const [moved] = next.splice(index, 1);
      if (!moved) return;
      next.splice(target, 0, moved);
      try {
        for (let i = 0; i < next.length; i += 1) {
          const tag = next[i]!;
          if (tag.sortOrder === i) continue;
          await updateMutation.mutateAsync({ orgId, tagId: tag.id, sortOrder: i });
        }
        invalidate();
      } catch (err) {
        fail(err);
      }
    },
    [busy, fail, invalidate, orgId, tags, updateMutation],
  );

  // ── Delete ───────────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<TagRow | null>(null);
  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { orgId, tagId: deleteTarget.id },
      {
        onSuccess: invalidate,
        onError: fail,
        onSettled: () => setDeleteTarget(null),
      },
    );
  }, [deleteMutation, deleteTarget, fail, invalidate, orgId]);

  const colorOptions = BOOKING_TAG_COLORS.map((color) => ({
    value: color,
    label: String(t(bookingTagColorStyle(color).labelKey)),
  }));

  return (
    <YStack gap="$4" data-testid="org-booking-tags">
      <SectionHeading
        title={String(t("admin.settingsBookingTags"))}
        description={String(t("admin.settingsBookingTagsDescription"))}
      />

      {listQuery.isLoading ? (
        <XStack gap="$2" alignItems="center">
          <Spinner size="sm" />
          <Text variant="caption" tone="muted">
            {String(t("common.loading"))}
          </Text>
        </XStack>
      ) : listQuery.error ? (
        <YStack gap="$2" alignItems="flex-start">
          <Text variant="bodySmall" tone="error" role="alert">
            {formatErrorMessage(listQuery.error, t)}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => void listQuery.refetch()}>
            {String(t("admin.placesRetry"))}
          </Button>
        </YStack>
      ) : tags.length === 0 ? (
        <Text variant="body" tone="muted" data-testid="org-booking-tags-empty">
          {String(t("admin.settingsBookingTagsEmpty"))}
        </Text>
      ) : (
        <YStack
          borderWidth={1}
          borderColor="$borderColor"
          backgroundColor="$surface"
          role="list"
          aria-label={String(t("admin.settingsBookingTags"))}
        >
          {tags.map((tag, index) => (
            <XStack
              key={tag.id}
              role="listitem"
              gap="$2"
              alignItems="center"
              flexWrap="wrap"
              padding="$2"
              borderTopWidth={index === 0 ? 0 : 1}
              borderTopColor="$borderColor"
              minWidth={0}
              data-testid={`org-booking-tag-${tag.id}`}
            >
              <XStack width={120} flexShrink={0}>
                <BookingTagChip name={drafts[tag.id] ?? tag.name} color={tag.color} />
              </XStack>
              <XStack flexBasis={160} flexGrow={1} flexShrink={1} minWidth={0}>
                <TextInput
                  value={drafts[tag.id] ?? tag.name}
                  onChangeText={(next) =>
                    setDrafts((prev) => ({ ...prev, [tag.id]: next }))
                  }
                  onBlur={() => commitRename(tag)}
                  onSubmitEditing={() => commitRename(tag)}
                  maxLength={NAME_MAX}
                  fullWidth
                  aria-label={String(t("admin.bkTagNameLabel", { name: tag.name }))}
                  testId={`org-booking-tag-${tag.id}-name`}
                />
              </XStack>
              <XStack width={132} flexShrink={0}>
                <StyledSelect
                  value={isBookingTagColor(tag.color) ? tag.color : "neutral"}
                  options={colorOptions}
                  onChange={(next) => recolor(tag, next)}
                  size="sm"
                  fullWidth
                  disabled={busy}
                  ariaLabel={String(t("admin.bkTagColorLabel", { name: tag.name }))}
                  testId={`org-booking-tag-${tag.id}-color`}
                />
              </XStack>
              <XStack gap="$1" flexShrink={0}>
                <Button
                  variant="ghost"
                  size="$2"
                  disabled={busy || index === 0}
                  onPress={() => void move(index, -1)}
                  aria-label={String(t("admin.bkTagMoveUp", { name: tag.name }))}
                >
                  <ArrowUp size={13} strokeWidth={2} aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="$2"
                  disabled={busy || index === tags.length - 1}
                  onPress={() => void move(index, 1)}
                  aria-label={String(t("admin.bkTagMoveDown", { name: tag.name }))}
                >
                  <ArrowDown size={13} strokeWidth={2} aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="$2"
                  disabled={busy}
                  onPress={() => setDeleteTarget(tag)}
                  aria-label={String(t("admin.bkTagDelete", { name: tag.name }))}
                  testID={`org-booking-tag-${tag.id}-delete`}
                >
                  <Trash2 size={13} strokeWidth={2} aria-hidden />
                </Button>
              </XStack>
            </XStack>
          ))}
        </YStack>
      )}

      {/* Add — a dashed frame, like the calendar blackout editor's add form. */}
      {!listQuery.error ? (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderStyle="dashed"
          borderColor="$borderColor"
          data-testid="org-booking-tags-add"
        >
          <Text variant="caption" weight="bold" textTransform="uppercase" letterSpacing={0.6}>
            {String(t("admin.bkTagAddTitle"))}
          </Text>
          <XStack gap="$2" alignItems="center" flexWrap="wrap" minWidth={0}>
            <XStack flexBasis={200} flexGrow={1} flexShrink={1} minWidth={0}>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                onSubmitEditing={handleAdd}
                placeholder={String(t("admin.bkTagPlaceholder"))}
                maxLength={NAME_MAX}
                fullWidth
                aria-label={String(t("admin.bkTagAddNameLabel"))}
                testId="org-booking-tags-add-name"
              />
            </XStack>
            <XStack width={132} flexShrink={0}>
              <StyledSelect
                value={newColor}
                options={colorOptions}
                onChange={(next) => {
                  if (isBookingTagColor(next)) setNewColor(next);
                }}
                size="sm"
                fullWidth
                ariaLabel={String(t("admin.bkTagAddColorLabel"))}
                testId="org-booking-tags-add-color"
              />
            </XStack>
            <Button
              variant="secondary"
              size="$2"
              disabled={!canAdd}
              onPress={handleAdd}
              testID="org-booking-tags-add-submit"
            >
              {createMutation.isPending ? (
                <Spinner size="sm" />
              ) : (
                <>
                  <Plus size={13} strokeWidth={2} aria-hidden />
                  {String(t("admin.bkTagAddCta"))}
                </>
              )}
            </Button>
          </XStack>
        </YStack>
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        title={String(t("admin.bkTagDeleteConfirmTitle"))}
        description={
          deleteTarget
            ? String(t("admin.bkTagDeleteConfirmBody", { name: deleteTarget.name }))
            : ""
        }
        confirmLabel={String(t("admin.bkTagDeleteCta"))}
        cancelLabel={String(t("common.cancel"))}
        tone="danger"
        loading={deleteMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
    </YStack>
  );
}
