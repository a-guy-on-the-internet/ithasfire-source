"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { XStack, YStack, styled } from "tamagui";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import {
  Badge,
  Button,
  Spinner,
  StyledSelect,
  Text,
  TextInput,
  useTranslations,
} from "@th/ui";
import {
  EVENT_SCHEMA_TYPES,
  type CategoryNameLocale,
  type CategoryTranslationLocale,
  type EventSchemaType,
} from "@th/types";

import {
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CategoryNameField,
  NAME_LABEL_KEYS,
  translationErrorMessage,
  type TranslationError,
} from "./category-name-fields";
import {
  CategoryUrls,
  categoryPagePath,
  type CategoryUrl,
  type CategoryUrlEdits,
} from "./category-urls";
import {
  LanguageSelect,
  SuggestionNotice,
  useLanguageSelection,
  type LanguageRevealRequest,
} from "./language-select";

/** Why a category name was refused: taken, or not a name the rules accept. */
export type CategoryNameError = "exists" | "invalid";

export type CategoryMoveDirection = "up" | "down";

/** What a tile is busy asking: its rename editor, or one of its confirms. */
export type CategoryTileMode = "rename" | "delete" | "deactivate";

export interface CategoryTileCategory {
  id: string;
  slug: string;
  name: string;
  seoType: string;
  active: boolean;
  sortOrder: number;
  /** Every name the category has; absent from an older API. */
  names?: { en: string; es?: string };
  /** Every URL slug, current and old, per language (`listAll`). */
  urls?: readonly CategoryUrl[];
}

export { CATEGORY_NAME_MAX, CATEGORY_NAME_MIN };

// Internal-tool control: labels are the schema.org type names verbatim (proper
// nouns, not user-facing copy), so they stay hardcoded — no i18n keys needed.
export const SEO_TYPE_OPTIONS = EVENT_SCHEMA_TYPES.map((type) => ({
  value: type,
  label: type,
}));

/**
 * The SEO type select drawn like the text input it sits beside: same height,
 * same text size and left edge, same soft border and fill. `StyledSelect`'s
 * own defaults (ink border, clear fill, 12px inset, 16px text at `lg`) made
 * it the one heavy box in a row of quiet ones.
 *
 * The border and fill tokens mirror what the input is painted with on the
 * web, which is not `TextInput`'s own `$surface` / `$borderColor`: the
 * native-input rule in `apps/web/src/app/globals.css` (the
 * `input:not(...), textarea, select` block, lines 426-444) repaints every
 * input with `--background` and a 2px `--borderColorSoft` border at a
 * specificity Tamagui props cannot beat. Measured equal in both themes:
 * Stub rgb(246, 240, 228) / rgba(33, 28, 22, 0.3), Ember rgb(15, 27, 51) /
 * rgba(90, 120, 166, 0.4), 2px each.
 */
export const SELECT_FRAME_PROPS = {
  fullWidth: true,
  size: "md",
  borderRadius: 0,
  height: 44,
  minHeight: 44,
  paddingHorizontal: 14,
  borderColor: "$borderColorSoft",
  backgroundColor: "$background",
} as const;

export const categoryNameErrorKey = (error: CategoryNameError) =>
  error === "exists"
    ? ("admin.pcAddErrorExists" as const)
    : ("admin.pcAddErrorInvalidName" as const);

/** DOM ids the page focuses by, one set per category. */
export const categoryTileIds = (categoryId: string) => ({
  tile: `platform-category-tile-${categoryId}`,
  renameInput: `platform-category-rename-${categoryId}`,
  renameEsInput: `platform-category-rename-es-${categoryId}`,
  renameHelp: `platform-category-rename-help-${categoryId}`,
  renameError: `platform-category-rename-error-${categoryId}`,
  renameButton: `platform-category-rename-button-${categoryId}`,
  activeButton: `platform-category-active-button-${categoryId}`,
  deleteButton: `platform-category-delete-button-${categoryId}`,
  moveUp: `platform-category-move-up-${categoryId}`,
  moveDown: `platform-category-move-down-${categoryId}`,
  confirmCancel: `platform-category-confirm-cancel-${categoryId}`,
  seoTypeSelect: `platform-category-seo-type-${categoryId}`,
  languageSelect: `platform-category-language-${categoryId}`,
});

