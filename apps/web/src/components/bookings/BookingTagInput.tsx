"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { XStack, YStack, styled, useTheme } from "tamagui";
import {
  AutocompleteField,
  Button,
  Text,
  useNotify,
  useTranslations,
  type AutocompleteSection,
} from "@th/ui";
import { Plus, Tag as TagIcon } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { BookingTagChip } from "./BookingTagChip";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TAG INPUT (booking-holds spec 2026-08-25, FR-017).
//
// Mirrors the event builder's tag picker (CategoryTagsSection): chips for the
// current selection, a typeahead underneath, and a "Create {name}" row when
// the query matches nothing — Enter on raw text creates too. What differs:
//
//   - CONTROLLED. `value` is the selected TAG IDS and `onChange` receives the
//     next id list; the caller persists (or, for the inbox FILTER, just
//     filters). The component never writes a request's tags itself, so the
//     same control serves the expanded row (writes `setForRequest`) and the
//     filter bar (writes nothing).
//   - ORG-SCOPED. Options are `bookingTags.list({ orgId })` — the org's own
//     vocabulary, not a global tag search — and a create goes straight to the
//     org's list (`bookingTags.create`), then into the selection.
//   - `allowCreate` is off for the filter: a filter that mints tags is a
//     surprise.
//
// Tags are venue-internal (never shown to the act), so nothing here is gated
// on the request's status.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingTagOption = { id: string; name: string; color: string };

type PickerItem =
  | { type: "tag"; id: string; tag: BookingTagOption }
  | { type: "create"; id: string; name: string };

/** Mirrors core `BOOKING_TAG_NAME_MAX`-ish bounds; the server re-validates. */
const NAME_MAX = 40;

const Row = styled(Button, {
  justifyContent: "flex-start",
  alignItems: "stretch",
  width: "100%",
  borderRadius: 0,
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  paddingHorizontal: "$2",
  paddingVertical: 0,
  minHeight: 28,
  hoverStyle: { backgroundColor: "$surfaceRaised", borderLeftColor: "$accent" },
  pressStyle: { backgroundColor: "$surfaceRaised", borderLeftColor: "$accent" },
  focusVisibleStyle: {
    outlineWidth: 0,
    backgroundColor: "$surfaceRaised",
    borderLeftColor: "$accent",
  },
});

