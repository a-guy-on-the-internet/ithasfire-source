"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { YStack } from "tamagui";

import { StyledSelect, useTranslations } from "@th/ui";
import { isCategoryNameLocale, type CategoryNameLocale } from "@th/types";

import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
} from "@/i18n/config";
import { ACCENT_TEXT } from "@/lib/design-tokens";

/**
 * One language at a time on /platform/categories (owner, 2026-10-18, R24:
 * "a drop box container list for each language defaulting on english").
 * Every per-language value on the page (a name, a URL, its old URLs) sits
 * behind this selector instead of beside the other languages', so a tile or
 * form keeps one language's fields however many languages the app gains.
 */

/**
 * The languages a category is named and addressed in: the app's supported
 * locales, default first, that a category name can be stored in.
 */
export const CATEGORY_LANGUAGES: readonly CategoryNameLocale[] = [
  DEFAULT_LOCALE,
  ...SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE),
].filter(isCategoryNameLocale);

export const DEFAULT_CATEGORY_LANGUAGE: CategoryNameLocale =
  CATEGORY_LANGUAGES[0] ?? "en";

/**
 * The selector drawn like the inputs around it: the SEO type select's frame
 * (`SELECT_FRAME_PROPS` in CategoryTile.tsx), repeated here so this file
 * does not import the tile.
 */
const LANGUAGE_SELECT_FRAME_PROPS = {
  fullWidth: true,
  size: "md",
  borderRadius: 0,
  height: 44,
  minHeight: 44,
  paddingHorizontal: 14,
  borderColor: "$borderColorSoft",
  backgroundColor: "$background",
} as const;

export interface LanguageSelectProps {
  value: CategoryNameLocale;
  onChange: (locale: CategoryNameLocale) => void;
  /** The native select's id, for a visible `<label htmlFor>`. */
  selectId?: string;
  /** A name unique on the page ("Language for Music"). */
  ariaLabel?: string;
  disabled?: boolean;
  testId: string;
}

/**
 * Options are each language's own name (English, Español), as in the site's
 * language picker: the same in every UI language, and no new copy per
 * language added.
 */
export function LanguageSelect({
  value,
  onChange,
  selectId,
  ariaLabel,
  disabled,
  testId,
}: LanguageSelectProps) {
  const options = CATEGORY_LANGUAGES.map((locale) => ({
    value: locale,
    label: LOCALE_LABELS[locale],
  }));
  return (
    <StyledSelect<CategoryNameLocale>
      value={value}
      options={options}
      onChange={onChange}
      selectId={selectId}
      ariaLabel={ariaLabel}
      disabled={disabled}
      {...LANGUAGE_SELECT_FRAME_PROPS}
      testId={testId}
    />
  );
}

// The accent text-action idiom of the Translate link beside a name field
// (`category-name-fields.tsx`), as a button: the whole 44px is the target.
const REVIEW_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  minHeight: 44,
  padding: 0,
  margin: 0,
  border: "none",
  background: "none",
  cursor: "pointer",
  textAlign: "left",
  color: ACCENT_TEXT,
  fontFamily: "var(--font-body, sans-serif)",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  lineHeight: "18px",
};

export interface SuggestionNoticeProps {
  /** Languages holding a machine suggestion nobody has looked at yet. */
  unreviewed: Partial<Record<CategoryNameLocale, boolean>>;
  /** Bring that language's field forward. */
  onReview: (locale: CategoryNameLocale) => void;
  /** The category the form is about, for each button's name; omitted = none. */
  name?: string;
  testId: string;
}

/**
 * One line per language whose name is a machine suggestion behind the
 * selector: "Español: suggested name to review". Pressing it shows that
 * language. A suggestion nobody has seen is not saved (the forms leave it
 * out), so this line is the only way to know it exists. A polite live
 * region: the line appears when the suggestion lands, after a pause.
 */
export function SuggestionNotice({
  unreviewed,
  onReview,
  name,
  testId,
}: SuggestionNoticeProps) {
  const t = useTranslations();
  const locales = CATEGORY_LANGUAGES.filter((locale) => unreviewed[locale]);
  return (
    <YStack aria-live="polite" data-testid={testId}>
      {locales.map((locale) => {
        const language = LOCALE_LABELS[locale];
        return (
          <button
            key={locale}
            type="button"
            style={REVIEW_BUTTON_STYLE}
            onClick={() => onReview(locale)}
            // The visible text, then the category: a spoken command that
            // reads the label still matches (WCAG 2.5.3).
            aria-label={
              name
                ? String(
                    t("admin.pcSuggestionToReviewNamed", { language, name }),
                  )
                : undefined
            }
            data-testid={`${testId}-${locale}`}
          >
            {String(t("admin.pcSuggestionToReview", { language }))}
          </button>
        );
      })}
    </YStack>
  );
}

/**
 * A request from outside a tile to show a language and focus its field (a
 * refusal landing). `seq` grows with every request, so asking for the
 * language already shown still moves focus.
 */
export interface LanguageRevealRequest {
  locale: CategoryNameLocale;
  seq: number;
}

export interface LanguageSelection {
  language: CategoryNameLocale;
  /** The person picked a language. */
  setLanguage: (locale: CategoryNameLocale) => void;
  /**
   * Show `locale` and put focus in its field once it has rendered. Runs its
   * focus step every call, even when `locale` is already shown.
   */
  reveal: (locale: CategoryNameLocale) => void;
}

/**
 * The selected language of one tile or form, and the way a field hidden
 * behind the selector is brought forward.
 *
 * `errors`: a language whose field gains an error while another language is
 * shown is selected and its field focused (a server refusal landing). The
 * shown language keeps the floor when it has an error of its own. A refusal
 * that repeats an error already set changes nothing React can see, so every
 * client-side check also calls `reveal` itself.
 */
export function useLanguageSelection(opts: {
  fieldId: (locale: CategoryNameLocale) => string;
  errors?: Partial<Record<CategoryNameLocale, boolean>>;
}): LanguageSelection {
  const { fieldId, errors } = opts;
  const [language, setLanguage] = useState<CategoryNameLocale>(
    DEFAULT_CATEGORY_LANGUAGE,
  );
  const focusAfterRef = useRef<CategoryNameLocale | null>(null);
  const [revealCount, setRevealCount] = useState(0);

  const reveal = useCallback((locale: CategoryNameLocale) => {
    focusAfterRef.current = locale;
    setLanguage(locale);
    // Re-run the focus step even when `locale` is already shown.
    setRevealCount((count) => count + 1);
  }, []);

  const erroredKey = CATEGORY_LANGUAGES.filter(
    (locale) => errors?.[locale],
  ).join(",");
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => {
    if (!erroredKey) return;
    const shown = languageRef.current;
    if (erroredKey.split(",").includes(shown)) return;
    const first = erroredKey.split(",")[0] as CategoryNameLocale;
    reveal(first);
  }, [erroredKey, reveal]);

  const fieldIdRef = useRef(fieldId);
  fieldIdRef.current = fieldId;
  useEffect(() => {
    const target = focusAfterRef.current;
    if (!target || target !== language) return;
    focusAfterRef.current = null;
    document.getElementById(fieldIdRef.current(target))?.focus();
  }, [language, revealCount]);

  return { language, setLanguage, reveal };
}
