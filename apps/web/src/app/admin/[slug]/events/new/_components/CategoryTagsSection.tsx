"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTheme, XStack, YStack, styled } from "tamagui";
import { Check, ChevronDown, Hash, Plus, X } from "lucide-react";

import {
  AutocompleteField,
  Button,
  Text,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";
import type { AutocompleteSection } from "@th/ui";
import { keepPreviousData } from "@tanstack/react-query";
import { Field, FieldLabel } from "./_form-bits";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  categoryDisplayName,
  withCategoryDisplayNames,
} from "@/lib/category-display-name";
import {
  type CategoryNameIssue,
  categorySlugNameIssue,
  deriveCategorySlug,
  normalizeCategoryName,
} from "@th/types/category-name-rules";
import { isCategoryNameLocale } from "@th/types";
import {
  filterCategoryOptions,
  optionHasName,
  queryIsCommittedSelection,
  resolveHydratedCategory,
} from "./category-picker-helpers";

// ── Styled primitives ────────────────────────────────────────────────────────

const SectionContainer = styled(YStack, {
  gap: 10,
  width: "100%",
});

const SuggestionButton = styled(Button, {
  justifyContent: "flex-start",
  alignItems: "stretch",
  width: "100%",
  borderRadius: 0,
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  // Compact list row — like a typeahead command palette, not a giant menu.
  // 0px vertical padding + 20px minHeight packs the rows close together.
  paddingHorizontal: "$2",
  paddingVertical: 0,
  minHeight: 20,
  // Row-targeting states use the raised wash, never `$surfaceStrong`: that
  // token resolves to the ink itself on Stub (#211C16 === `$color`), and these
  // rows render default-ink <Text>, so the fill collapsed the label to 1.00:1.
  // The accent left border is the affordance (v2 `.chip:hover` contract), and
  // `$surfaceRaised` matches the ghost variant's own hover fill, so hover /
  // press / focus / keyboard-active stay one coherent "targeted row" language
  // regardless of how Tamagui resolves base-vs-variant precedence.
  // NOTE: `active` here is the keyboard cursor, not the chosen value — the
  // chosen value is `selected`, which is marked by the Check icon + accent
  // border. So this fill is a cursor affordance, not a selected-state signal.
  focusVisibleStyle: {
    outlineWidth: 0,
    backgroundColor: "$surfaceRaised",
    borderLeftColor: "$accent",
  },
  hoverStyle: {
    backgroundColor: "$surfaceRaised",
    borderLeftColor: "$accent",
  },
  pressStyle: {
    backgroundColor: "$surfaceRaised",
    borderLeftColor: "$accent",
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$surfaceRaised",
        borderLeftColor: "$accent",
      },
    },
  },
});

const SuggestionBody = styled(XStack, {
  width: "100%",
  alignItems: "center",
  gap: "$2",
  minWidth: 0,
});

const SuggestionText = styled(YStack, {
  flex: 1,
  minWidth: 0,
  gap: 0,
});

const DropdownHandle = styled(XStack, {
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
});

/** Shared row primitive used by the Category and Tag pickers.
 * One source of truth for the compact typeahead row style. */
type PickerRowProps = {
  onSelect: () => void;
  testId: string;
  active: boolean;
  selected?: boolean;
  disabled?: boolean;
  leadingIcon?: ReactNode;
  title: string;
  subtitle?: string | null;
};

const PickerRow = memo(function PickerRow({
  onSelect,
  testId,
  active,
  selected = false,
  disabled = false,
  leadingIcon,
  title,
  subtitle,
}: PickerRowProps) {
  return (
    <SuggestionButton
      variant="ghost"
      size="$2"
      onPress={onSelect}
      testID={testId}
      disabled={disabled}
      backgroundColor={active ? "$surfaceRaised" : "transparent"}
      borderLeftColor={active || selected ? "$accent" : "transparent"}
    >
      <SuggestionBody>
        {leadingIcon}
        <SuggestionText>
          <Text
            variant="bodySmall"
            weight="semibold"
            truncate
            textAlign="left"
            fontSize={12}
            lineHeight={14}
            textTransform="none"
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              variant="caption"
              tone="muted"
              truncate
              textAlign="left"
              fontSize={11}
              lineHeight={14}
            >
              {subtitle}
            </Text>
          ) : null}
        </SuggestionText>
      </SuggestionBody>
    </SuggestionButton>
  );
});