function normalizeName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function BookingTagInput({
  orgId,
  value,
  onChange,
  allowCreate = true,
  disabled = false,
  placeholder,
  ariaLabel,
  testIdBase = "booking-tag-input",
}: {
  orgId: string;
  /** Selected tag ids. */
  value: readonly string[];
  onChange: (tagIds: string[]) => void;
  allowCreate?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  testIdBase?: string;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [query, setQuery] = useState("");

  const tagsQuery = trpc.bookingTags.list.useQuery(
    { orgId },
    { staleTime: 60_000, retry: 1 },
  );
  const options = useMemo<BookingTagOption[]>(
    () =>
      (tagsQuery.data?.tags ?? []).map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
      })),
    [tagsQuery.data?.tags],
  );
  const byId = useMemo(() => {
    const map = new Map<string, BookingTagOption>();
    for (const tag of options) map.set(tag.id, tag);
    return map;
  }, [options]);

  const selected = useMemo(
    () =>
      value
        .map((id) => byId.get(id))
        .filter((tag): tag is BookingTagOption => Boolean(tag)),
    [byId, value],
  );

  const createMutation = trpc.bookingTags.create.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const add = useCallback(
    (id: string) => {
      // Clear the query either way — re-picking a tag already on the row
      // must not leave its name sitting in the box.
      setQuery("");
      if (value.includes(id)) return;
      onChange([...value, id]);
    },
    [onChange, value],
  );

  const remove = useCallback(
    (id: string) => onChange(value.filter((v) => v !== id)),
    [onChange, value],
  );

  const create = useCallback(
    (rawName: string) => {
      const name = normalizeName(rawName);
      if (!allowCreate || name.length < 1 || createMutation.isPending) return;
      // An exact (case-insensitive) match already exists → select it instead
      // of minting a duplicate the server would reject.
      const existing = options.find(
        (tag) => tag.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        add(existing.id);
        return;
      }
      createMutation.mutate(
        { orgId, name, color: "neutral" },
        {
          onSuccess: ({ tag }) => {
            void utils.bookingTags.list.invalidate({ orgId });
            add(tag.id);
          },
          onError: (err) => {
            toast.danger({
              id: "booking-tag-create-failed",
              title: String(t("admin.bkTagCreateFailed")),
              message: formatErrorMessage(err, t),
            });
          },
        },
      );
    },
    [add, allowCreate, createMutation, options, orgId, t, toast, utils.bookingTags.list],
  );

  const sections = useMemo<AutocompleteSection<PickerItem>[]>(() => {
    const q = normalizeName(query).toLowerCase();
    const chosen = new Set(value);
    const matches = options
      .filter((tag) => !chosen.has(tag.id))
      .filter((tag) => q.length === 0 || tag.name.toLowerCase().includes(q))
      .slice(0, 12)
      .map<PickerItem>((tag) => ({ type: "tag", id: `tag-${tag.id}`, tag }));
    const out: AutocompleteSection<PickerItem>[] = [];
    if (matches.length > 0) {
      out.push({ id: "tag-matches", title: undefined, items: matches });
    }
    const exact = options.some((tag) => tag.name.toLowerCase() === q);
    if (allowCreate && q.length >= 1 && !exact) {
      out.push({
        id: "tag-create",
        title: undefined,
        items: [{ type: "create", id: `tag-create-${q}`, name: normalizeName(query) }],
      });
    }
    return out;
  }, [allowCreate, options, query, value]);

  const renderRow = useCallback(
    ({
      suggestion,
      onSelect,
      testId,
      active,
    }: {
      suggestion: PickerItem;
      onSelect: () => void;
      testId: string;
      active: boolean;
    }): ReactNode => (
      <Row
        variant="ghost"
        size="$2"
        onPress={onSelect}
        testID={testId}
        disabled={suggestion.type === "create" && createMutation.isPending}
        backgroundColor={active ? "$surfaceRaised" : "transparent"}
        borderLeftColor={active ? "$accent" : "transparent"}
      >
        <XStack width="100%" alignItems="center" gap="$2" minWidth={0}>
          {suggestion.type === "create" ? (
            <Plus size={14} color={theme.accent?.val} aria-hidden />
          ) : (
            <TagIcon size={14} color={theme.colorMuted?.val} aria-hidden />
          )}
          <Text
            variant="bodySmall"
            weight="semibold"
            truncate
            textAlign="left"
            fontSize={12}
            lineHeight={14}
            textTransform="none"
          >
            {suggestion.type === "create"
              ? String(t("admin.bkTagCreateOption", { name: suggestion.name }))
              : suggestion.tag.name}
          </Text>
        </XStack>
      </Row>
    ),
    [createMutation.isPending, t, theme.accent?.val, theme.colorMuted?.val],
  );

  return (
    <YStack gap="$2" minWidth={0} data-testid={testIdBase}>
      {selected.length > 0 ? (
        <XStack gap="$2" flexWrap="wrap" data-testid={`${testIdBase}-chips`}>
          {selected.map((tag) => (
            <BookingTagChip
              key={tag.id}
              name={tag.name}
              color={tag.color}
              testId={`${testIdBase}-chip-${tag.id}`}
              {...(disabled
                ? {}
                : {
                    onRemove: () => remove(tag.id),
                    removeLabel: String(t("admin.bkTagRemove", { name: tag.name })),
                  })}
            />
          ))}
        </XStack>
      ) : null}
      {/* Stays MOUNTED while disabled (a write in flight): unmounting the
          field mid-keystroke drops focus to <body>. */}
      {
        <AutocompleteField<PickerItem>
          query={query}
          onQueryChange={setQuery}
          data={{ sections }}
          getSuggestionId={(s) => s.id}
          renderRow={renderRow}
          onSelectSuggestion={(s) => {
            if (s.type === "tag") add(s.tag.id);
            else create(s.name);
          }}
          onSubmitQuery={(raw) => {
            const q = normalizeName(raw).toLowerCase();
            const exact = options.find((tag) => tag.name.toLowerCase() === q);
            if (exact) add(exact.id);
            else if (allowCreate) create(raw);
          }}
          placeholder={placeholder ?? String(t("admin.bkTagPlaceholder"))}
          loading={tagsQuery.isLoading || createMutation.isPending}
          loadingLabel={String(t("common.loading"))}
          emptyState={
            tagsQuery.isError ? (
              <Text variant="bodySmall" tone="error">
                {formatErrorMessage(tagsQuery.error, t)}
              </Text>
            ) : query.trim().length > 0 || options.length === 0 ? (
              <Text variant="bodySmall" tone="muted">
                {String(
                  t(allowCreate ? "admin.bkTagNoMatchesCreate" : "admin.bkTagNoMatches"),
                )}
              </Text>
            ) : null
          }
          inputProps={{
            maxLength: NAME_MAX,
            autoComplete: "off",
            disabled,
            "aria-label": ariaLabel ?? String(t("admin.bkTagInputLabel")),
          }}
          testIdBase={`${testIdBase}-field`}
          dropdownOverlay
          dropdownZIndex={1200}
          dropdownTone="surface"
        />
      }
    </YStack>
  );
}
