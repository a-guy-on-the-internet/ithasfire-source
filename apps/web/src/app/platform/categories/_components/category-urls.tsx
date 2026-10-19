"use client";

import {
  Fragment,
  useEffect,
  useRef,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { XStack, YStack } from "tamagui";

import {
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import type { CategoryNameLocale } from "@th/types";
import {
  CATEGORY_SLUG_MAX_LENGTH,
  categorySlugIssue,
} from "@th/types/category-name-rules";

import { trpc } from "@/trpc";
import { publicPath } from "@/i18n/public-paths";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";

import { LANGUAGE_NAME_KEYS } from "./category-name-fields";

/**
 * One language's address for a category on /platform/categories (Spanish SEO
 * FR-009, FR-010, FR-012; owner R24): the current URL, a Change URL editor,
 * and the old URLs that redirect (308) to it.
 */

/** One slug row from `categories.listAll`. */
export interface CategoryUrl {
  locale: CategoryNameLocale;
  slug: string;
  isCurrent: boolean;
}

export const categoryUrlIds = (
  categoryId: string,
  locale: CategoryNameLocale,
) => ({
  changeButton: `platform-category-url-change-${locale}-${categoryId}`,
  input: `platform-category-url-input-${locale}-${categoryId}`,
  error: `platform-category-url-error-${locale}-${categoryId}`,
  help: `platform-category-url-help-${locale}-${categoryId}`,
});

/**
 * The URL a language's page has today. Its own current slug when it has one;
 * otherwise the English slug under that language's path (FR-010: a category
 * with no current slug in a language renders there at its English slug).
 */
export function categoryPagePath(
  urls: readonly CategoryUrl[],
  locale: CategoryNameLocale,
  englishSlug: string,
): { path: string; own: boolean } {
  const current = urls.find((url) => url.locale === locale && url.isCurrent);
  if (current) {
    return {
      path: publicPath(locale, { kind: "category", slug: current.slug }),
      own: true,
    };
  }
  const english =
    urls.find((url) => url.locale === "en" && url.isCurrent)?.slug ??
    englishSlug;
  return {
    path: publicPath(locale, { kind: "category", slug: english }),
    // An English page with no slug row yet (written before CategorySlug) is
    // still its own address.
    own: locale === "en",
  };
}

/** The path with a line-break chance after every slash. */
export function PathText({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              /<wbr />
            </>
          ) : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

// A slug that never fits a word break still wraps inside the tile.
const PATH_STYLE = { overflowWrap: "anywhere" } as const;
const LABEL_STYLE = { display: "flex" } as const;

const ACTION_BUTTON_PROPS = {
  size: "$3",
  height: 44,
  minHeight: 44,
} as const;

export type CategoryUrlEdit = { value: string; error: string | null };
/** A tile's open URL editors, one per language, with their drafts. */
export type CategoryUrlEdits = Partial<
  Record<CategoryNameLocale, CategoryUrlEdit>
>;

export interface CategoryUrlsProps {
  categoryId: string;
  /** The category's English name: what the controls' names say. */
  categoryName: string;
  /** `Category.slug`: the English slug when no slug row exists yet. */
  englishSlug: string;
  urls: readonly CategoryUrl[];
  locale: CategoryNameLocale;
  /** True when the category has a name in `locale`. */
  named: boolean;
  /** Change URL is offered (ADMIN / DEVELOPER, nothing else open). */
  canChange: boolean;
  /**
   * The open editors and their drafts. Held by the tile, so a draft
   * survives the names editor or a confirm replacing this block.
   */
  edits: CategoryUrlEdits;
  onEditsChange: Dispatch<SetStateAction<CategoryUrlEdits>>;
}

/**
 * The selected language's URL rows. Rendered once per tile with the language
 * as a prop (not a key), so an unsaved URL edit in one language survives a
 * look at another.
 */
export function CategoryUrls({
  categoryId,
  categoryName,
  englishSlug,
  urls,
  locale,
  named,
  canChange,
  edits,
  onEditsChange: setEdits,
}: CategoryUrlsProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();
  const ids = categoryUrlIds(categoryId, locale);
  const language = String(t(LANGUAGE_NAME_KEYS[locale]));
  const names = { language, name: categoryName };

  const edit = edits[locale];
  const setEdit = (target: CategoryNameLocale, next: CategoryUrlEdit | null) =>
    setEdits((current) => {
      const copy = { ...current };
      if (next) copy[target] = next;
      else delete copy[target];
      return copy;
    });

  // Focus moves after the render that shows its target: into the field when
  // the editor opens or refuses, back to Change URL when it closes.
  const focusRef = useRef<string | null>(null);
  useEffect(() => {
    const id = focusRef.current;
    if (!id) return;
    const element = document.getElementById(id);
    if (!element) return;
    focusRef.current = null;
    element.focus();
    if (element instanceof HTMLInputElement) element.select();
  });

  const changeSlugMutation = trpc.categories.changeSlug.useMutation({
    // Every failure is answered here: the enrolment prompt, inline under the
    // field, or one toast.
    meta: { silent: true },
    onSuccess: (data) => {
      // Show the new address at once; the refetch confirms it.
      utils.categories.listAll.setData(undefined, (previous) =>
        previous
          ? {
              categories: previous.categories.map((category) =>
                category.id === data.categoryId
                  ? {
                      ...category,
                      // `Category.slug` moves with the English URL.
                      ...(data.locale === "en"
                        ? { slug: data.currentSlug }
                        : {}),
                      urls: [
                        ...category.urls.filter(
                          (url) => url.locale !== data.locale,
                        ),
                        {
                          locale: data.locale,
                          slug: data.currentSlug,
                          isCurrent: true,
                        },
                        ...data.oldSlugs.map((slug) => ({
                          locale: data.locale,
                          slug,
                          isCurrent: false,
                        })),
                      ],
                    }
                  : category,
              ),
            }
          : previous,
      );
      void utils.categories.list.invalidate();
      void utils.categories.listAll.invalidate();
      toast.success({
        title: String(t("admin.pcUrlChangedToast")),
        message: publicPath(data.locale, {
          kind: "category",
          slug: data.currentSlug,
        }),
      });
      focusRef.current = categoryUrlIds(categoryId, data.locale).changeButton;
      setEdit(data.locale, null);
    },
    onError: (error, variables) => {
      if (handleSecondFactorRequired(error)) return;
      const code = getAppErrorCode(error);
      if (code === "CATEGORY_SLUG_TAKEN" || code === "INVALID_CATEGORY_SLUG") {
        setEdits((current) => {
          const open = current[variables.locale];
          if (!open) return current;
          return {
            ...current,
            [variables.locale]: {
              ...open,
              error: formatErrorMessage(error, t),
            },
          };
        });
        focusRef.current = categoryUrlIds(categoryId, variables.locale).input;
        return;
      }
      if (code === "CATEGORY_NOT_FOUND") {
        setEdit(variables.locale, null);
        void utils.categories.list.invalidate();
        void utils.categories.listAll.invalidate();
        toast.warning({
          title: String(t("admin.pcListChangedToast")),
          message: String(t("admin.pcListChangedToastMessage")),
        });
        return;
      }
      toast.danger({
        title: String(t("admin.pcUrlChangeFailed")),
        message: formatErrorMessage(error, t),
      });
    },
  });

  const pending =
    changeSlugMutation.isPending &&
    changeSlugMutation.variables?.categoryId === categoryId &&
    changeSlugMutation.variables?.locale === locale;

  const page = categoryPagePath(urls, locale, englishSlug);
  const currentSlug =
    urls.find((url) => url.locale === locale && url.isCurrent)?.slug ??
    (locale === "en" ? englishSlug : null);
  const oldUrls = urls.filter((url) => url.locale === locale && !url.isCurrent);
  // A language's own slug is made when its name is added (FR-008): before
  // that there is nothing of its own to change. One that has a slug keeps
  // it when its name is cleared (R20), and that slug can still be changed.
  const changeable = canChange && (locale === "en" || named || page.own);
  const prefix = publicPath(locale, { kind: "category", slug: "" });

  const openEditor = () => {
    focusRef.current = ids.input;
    setEdit(locale, { value: currentSlug ?? "", error: null });
  };

  const closeEditor = () => {
    if (pending) return;
    focusRef.current = ids.changeButton;
    setEdit(locale, null);
  };

  const save = () => {
    if (!edit || pending) return;
    const slug = edit.value.trim().toLowerCase();
    if (slug === currentSlug) {
      closeEditor();
      return;
    }
    if (categorySlugIssue(slug) !== null) {
      setEdit(locale, {
        ...edit,
        error: String(t("errors.invalidCategorySlug")),
      });
      focusRef.current = ids.input;
      return;
    }
    changeSlugMutation.mutate({ categoryId, locale, newSlug: slug });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape" || pending) return;
    event.preventDefault();
    closeEditor();
  };

  return (
    <YStack gap={8} minWidth={0}>
      <YStack gap={4} minWidth={0}>
        <Text variant="overline" tone="muted">
          {String(t("admin.pcUrlLabel"))}
        </Text>
        {edit && changeable ? (
          <form
            onSubmit={handleSubmit}
            // Capture phase: the text input stops keydown from bubbling
            // (react-native-web), so a bubble handler never sees Escape.
            onKeyDownCapture={handleKeyDown}
            noValidate
            aria-label={String(t("admin.pcChangeUrlNamed", names))}
            data-testid={`category-url-form-${locale}-${categoryId}`}
          >
            <YStack gap={4} minWidth={0}>
              <label htmlFor={ids.input} style={LABEL_STYLE}>
                <Text
                  variant="code"
                  tone="muted"
                  tag="span"
                  minWidth={0}
                  style={PATH_STYLE}
                >
                  <PathText path={prefix} />
                </Text>
              </label>
              <TextInput
                id={ids.input}
                name={`categorySlug-${locale}`}
                value={edit.value}
                onChangeText={(value: string) =>
                  // Clear on input (design system §6a).
                  setEdit(locale, { value, error: null })
                }
                onSubmitEditing={save}
                fullWidth
                height={44}
                minHeight={44}
                maxLength={CATEGORY_SLUG_MAX_LENGTH}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                readOnly={pending}
                blurOnSubmit={false}
                status={edit.error ? "error" : undefined}
                aria-label={String(t("admin.pcNewUrlNamed", names))}
                aria-invalid={edit.error ? true : undefined}
                aria-describedby={
                  edit.error ? `${ids.error} ${ids.help}` : ids.help
                }
                testId={`category-url-input-${locale}-${categoryId}`}
              />
              {edit.error ? (
                <Text
                  id={ids.error}
                  role="alert"
                  variant="caption"
                  tone="error"
                >
                  {edit.error}
                </Text>
              ) : null}
              <Text id={ids.help} variant="caption" tone="muted">
                {String(t("admin.pcUrlKeepsRedirecting"))}
              </Text>
              <XStack gap={8} flexWrap="wrap" paddingTop={4}>
                <Button
                  variant="secondary"
                  {...ACTION_BUTTON_PROPS}
                  disabled={pending || edit.value.trim().length === 0}
                  onPress={save}
                  // Web-only: the press handler saves, so the rendered
                  // <button> must not also be the form's submit button.
                  {...({ type: "button" } as object)}
                  aria-label={
                    pending
                      ? undefined
                      : String(t("admin.pcSaveUrlNamed", names))
                  }
                  data-testid={`category-url-save-${locale}-${categoryId}`}
                >
                  {pending ? <Spinner size="small" /> : null}
                  {String(
                    t(pending ? "admin.pcRenameSaving" : "admin.pcRenameSave"),
                  )}
                </Button>
                <Button
                  variant="ghost"
                  {...ACTION_BUTTON_PROPS}
                  disabled={pending}
                  onPress={closeEditor}
                  {...({ type: "button" } as object)}
                  aria-label={String(t("admin.pcCancelUrlNamed", names))}
                  data-testid={`category-url-cancel-${locale}-${categoryId}`}
                >
                  {String(t("admin.pcCancel"))}
                </Button>
              </XStack>
            </YStack>
          </form>
        ) : (
          <>
            <Text
              variant="code"
              tone={page.own ? "default" : "muted"}
              minWidth={0}
              style={PATH_STYLE}
              data-testid={`category-url-${locale}-${categoryId}`}
            >
              <PathText path={page.path} />
            </Text>
            {named || locale === "en" ? null : (
              <Text variant="caption" tone="muted">
                {String(t("admin.pcNotInSearchUntilNamed", { language }))}
              </Text>
            )}
            {changeable ? (
              <XStack>
                <Button
                  variant="ghost"
                  {...ACTION_BUTTON_PROPS}
                  id={ids.changeButton}
                  onPress={openEditor}
                  aria-label={String(t("admin.pcChangeUrlNamed", names))}
                  data-testid={`category-url-change-${locale}-${categoryId}`}
                >
                  {String(t("admin.pcChangeUrl"))}
                </Button>
              </XStack>
            ) : null}
          </>
        )}
      </YStack>

      {oldUrls.length > 0 ? (
        <YStack gap={4} minWidth={0}>
          <Text variant="overline" tone="muted">
            {String(t("admin.pcRedirectsHere"))}
          </Text>
          <YStack
            tag="ul"
            gap={2}
            margin={0}
            padding={0}
            style={{ listStyle: "none" }}
            data-testid={`category-old-urls-${locale}-${categoryId}`}
          >
            {oldUrls.map((url) => (
              <li key={url.slug}>
                <Text
                  variant="code"
                  tone="muted"
                  minWidth={0}
                  style={PATH_STYLE}
                >
                  <PathText
                    path={publicPath(locale, {
                      kind: "category",
                      slug: url.slug,
                    })}
                  />
                </Text>
              </li>
            ))}
          </YStack>
        </YStack>
      ) : null}
    </YStack>
  );
}