type CategoryPickerItem =
  | {
      type: "category";
      id: string;
      slug: string;
      name: string;
      active: boolean;
    }
  | {
      type: "request";
      id: string;
      name: string;
      slug: string;
      requestKind: "CATEGORY";
    };

type TagPickerItem =
  | { type: "tag"; id: string; slug: string; name: string }
  | { type: "create"; id: string; slug: string; name: string };

type RequestNameIssue = CategoryNameIssue | null;

// The name rules live in one copy (`@th/types/category-name-rules`), the one
// the server enforces and /platform/categories checks too.
const normalizeRequestName = normalizeCategoryName;
const toRequestSlug = deriveCategorySlug;

/** Tag slug — reuses the same diacritic-safe pipeline as category requests,
    then clamps to the 48-char DB limit. */
const toTagSlug = (name: string): string => toRequestSlug(name).slice(0, 48);

// A request names the category its slug derives from, so the slug rules
// apply on top of the word rules.
const getRequestNameIssue = (raw: string): RequestNameIssue =>
  categorySlugNameIssue(raw);

type NamedOption = {
  name: string;
  slug: string;
  names?: Partial<Record<string, string>> | null;
};

// A name in any of the category's languages counts as an exact match, so
// typing "Música" never offers to request a category that already exists.
const hasExactOption = (options: NamedOption[], query: string) => {
  const normalizedName = normalizeRequestName(query);
  const normalizedSlug = toRequestSlug(query);
  return options.some(
    (option) =>
      optionHasName(option, normalizedName) || option.slug === normalizedSlug,
  );
};

// ── Toast-wrapped mutation runner ────────────────────────────────────────────
type ToastApi = ReturnType<typeof useNotify>["toast"];
type Translator = ReturnType<typeof useTranslations>;
/**
 * `t` is threaded in rather than read from a hook because this runner lives at
 * module scope. Without it `formatErrorMessage` never consults the `errors.*`
 * catalog, and every refusal the server sends back — `CATEGORY_ALREADY_EXISTS`,
 * `INVALID_CATEGORY_REQUEST_NAME` — renders as the generic "Something went
 * wrong" instead of the reason.
 */
async function runWithToasts<T>(
  toast: ToastApi,
  t: Translator,
  action: () => Promise<T>,
  successId: string,
  successTitle: string,
  failureId: string,
  failureTitle: string,
): Promise<T | undefined> {
  try {
    const result = await action();
    toast.success({ id: successId, title: successTitle, message: "" });
    return result;
  } catch (error) {
    toast.danger({
      id: failureId,
      title: failureTitle,
      message: formatErrorMessage(error, t),
    });
    return undefined;
  }
}

/** Pure: find an exact name/slug match in a list. Powers the Enter-to-submit
 * pathway for the Category picker. */
function findExactOption<T extends NamedOption>(
  items: T[],
  query: string,
): T | undefined {
  const normalizedName = normalizeRequestName(query);
  const normalizedSlug = toRequestSlug(query);
  return items.find(
    (item) =>
      optionHasName(item, normalizedName) || item.slug === normalizedSlug,
  );
}

/** Restore the category input back to its committed selection on blur if the
 * user typed something invalid and didn't pick a row. */
function scheduleQueryRestore(opts: {
  selected: { name: string } | null | undefined;
  query: string;
  canRequest: boolean;
  setQuery: (v: string) => void;
}): void {
  window.setTimeout(() => {
    if (!opts.selected) return;
    const hasExact =
      normalizeRequestName(opts.query).toLowerCase() ===
      opts.selected.name.toLowerCase();
    if (!opts.canRequest && !hasExact) opts.setQuery(opts.selected.name);
  }, 120);
}