/**
 * The editor's name field for one language: English keeps its original id,
 * every other language is `platform-category-rename-<locale>-<id>`
 * (`renameEsInput` for Spanish).
 */
export const renameFieldId = (
  categoryId: string,
  locale: CategoryNameLocale,
): string =>
  locale === "en"
    ? categoryTileIds(categoryId).renameInput
    : `platform-category-rename-${locale}-${categoryId}`;

/**
 * Every category id, each once, with one of them moved a place up or down:
 * what `categories.reorder` takes. `null` when there is nowhere to move to
 * (the id is not in the list, or it is already at that edge).
 */
export function movedCategoryIds(
  orderedCategoryIds: readonly string[],
  categoryId: string,
  direction: CategoryMoveDirection,
): string[] | null {
  const from = orderedCategoryIds.indexOf(categoryId);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= orderedCategoryIds.length) return null;
  const next = [...orderedCategoryIds];
  next.splice(from, 1);
  next.splice(to, 0, categoryId);
  return next;
}

const TileFrame = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  borderRadius: 0,
  padding: 16,
  gap: 12,
  // A grid item: it takes its column's width and may go narrower than its
  // content, so a phone-width column never pushes the page sideways.
  minWidth: 0,
});

const LABEL_STYLE = { display: "flex" } as const;

// Every tile action is a 44px target; the label keeps the compact size.
const ACTION_BUTTON_PROPS = {
  size: "$3",
  height: 44,
  minHeight: 44,
} as const;

// A confirm's own button carries a longer label ("Deactivate category"). In a
// phone-width tile it wraps inside the tile and the button grows to hold it,
// where a one-line label ran out past the tile's border.
const CONFIRM_BUTTON_PROPS = {
  ...ACTION_BUTTON_PROPS,
  height: "auto",
  maxWidth: "100%",
  paddingVertical: 4,
  textProps: { whiteSpace: "normal", lineHeight: 16 },
} as const;

export interface CategoryTileProps {
  category: CategoryTileCategory;
  isFirst: boolean;
  isLast: boolean;
  /** Rename, deactivate / reactivate and reorder (ADMIN / DEVELOPER). */
  canManage: boolean;
  canDelete: boolean;
  canEditSeoType: boolean;
  /** The one thing this tile is asking right now, if anything. */
  mode: CategoryTileMode | null;
  /** True when another tile has its editor or a confirm open. */
  modeElsewhere: boolean;
  /**
   * True while a rename, a deactivate / reactivate or a delete is out, on any
   * tile: Rename, Deactivate / Reactivate and Delete wait for the reply, so a
   * second editor or confirm cannot open under it.
   */
  openersBlocked: boolean;
  renameValue: string;
  renameError: CategoryNameError | null;
  renamePending: boolean;
  onRenameOpen: () => void;
  onRenameChange: (value: string) => void;
  /** The English field lost focus: ask for a Spanish suggestion now. */
  onRenameBlur?: () => void;
  onRenameSave: () => void;
  /** The editor's Spanish name, as typed or suggested. */
  translationValue: string;
  /** True while the Spanish name is an untouched machine suggestion. */
  translationSuggested: boolean;
  /** True while that suggestion has not been on screen either. */
  translationUnreviewed: boolean;
  /** The Spanish field is on screen holding the suggestion. */
  onTranslationSeen: () => void;
  translationError: TranslationError | null;
  onTranslationChange: (value: string) => void;
  /** Show a language and focus its name field (a refusal landed). */
  revealRequest: LanguageRevealRequest | null;
  activePending: boolean;
  onDeactivateAsk: () => void;
  onSetActive: (active: boolean) => void;
  /** True while any reorder is out: every move button waits. */
  movePending: boolean;
  onMove: (direction: CategoryMoveDirection) => void;
  deleting: boolean;
  onDeleteAsk: () => void;
  onDeleteConfirm: () => void;
  /** Closes the rename editor or the open confirm. */
  onModeCancel: () => void;
  seoTypePending: boolean;
  onSeoTypeChange: (seoType: EventSchemaType) => void;
}

export function CategoryTile({
  category,
  isFirst,
  isLast,
  canManage,
  canDelete,
  canEditSeoType,
  mode,
  modeElsewhere,
  openersBlocked,
  renameValue,
  renameError,
  renamePending,
  onRenameOpen,
  onRenameChange,
  onRenameBlur,
  onRenameSave,
  translationValue,
  translationSuggested,
  translationUnreviewed,
  onTranslationSeen,
  translationError,
  onTranslationChange,
  revealRequest,
  activePending,
  onDeactivateAsk,
  onSetActive,
  movePending,
  onMove,
  deleting,
  onDeleteAsk,
  onDeleteConfirm,
  onModeCancel,
  seoTypePending,
  onSeoTypeChange,
}: CategoryTileProps) {
  const t = useTranslations();
  const ids = categoryTileIds(category.id);
  const { name } = category;
  const isRenaming = mode === "rename";
  const urls = category.urls ?? [];

  // One language at a time (R24). A refusal of a name whose language is not
  // shown brings that language forward and focuses its field.
  const { language, setLanguage, reveal } = useLanguageSelection({
    fieldId: (locale) => renameFieldId(category.id, locale),
    errors: {
      en: isRenaming && renameError !== null,
      es: isRenaming && translationError !== null,
    } satisfies Record<CategoryNameLocale, boolean>,
  });
  const languageRef = useRef(language);
  languageRef.current = language;
  const revealSeq = revealRequest?.seq;
  const revealLocale = revealRequest?.locale;
  useEffect(() => {
    if (revealLocale) reveal(revealLocale);
  }, [revealSeq, revealLocale, reveal]);

  // Open URL editors with their drafts: kept here, not in the URL block,
  // so a draft survives the names editor or a confirm taking its place.
  const [urlEdits, setUrlEdits] = useState<CategoryUrlEdits>({});

  // Focus follows the mode: into the shown language's name field when the
  // editor opens, onto Cancel (the safe answer) when a confirm opens, and
  // back to the button that opened an editor or a confirm when it closes.
  // The way back only runs when focus was dropped (the focused control
  // unmounted) and no other tile is opening its own editor or confirm: that
  // tile takes focus itself, and a stop here on the way could scroll the page.
  const previousModeRef = useRef<CategoryTileMode | null>(null);
  const categoryId = category.id;
  useEffect(() => {
    const tileIds = categoryTileIds(categoryId);
    const previous = previousModeRef.current;
    previousModeRef.current = mode;
    if (mode === previous) return;
    if (mode === "rename") {
      const input = document.getElementById(
        renameFieldId(categoryId, languageRef.current),
      );
      input?.focus();
      if (input instanceof HTMLInputElement) input.select();
      return;
    }
    if (mode !== null) {
      document.getElementById(tileIds.confirmCancel)?.focus();
      return;
    }
    if (previous === null || modeElsewhere) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const triggerId =
      previous === "rename"
        ? tileIds.renameButton
        : previous === "delete"
          ? tileIds.deleteButton
          : tileIds.activeButton;
    document.getElementById(triggerId)?.focus();
    // A change of `modeElsewhere` alone re-runs this and stops at the
    // `mode === previous` line above.
  }, [mode, categoryId, modeElsewhere]);

  const handleRenameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onRenameSave();
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape" || renamePending) return;
    event.preventDefault();
    onModeCancel();
  };

  const seoTypeLabel = String(t("admin.pcAddSeoTypeLabel"));
  const canSaveRename = renameValue.trim().length > 0 && !renamePending;

  /** The shown language's stored name, or null when it has none. */
  const storedName =
    language === "en" ? name : (category.names?.[language] ?? null);
  const page = categoryPagePath(urls, language, category.slug);
  // The rename note names the URL a rename leaves alone. A language with no
  // name has no URL of its own yet: adding the name makes one (FR-008).
  const slugNote =
    page.own || storedName !== null
      ? String(t("admin.pcRenameSlugNote", { slug: page.path }))
      : null;

  // The editor's other-language fields. Keyed by every translation locale,
  // so a language added to the app fails to compile here until it has one.
  const translationDrafts = {
    es: {
      value: translationValue,
      suggested: translationSuggested,
      unreviewed: translationUnreviewed,
      onSeen: onTranslationSeen,
      error: translationError,
      onChange: onTranslationChange,
    },
  } satisfies Record<
    CategoryTranslationLocale,
    {
      value: string;
      suggested: boolean;
      unreviewed: boolean;
      onSeen: () => void;
      error: TranslationError | null;
      onChange: (value: string) => void;
    }
  >;
  const unreviewed = {
    es: isRenaming && translationDrafts.es.unreviewed,
  } satisfies Record<CategoryTranslationLocale, boolean>;

  const renameForm = (
    <form
      onSubmit={handleRenameSubmit}
      // Capture phase: the text input stops keydown from bubbling
      // (react-native-web), so a bubble handler never sees Escape.
      onKeyDownCapture={handleRenameKeyDown}
      noValidate
      aria-label={String(t("admin.pcEditNamesNamed", { name }))}
      data-testid={`category-rename-form-${category.slug}`}
    >
      <YStack gap={4}>
        {language === "en" ? (
          <>
            <label htmlFor={ids.renameInput} style={LABEL_STYLE}>
              <Text variant="overline" tone="muted" tag="span">
                {String(t(NAME_LABEL_KEYS.en))}
              </Text>
            </label>
            <TextInput
              id={ids.renameInput}
              name="categoryRename"
              value={renameValue}
              onChangeText={onRenameChange}
              onBlur={onRenameBlur}
              // Enter saves: the form keeps every language's draft, so the
              // browser does not submit it by itself.
              onSubmitEditing={onRenameSave}
              fullWidth
              height={44}
              minHeight={44}
              maxLength={CATEGORY_NAME_MAX}
              autoComplete="off"
              required
              // Read-only, not disabled, while the request is out: the
              // reply is about the name that was sent.
              readOnly={renamePending}
              blurOnSubmit={false}
              status={renameError ? "error" : undefined}
              aria-invalid={renameError ? true : undefined}
              aria-describedby={
                [
                  renameError ? ids.renameError : null,
                  slugNote ? ids.renameHelp : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              testId={`category-rename-input-${category.slug}`}
            />
            {renameError ? (
              <Text
                id={ids.renameError}
                role="alert"
                variant="caption"
                tone="error"
              >
                {String(t(categoryNameErrorKey(renameError)))}
              </Text>
            ) : null}
          </>
        ) : (
          <CategoryNameField
            id={renameFieldId(category.id, language)}
            locale={language}
            value={translationDrafts[language].value}
            onChange={translationDrafts[language].onChange}
            onSubmitEditing={onRenameSave}
            isSuggested={translationDrafts[language].suggested}
            onSuggestionSeen={translationDrafts[language].onSeen}
            translateFrom={{ locale: "en", text: renameValue }}
            error={
              translationDrafts[language].error
                ? translationErrorMessage(t, translationDrafts[language].error)
                : null
            }
            describedBy={slugNote ? ids.renameHelp : undefined}
            readOnly={renamePending}
            testId={`category-rename-${language}-${category.slug}`}
          />
        )}
        {slugNote ? (
          <Text id={ids.renameHelp} variant="caption" tone="muted">
            {slugNote}
          </Text>
        ) : null}
        <XStack gap={8} flexWrap="wrap" paddingTop={4}>
          <Button
            variant="secondary"
            {...ACTION_BUTTON_PROPS}
            disabled={!canSaveRename}
            onPress={onRenameSave}
            // Web-only: the press handler saves, so the rendered
            // <button> must not also be the form's submit button.
            {...({ type: "button" } as object)}
            data-testid={`category-rename-save-${category.slug}`}
          >
            {renamePending ? <Spinner size="small" /> : null}
            {String(
              t(renamePending ? "admin.pcRenameSaving" : "admin.pcRenameSave"),
            )}
          </Button>
          <Button
            variant="ghost"
            {...ACTION_BUTTON_PROPS}
            disabled={renamePending}
            onPress={onModeCancel}
            {...({ type: "button" } as object)}
            data-testid={`category-rename-cancel-${category.slug}`}
          >
            {String(t("admin.pcCancel"))}
          </Button>
        </XStack>
      </YStack>
    </form>
  );

  return (
    <TileFrame
      id={ids.tile}
      role="group"
      aria-label={name}
      data-testid={`category-tile-${category.slug}`}
    >
      <YStack gap={4}>
        <XStack gap={8} flexWrap="wrap" alignItems="center">
          <YStack flexGrow={1} flexShrink={1} flexBasis={120} minWidth={0}>
            <Text variant="h5" weight="bold">
              {name}
            </Text>
          </YStack>

          {canManage && !isRenaming ? (
            <XStack gap={4} flexShrink={0}>
              <Button
                variant="ghost"
                size="$4"
                icon
                id={ids.moveUp}
                disabled={isFirst || movePending}
                onPress={() => onMove("up")}
                aria-label={String(t("admin.pcMoveUpNamed", { name }))}
                {...({
                  title: String(t("admin.pcMoveUpNamed", { name })),
                } as object)}
                data-testid={`category-move-up-${category.slug}`}
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </Button>
              <Button
                variant="ghost"
                size="$4"
                icon
                id={ids.moveDown}
                disabled={isLast || movePending}
                onPress={() => onMove("down")}
                aria-label={String(t("admin.pcMoveDownNamed", { name }))}
                {...({
                  title: String(t("admin.pcMoveDownNamed", { name })),
                } as object)}
                data-testid={`category-move-down-${category.slug}`}
              >
                <ArrowDown size={15} strokeWidth={2.5} />
              </Button>
            </XStack>
          ) : null}
        </XStack>

        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <Badge tone={category.active ? "success" : "neutral"} size="sm">
            {String(t(category.active ? "admin.pcActive" : "admin.pcInactive"))}
          </Badge>
        </XStack>
      </YStack>

      <YStack gap={8} minWidth={0}>
        <YStack gap={4}>
          <Text variant="overline" tone="muted">
            {String(t("admin.pcLanguageLabel"))}
          </Text>
          <LanguageSelect
            value={language}
            onChange={setLanguage}
            selectId={ids.languageSelect}
            ariaLabel={String(t("admin.pcLanguageFor", { name }))}
            testId={`category-language-${category.slug}`}
          />
          <SuggestionNotice
            unreviewed={unreviewed}
            onReview={reveal}
            name={name}
            testId={`category-suggestion-notice-${category.slug}`}
          />
        </YStack>
        {/* The chosen language's container: a rule ties it to the selector
            above without boxing a card inside the tile. */}
        <YStack
          gap={12}
          minWidth={0}
          borderLeftWidth={2}
          borderLeftColor="$borderColorSoft"
          paddingLeft={12}
          data-testid={`category-language-panel-${category.slug}`}
        >
          {isRenaming ? (
            renameForm
          ) : (
            <>
              <YStack gap={4} minWidth={0}>
                <Text variant="overline" tone="muted">
                  {String(t("admin.pcNameLabel"))}
                </Text>
                <Text
                  variant="bodySmall"
                  tone={storedName ? "default" : "muted"}
                  data-testid={`category-name-${language}-${category.slug}`}
                >
                  {storedName ?? String(t("admin.pcNameMissing"))}
                </Text>
              </YStack>
              <CategoryUrls
                categoryId={category.id}
                categoryName={name}
                englishSlug={category.slug}
                urls={urls}
                locale={language}
                named={storedName !== null}
                canChange={canManage && mode === null}
                edits={urlEdits}
                onEditsChange={setUrlEdits}
              />
            </>
          )}
        </YStack>
      </YStack>

      <YStack gap={4}>
        <Text variant="overline" tone="muted">
          {seoTypeLabel}
        </Text>
        {canEditSeoType ? (
          <>
            <StyledSelect<EventSchemaType>
              value={category.seoType as EventSchemaType}
              options={SEO_TYPE_OPTIONS}
              onChange={onSeoTypeChange}
              disabled={seoTypePending}
              selectId={ids.seoTypeSelect}
              ariaLabel={String(t("admin.pcSeoTypeFor", { name }))}
              {...SELECT_FRAME_PROPS}
              testId={`category-seo-type-${category.slug}`}
            />
            <Text variant="caption" tone="muted">
              Events in this category emit this schema.org Event subtype in
              their JSON-LD.
            </Text>
          </>
        ) : (
          <Text variant="bodySmall">{category.seoType}</Text>
        )}
      </YStack>

      {mode === "delete" && canDelete ? (
        <YStack gap={8}>
          <Text variant="body" weight="bold">
            {String(t("admin.pcConfirmDelete", { name }))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.pcConfirmDeleteDescription"))}
          </Text>
          <XStack gap={8} flexWrap="wrap">
            <Button
              variant="destructive"
              {...CONFIRM_BUTTON_PROPS}
              onPress={onDeleteConfirm}
              data-testid={`category-delete-confirm-${category.slug}`}
            >
              <Trash2 size={14} />
              {String(t("admin.pcConfirmDeleteCta"))}
            </Button>
            <Button
              variant="ghost"
              {...ACTION_BUTTON_PROPS}
              id={ids.confirmCancel}
              onPress={onModeCancel}
            >
              {String(t("admin.pcCancel"))}
            </Button>
          </XStack>
        </YStack>
      ) : mode === "deactivate" && canManage ? (
        <YStack gap={8}>
          <Text variant="body" weight="bold">
            {String(t("admin.pcConfirmDeactivate", { name }))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.pcConfirmDeactivateDescription"))}
          </Text>
          <XStack gap={8} flexWrap="wrap">
            <Button
              variant="secondary"
              {...CONFIRM_BUTTON_PROPS}
              disabled={activePending}
              onPress={() => onSetActive(false)}
              data-testid={`category-deactivate-confirm-${category.slug}`}
            >
              {activePending ? <Spinner size="small" /> : null}
              {String(t("admin.pcConfirmDeactivateCta"))}
            </Button>
            <Button
              variant="ghost"
              {...ACTION_BUTTON_PROPS}
              id={ids.confirmCancel}
              disabled={activePending}
              onPress={onModeCancel}
            >
              {String(t("admin.pcCancel"))}
            </Button>
          </XStack>
        </YStack>
      ) : !isRenaming && (canManage || canDelete) ? (
        // Pinned to the tile's foot, so the action rows of one grid row line
        // up whatever the titles above them wrap to.
        <XStack gap={8} flexWrap="wrap" marginTop="auto">
          {canManage ? (
            <>
              <Button
                variant="ghost"
                {...ACTION_BUTTON_PROPS}
                id={ids.renameButton}
                disabled={openersBlocked}
                onPress={onRenameOpen}
                aria-label={String(t("admin.pcEditNamesNamed", { name }))}
                data-testid={`category-rename-${category.slug}`}
              >
                {/* The names editor holds every language, not only English. */}
                {String(t("admin.pcEditNames"))}
              </Button>
              <Button
                variant="ghost"
                {...ACTION_BUTTON_PROPS}
                id={ids.activeButton}
                disabled={activePending || openersBlocked}
                onPress={
                  category.active ? onDeactivateAsk : () => onSetActive(true)
                }
                aria-label={String(
                  t(
                    category.active
                      ? "admin.pcDeactivateNamed"
                      : "admin.pcReactivateNamed",
                    { name },
                  ),
                )}
                data-testid={`category-active-toggle-${category.slug}`}
              >
                {activePending ? <Spinner size="small" /> : null}
                {String(
                  t(
                    category.active
                      ? "admin.pcDeactivate"
                      : "admin.pcReactivate",
                  ),
                )}
              </Button>
            </>
          ) : null}
          {canDelete ? (
            <Button
              variant="secondary"
              {...ACTION_BUTTON_PROPS}
              id={ids.deleteButton}
              disabled={deleting || openersBlocked}
              onPress={onDeleteAsk}
              // While it reads "Deleting..." the visible text is the name.
              aria-label={
                deleting
                  ? undefined
                  : String(t("admin.pcDeleteNamed", { name }))
              }
              data-testid={`category-delete-${category.slug}`}
            >
              {deleting ? <Spinner size="small" /> : <Trash2 size={14} />}
              {String(t(deleting ? "admin.pcDeleting" : "admin.pcDelete"))}
            </Button>
          ) : null}
        </XStack>
      ) : null}
    </TileFrame>
  );
}