// ── Props ────────────────────────────────────────────────────────────────────

export type CategoryTagsSectionProps = {
  eventId: string;
};

// ── Component ────────────────────────────────────────────────────────────────

export function CategoryTagsSection({ eventId }: CategoryTagsSectionProps) {
  const theme = useTheme();
  const t = useTranslations();
  const locale = useLocale();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // ── Local state ──
  const [selectedCategorySlug, setSelectedCategorySlug] = useState("");
  const [categoryQuery, setCategoryQuery] = useState("");
  const [tags, setTags] = useState<Array<{ slug: string; name: string }>>([]);
  const [tagSearch, setTagSearch] = useState("");

  // ── Queries ──
  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  // `name` is the organiser's language from here on; `names` keeps every
  // language for the typeahead. The category is saved by slug.
  const categories = useMemo(
    () =>
      withCategoryDisplayNames(categoriesQuery.data?.categories ?? [], locale),
    [categoriesQuery.data?.categories, locale],
  );

  const eventForEditQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  const eventTagsQuery = trpc.tags.getEventTags.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  const tagSearchQuery = trpc.tags.search.useQuery(
    { query: tagSearch, limit: 10 },
    { enabled: tagSearch.length >= 1, placeholderData: keepPreviousData },
  );

  // Joined category from getEventForEdit — the only client-side source for a
  // category that has since been DEACTIVATED (categories.list is active-only).
  // Its name is read in the organiser's language from `names`, like the
  // active list's.
  const serverCategory = eventForEditQuery.data?.category ?? null;
  const serverCategoryId = serverCategory?.id;
  const serverCategorySlug = serverCategory?.slug;
  const serverCategoryName = serverCategory
    ? categoryDisplayName(serverCategory, locale)
    : undefined;

  const selectedCategory = useMemo(() => {
    const active = categories.find(
      (category) => category.slug === selectedCategorySlug,
    );
    if (active) return active;
    // Fall back to the server-joined summary so an inactive current
    // selection still behaves as "committed" (name shown in the input, full
    // list on open, blur restore) instead of reading as free text.
    // Depend on the PRIMITIVE fields, not the joined object: a
    // getEventForEdit refetch returns a fresh object literal, and a new
    // identity here re-fires the query-sync effect below, wiping a
    // mid-typed replacement query.
    if (
      serverCategoryId !== undefined &&
      serverCategorySlug !== undefined &&
      serverCategoryName !== undefined &&
      serverCategorySlug === selectedCategorySlug
    ) {
      return {
        id: serverCategoryId,
        slug: serverCategorySlug,
        name: serverCategoryName,
      };
    }
    return undefined;
  }, [
    categories,
    selectedCategorySlug,
    serverCategoryId,
    serverCategorySlug,
    serverCategoryName,
  ]);

  const categoryRequestName = normalizeRequestName(categoryQuery);
  const categoryRequestIssue = getRequestNameIssue(categoryRequestName);
  const canRequestCategory = Boolean(
    categoryRequestName &&
    !categoryRequestIssue &&
    !hasExactOption(categories, categoryRequestName) &&
    // Never offer to "request" the name of the already-committed selection
    // — reachable when the committed category is inactive (its name is in
    // the input but absent from the active list).
    !queryIsCommittedSelection(categoryQuery, selectedCategory?.name),
  );

  const categorySections = useMemo<
    AutocompleteSection<CategoryPickerItem>[]
  >(() => {
    // When the query is still exactly the committed selection's name (the
    // hydrate/select paths copy it into the input), the user hasn't typed
    // anything — show the FULL list like a select, with the chosen row
    // marked, instead of filtering down to the single selected entry.
    const matches = filterCategoryOptions({
      categories,
      query: categoryQuery,
      selectedName: selectedCategory?.name ?? null,
    }).map<CategoryPickerItem>((c) => ({ type: "category" as const, ...c }));

    const sections: AutocompleteSection<CategoryPickerItem>[] = [];
    if (matches.length > 0) {
      sections.push({
        id: "categories",
        title: String(t("admin.ebCategoryMatches")),
        items: matches,
      });
    }
    if (canRequestCategory) {
      const slug = toRequestSlug(categoryRequestName);
      sections.push({
        id: "request-category",
        title: String(t("admin.ebCategoryMissing")),
        items: [
          {
            type: "request" as const,
            id: `request-category-${slug}`,
            name: categoryRequestName,
            slug,
            requestKind: "CATEGORY" as const,
          },
        ],
      });
    }
    return sections;
  }, [
    canRequestCategory,
    categories,
    categoryQuery,
    categoryRequestName,
    selectedCategory?.name,
    t,
  ]);

  const tagSections = useMemo<AutocompleteSection<TagPickerItem>[]>(() => {
    const trimmed = tagSearch.trim();
    const existingSlugs = new Set(tags.map((t) => t.slug));
    const sections: AutocompleteSection<TagPickerItem>[] = [];

    const matches = (tagSearchQuery.data?.tags ?? [])
      .filter((s) => !existingSlugs.has(s.slug))
      .slice(0, 8)
      .map<TagPickerItem>((s) => ({
        type: "tag",
        id: `tag-${s.slug}`,
        slug: s.slug,
        name: s.name,
      }));
    if (matches.length > 0) {
      sections.push({ id: "tag-matches", title: undefined, items: matches });
    }

    // "Create new" row when the query isn't an existing tag and slugifies
    // to something usable.
    const newSlug = toTagSlug(trimmed);
    const hasExactMatch = (tagSearchQuery.data?.tags ?? []).some(
      (s) => s.slug === newSlug,
    );
    if (
      trimmed.length >= 2 &&
      newSlug.length >= 2 &&
      !existingSlugs.has(newSlug) &&
      !hasExactMatch
    ) {
      sections.push({
        id: "tag-create",
        title: undefined,
        items: [
          {
            type: "create",
            id: `tag-create-${newSlug}`,
            slug: newSlug,
            name: trimmed,
          },
        ],
      });
    }

    return sections;
  }, [tagSearch, tags, tagSearchQuery.data]);

  // ── Mutations ──
  const setCategoryMutation = trpc.categories.setEventCategory.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.events.getEventForEdit.invalidate({ eventId });
    },
  });

  const setTagsMutation = trpc.tags.setEventTags.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.tags.getEventTags.invalidate({ eventId });
    },
  });

  const requestOptionMutation = trpc.categories.requestOption.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.categories.listRequests.invalidate();
    },
  });

  // ── Hydrate from server data ──
  const hasHydratedCategory = useRef(false);
  useEffect(() => {
    if (hasHydratedCategory.current) return;
    const existing = eventForEditQuery.data;
    if (!existing?.categoryId || !categoriesQuery.data?.categories) return;
    // Prefer the ACTIVE list entry (its name already in the organiser's
    // language); fall back to the server-joined summary so a deactivated
    // category still hydrates (visible + replaceable) instead of leaving the
    // field blank, read in the organiser's language from its `names`.
    const cat = resolveHydratedCategory({
      categoryId: existing.categoryId,
      serverCategory: existing.category,
      activeCategories: categories,
      locale,
    });
    if (cat) {
      setSelectedCategorySlug(cat.slug);
      setCategoryQuery(cat.name);
      hasHydratedCategory.current = true;
    }
  }, [eventForEditQuery.data, categoriesQuery.data, categories, locale]);

  useEffect(() => {
    if (selectedCategory) setCategoryQuery(selectedCategory.name);
  }, [selectedCategory]);

  const hasHydratedTags = useRef(false);
  useEffect(() => {
    if (hasHydratedTags.current || !eventTagsQuery.data) return;
    const existing = eventTagsQuery.data.tags;
    if (existing.length > 0) {
      setTags(existing.map((tag) => ({ slug: tag.slug, name: tag.name })));
      hasHydratedTags.current = true;
    }
  }, [eventTagsQuery.data]);

  // ── Handlers ──
  const handleCategoryChange = useCallback(
    async (slug: string) => {
      if (!slug) return;
      const nextCategory = categories.find((c) => c.slug === slug);
      setSelectedCategorySlug(slug);
      setCategoryQuery(nextCategory?.name ?? "");
      await runWithToasts(
        toast,
        t,
        () => setCategoryMutation.mutateAsync({ eventId, categorySlug: slug }),
        "category-updated",
        String(t("admin.ebCategoryUpdated")),
        "category-update-failed",
        String(t("admin.ebCategoryUpdateFailed")),
      );
    },
    [categories, eventId, setCategoryMutation, toast, t],
  );

  const persistTags = useCallback(
    async (nextTags: Array<{ slug: string; name: string }>) => {
      // No success toast — tag edits are inline; only surface failures.
      try {
        await setTagsMutation.mutateAsync({ eventId, tags: nextTags });
      } catch (error) {
        toast.danger({
          id: "tags-update-failed",
          title: String(t("admin.ebTagsUpdateFailed")),
          message: formatErrorMessage(error, t),
        });
      }
    },
    [eventId, setTagsMutation, toast, t],
  );

  const handleRequestCategory = useCallback(
    async (rawName: string) => {
      const name = normalizeRequestName(rawName);
      if (getRequestNameIssue(name) || hasExactOption(categories, name)) return;
      const result = await runWithToasts(
        toast,
        t,
        () =>
          requestOptionMutation.mutateAsync({
            eventId,
            kind: "CATEGORY",
            name,
            // The organiser's UI language, taken as the request's language
            // so staff approve it under that name (category-translations
            // FR-007).
            ...(isCategoryNameLocale(locale) ? { locale } : {}),
          }),
        "category-request-sent",
        String(t("admin.ebCategoryRequestSuccess")),
        "category-request-failed",
        String(t("admin.ebCategoryRequestFailed")),
      );
      if (result) setCategoryQuery(selectedCategory?.name ?? "");
    },
    [
      categories,
      eventId,
      locale,
      requestOptionMutation,
      selectedCategory,
      toast,
      t,
    ],
  );

  const handleCategorySuggestion = useCallback(
    (item: CategoryPickerItem) => {
      if (item.type === "category") {
        void handleCategoryChange(item.slug);
        return;
      }
      void handleRequestCategory(item.name);
    },
    [handleCategoryChange, handleRequestCategory],
  );

  const handleCategorySubmit = useCallback(
    (query: string) => {
      const exact = findExactOption(categories, query);
      if (exact) {
        void handleCategoryChange(exact.slug);
        return;
      }
      if (canRequestCategory) void handleRequestCategory(query);
    },
    [
      canRequestCategory,
      categories,
      handleCategoryChange,
      handleRequestCategory,
    ],
  );

  const restoreCategoryQuery = useCallback(() => {
    scheduleQueryRestore({
      selected: selectedCategory,
      query: categoryQuery,
      canRequest: canRequestCategory,
      setQuery: setCategoryQuery,
    });
  }, [canRequestCategory, categoryQuery, selectedCategory]);

  const getRequestIssueMessage = useCallback(
    (issue: RequestNameIssue) => {
      if (issue === "too_short")
        return String(t("admin.ebRequestNameTooShort"));
      if (issue === "too_long") return String(t("admin.ebRequestNameTooLong"));
      if (issue === "unsupported_characters")
        return String(t("admin.ebRequestNameInvalid"));
      if (issue === "link_or_handle")
        return String(t("admin.ebRequestNameLinkOrHandle"));
      if (issue === "repeated_characters")
        return String(t("admin.ebRequestNameRepeatedCharacters"));
      return String(t("admin.ebCategoryNoMatches"));
    },
    [t],
  );

  const renderCategoryRow = useCallback(
    ({
      suggestion,
      onSelect,
      testId,
      active,
    }: {
      suggestion: CategoryPickerItem;
      onSelect: () => void;
      testId: string;
      active: boolean;
    }) => {
      const isSelected =
        suggestion.type === "category" &&
        suggestion.slug === selectedCategorySlug;
      const leadingIcon =
        suggestion.type === "request" ? (
          <Plus size={14} color={theme.accent?.val} />
        ) : isSelected ? (
          <Check size={14} color={theme.accent?.val} />
        ) : null;
      return (
        <PickerRow
          onSelect={onSelect}
          testId={testId}
          active={active}
          selected={isSelected}
          disabled={
            suggestion.type === "request" && requestOptionMutation.isPending
          }
          leadingIcon={leadingIcon}
          title={
            suggestion.type === "request"
              ? String(
                  t("admin.ebRequestCategoryOption", { name: suggestion.name }),
                )
              : suggestion.name
          }
          subtitle={
            suggestion.type === "request"
              ? String(t("admin.ebRequestReviewNote"))
              : null
          }
        />
      );
    },
    [
      requestOptionMutation.isPending,
      selectedCategorySlug,
      t,
      theme.accent?.val,
    ],
  );

  const handleAddTag = useCallback(
    (slug: string, name: string) => {
      setTags((prev) => {
        if (prev.length >= 10) return prev;
        if (prev.some((existing) => existing.slug === slug)) return prev;
        const next = [...prev, { slug, name }];
        void persistTags(next);
        return next;
      });
      setTagSearch("");
    },
    [persistTags],
  );

  const handleTagSuggestion = useCallback(
    (suggestion: TagPickerItem) => {
      handleAddTag(suggestion.slug, suggestion.name);
    },
    [handleAddTag],
  );

  const renderTagRow = useCallback(
    ({
      suggestion,
      onSelect,
      testId,
      active,
    }: {
      suggestion: TagPickerItem;
      onSelect: () => void;
      testId: string;
      active: boolean;
    }) => {
      const leadingIcon =
        suggestion.type === "create" ? (
          <Plus size={14} color={theme.accent?.val} />
        ) : (
          <Hash size={14} color={theme.colorMuted?.val} />
        );
      return (
        <PickerRow
          onSelect={onSelect}
          testId={testId}
          active={active}
          leadingIcon={leadingIcon}
          title={
            suggestion.type === "create"
              ? String(t("admin.ebCreateTag", { name: suggestion.name }))
              : suggestion.name
          }
        />
      );
    },
    [t, theme.accent?.val, theme.colorMuted?.val],
  );

  const handleRemoveTag = useCallback(
    (slug: string) => {
      setTags((prev) => {
        const next = prev.filter((existing) => existing.slug !== slug);
        void persistTags(next);
        return next;
      });
    },
    [persistTags],
  );

  return (
    <SectionContainer data-testid="category-tags-section">
      <Field>
        <FieldLabel required>{String(t("admin.ebCategory"))}</FieldLabel>
        <AutocompleteField<CategoryPickerItem>
          query={categoryQuery}
          onQueryChange={setCategoryQuery}
          data={{ sections: categorySections }}
          getSuggestionId={(suggestion) => suggestion.id}
          renderRow={renderCategoryRow}
          onSelectSuggestion={handleCategorySuggestion}
          onSubmitQuery={handleCategorySubmit}
          placeholder={t("admin.ebCategorySearchPlaceholder") as string}
          loading={categoriesQuery.isLoading || setCategoryMutation.isPending}
          loadingLabel={String(t("admin.ebCategoryLoading"))}
          emptyState={
            categoryQuery.trim().length > 0 ? (
              <Text variant="bodySmall" tone="muted">
                {getRequestIssueMessage(categoryRequestIssue)}
              </Text>
            ) : null
          }
          inputProps={{
            required: true,
            maxLength: 80,
            autoComplete: "off",
            onBlur: restoreCategoryQuery,
          }}
          testIdBase="event-category-picker"
          trailingAccessory={
            <DropdownHandle aria-hidden>
              <ChevronDown size={16} color={theme.colorMuted?.val} />
            </DropdownHandle>
          }
          dropdownOverlay
          // This field sits low in the form, so the open category menu
          // would otherwise expand behind the admin shell's fixed bottom bar.
          // Lift the overlay above it so the dropdown is never obscured.
          dropdownZIndex={1200}
          dropdownTone="surface"
        />
      </Field>

      <Field>
        <FieldLabel optional>{String(t("admin.ebTags"))}</FieldLabel>
        <Text variant="caption" tone="muted">
          {String(t("admin.ebTagsHint"))}
        </Text>

        {/* Current tags */}
        {tags.length > 0 && (
          <XStack flexWrap="wrap" gap={8} marginTop={4}>
            {tags.map((tag) => (
              <XStack
                key={tag.slug}
                backgroundColor="$surfaceStrong"
                paddingHorizontal={10}
                paddingVertical={4}
                borderRadius={0}
                alignItems="center"
                gap={6}
              >
                {/* Solid `$surfaceStrong` chip — on Stub this fill IS the ink
                    (#211C16 === `$color`), so every foreground inside it must
                    be inverted to `$onStructure` or the chip renders as a solid
                    black rectangle (label 1.00:1, icons 2.27:1). */}
                <Hash size={12} color={theme.onStructure?.val} />
                <Text variant="bodySmall" color="$onStructure">
                  {tag.name}
                </Text>
                <XStack
                  cursor="pointer"
                  onPress={() => handleRemoveTag(tag.slug)}
                  padding={2}
                  hoverStyle={{ opacity: 0.7 }}
                  data-testid={`remove-tag-${tag.slug}`}
                >
                  <X size={12} color={theme.onStructure?.val} />
                </XStack>
              </XStack>
            ))}
          </XStack>
        )}

        {/* Tag search / create — multi-select via clear-after-pick: each
            selection adds a chip + clears the query, so the user can keep
            typing to add another. */}
        {tags.length < 10 && (
          <YStack marginTop={8}>
            <AutocompleteField<TagPickerItem>
              query={tagSearch}
              onQueryChange={setTagSearch}
              data={{ sections: tagSections }}
              getSuggestionId={(suggestion) => suggestion.id}
              renderRow={renderTagRow}
              onSelectSuggestion={handleTagSuggestion}
              // Enter on raw text → treat as "create-new" so a user can
              // just type a tag and hit return without scrolling to the
              // suggestion row.
              onSubmitQuery={(raw) => {
                const trimmed = raw.trim();
                const newSlug = toTagSlug(trimmed);
                if (trimmed.length < 2 || newSlug.length < 2) return;
                if (tags.some((t) => t.slug === newSlug)) return;
                handleAddTag(newSlug, trimmed);
              }}
              placeholder={t("admin.ebTagsPlaceholder") as string}
              // Only show "Searching…" once the user has actually typed —
              // otherwise React Query reports pending for the disabled
              // query and the field looks stuck on first render.
              loading={tagSearch.length >= 1 && tagSearchQuery.isFetching}
              emptyState={
                tagSearch.length >= 1 ? (
                  <Text variant="bodySmall" tone="muted">
                    {String(t("admin.ebNoTagResults"))}
                  </Text>
                ) : null
              }
              inputProps={{ maxLength: 64, autoComplete: "off" }}
              testIdBase="tag-picker"
              dropdownOverlay
              // Same rationale as the category picker above — keep the open tag
              // menu above the fixed contextual action bar (z-index 1100).
              dropdownZIndex={1200}
              dropdownTone="surface"
            />
          </YStack>
        )}
      </Field>
    </SectionContainer>
  );
}
