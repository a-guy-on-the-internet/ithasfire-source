"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { XStack, YStack } from "tamagui";
import { Check } from "lucide-react";

import { Button, Spinner, Text, useTranslations } from "@th/ui";

import {
  CategoryNameField,
  isEnglishNameAcceptable,
  isTranslatedNameAcceptable,
  useSuggestedName,
} from "./category-name-fields";
import {
  LanguageSelect,
  SuggestionNotice,
  useLanguageSelection,
} from "./language-select";
import type {
  CategoryNameLocale,
  CategoryTranslationLocale,
} from "@th/types";
import { normalizeCategoryName } from "@th/types/category-name-rules";

export interface CategoryRequestApprovalInput {
  /** The English name; the new category's slug derives from it. */
  name: string;
  /** The Spanish name, or `null` for none. */
  translations: { es: string | null };
}

export interface CategoryRequestApprovalProps {
  request: { id: string; name: string; locale: string | null };
  pending: boolean;
  /** A refusal of the English name from the server, already translated. */
  englishError: string | null;
  /** A refusal of the Spanish name from the server, already translated. */
  spanishError: string | null;
  /** A field was edited: the server's refusals no longer apply. */
  onEdit: () => void;
  onSubmit: (input: CategoryRequestApprovalInput) => void;
  onCancel: () => void;
  /** The English name as it stands, typed or suggested: the slug's source. */
  onEnglishNameChange?: (name: string) => void;
}

const LABEL_STYLE = { display: "flex" } as const;

const ACTION_BUTTON_PROPS = {
  size: "$3",
  height: 44,
  minHeight: 44,
} as const;

export const approvalFieldIds = (requestId: string) => ({
  en: `platform-category-approve-en-${requestId}`,
  es: `platform-category-approve-es-${requestId}`,
  language: `platform-category-approve-language-${requestId}`,
});

/**
 * Approving a category request names the new category in both languages
 * (category-translations FR-007). The requested name goes under the
 * language it was asked in; the other field is prefilled by machine
 * translation and marked as a suggestion until someone edits it. English is
 * required: the slug derives from it.
 *
 * One language's field shows at a time, behind a language selector that
 * opens on English (owner, 2026-10-18, R24). A suggestion whose field has not
 * been on screen is named in a notice under the selector and is not sent.
 */
export function CategoryRequestApproval({
  request,
  pending,
  englishError,
  spanishError,
  onEdit,
  onSubmit,
  onCancel,
  onEnglishNameChange,
}: CategoryRequestApprovalProps) {
  const t = useTranslations();
  const ids = approvalFieldIds(request.id);
  const askedInSpanish = request.locale === "es";
  const sourceLocale = askedInSpanish ? "es" : "en";
  const targetLocale = askedInSpanish ? "en" : "es";

  // The field the request was written in; the other one is translated into.
  const [sourceValue, setSourceValue] = useState(request.name);
  const target = useSuggestedName({
    sourceText: sourceValue,
    sourceLocale,
    targetLocale,
  });
  const englishValue = askedInSpanish ? target.value : sourceValue;
  const spanishValue = askedInSpanish ? sourceValue : target.value;
  // The suggested field's language holds a value nobody has seen yet.
  const unreviewed = {
    en: askedInSpanish && target.unreviewed,
    es: !askedInSpanish && target.unreviewed,
  } satisfies Record<CategoryNameLocale, boolean>;
  // What a submit leaves out: unseen, or answering a source since changed.
  const leftOut = {
    en: askedInSpanish && target.leaveOutOnSubmit,
    es: !askedInSpanish && target.leaveOutOnSubmit,
  } satisfies Record<CategoryNameLocale, boolean>;

  useEffect(() => {
    onEnglishNameChange?.(englishValue);
  }, [englishValue, onEnglishNameChange]);

  const [localEnglishError, setLocalEnglishError] = useState<string | null>(
    null,
  );
  const [localSpanishError, setLocalSpanishError] = useState<string | null>(
    null,
  );

  const selection = useLanguageSelection({
    fieldId: (locale) => ids[locale],
    errors: {
      en: (localEnglishError ?? englishError) !== null,
      es: (localSpanishError ?? spanishError) !== null,
    } satisfies Record<CategoryNameLocale, boolean>,
  });

  // How many times Approve was refused because the English suggestion
  // answers an earlier Spanish name (0 = not since the field last changed).
  // Said under the English field until that field changes or the English
  // is no longer left out; each refusal inserts the line again.
  const [staleEnglishRefusals, setStaleEnglishRefusals] = useState(0);
  useEffect(() => {
    setStaleEnglishRefusals(0);
  }, [englishValue]);
  useEffect(() => {
    if (!leftOut.en) setStaleEnglishRefusals(0);
  }, [leftOut.en]);
  const showStaleEnglish = staleEnglishRefusals > 0 && leftOut.en;
  const staleEnglishId = `${ids.en}-stale`;

  const sentRef = useRef(false);
  // A settled review (refused, or the row still open) can be sent again.
  useEffect(() => {
    if (!pending) sentRef.current = false;
  }, [pending]);

  // Into the English field on open: it is the one approval needs.
  useEffect(() => {
    document.getElementById(ids.en)?.focus();
  }, [ids.en]);

  const editEnglish = (value: string) => {
    if (askedInSpanish) target.setValue(value);
    else setSourceValue(value);
    setLocalEnglishError(null);
    onEdit();
  };
  const editSpanish = (value: string) => {
    if (askedInSpanish) setSourceValue(value);
    else target.setValue(value);
    setLocalSpanishError(null);
    onEdit();
  };

  const submit = () => {
    // `pending` only flips on the next render: the ref stops a second Enter
    // (or Enter then a click) from sending the approval twice meanwhile.
    if (pending || sentRef.current) return;
    // English is required: an English suggestion that is unseen, or answers
    // a Spanish name since changed, is shown first, not sent. A stale one is
    // asked for again (its answer replaces it) and a line under the field
    // says why nothing was sent: the new one may never come.
    if (leftOut.en) {
      if (!unreviewed.en) {
        target.flush();
        setStaleEnglishRefusals((count) => count + 1);
      }
      selection.reveal("en");
      return;
    }
    const name = normalizeCategoryName(englishValue);
    // A Spanish suggestion that is unseen or stale is left out.
    const spanish = leftOut.es ? "" : normalizeCategoryName(spanishValue);
    const englishProblem =
      name.length === 0
        ? String(t("admin.pcEnglishNameRequired"))
        : isEnglishNameAcceptable(name)
          ? null
          : String(t("admin.pcAddErrorInvalidName"));
    const spanishProblem =
      spanish.length > 0 && !isTranslatedNameAcceptable(spanish)
        ? String(t("admin.pcTranslationErrorInvalid"))
        : null;
    setLocalEnglishError(englishProblem);
    setLocalSpanishError(spanishProblem);
    // Shown and focused every time: a refusal that repeats the error already
    // set changes no state the selector can see.
    if (englishProblem) {
      selection.reveal("en");
      return;
    }
    if (spanishProblem) {
      selection.reveal("es");
      return;
    }
    sentRef.current = true;
    onSubmit({ name, translations: { es: spanish.length > 0 ? spanish : null } });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const englishField = (
    <YStack gap={4} minWidth={0}>
      <CategoryNameField
        id={ids.en}
        locale="en"
        value={englishValue}
        onChange={editEnglish}
        onSubmitEditing={submit}
        onBlur={askedInSpanish ? undefined : target.flush}
        isSuggested={askedInSpanish && target.isSuggested}
        onSuggestionSeen={askedInSpanish ? target.markSeen : undefined}
        translateFrom={
          askedInSpanish ? { locale: "es", text: spanishValue } : undefined
        }
        error={localEnglishError ?? englishError}
        describedBy={showStaleEnglish ? staleEnglishId : undefined}
        readOnly={pending}
        required
        testId={`category-approve-en-${request.id}`}
      />
      {/* Mounted with the field, empty until a refusal. Enter in the English
          field refuses with focus already there, so no focus event re-reads
          the description: this live region says it instead. Approve from
          the other language mounts the field and moves focus into it, and
          the description is read. */}
      <YStack
        aria-live="polite"
        data-testid={`category-approve-en-stale-region-${request.id}`}
      >
        {showStaleEnglish ? (
          <Text
            // A new node per refusal, so a repeat is announced again.
            key={staleEnglishRefusals}
            id={staleEnglishId}
            variant="caption"
            tone="muted"
            data-testid={`category-approve-en-stale-${request.id}`}
          >
            {String(t("admin.pcStaleEnglishSuggestion"))}
          </Text>
        ) : null}
      </YStack>
    </YStack>
  );
  // Every translation locale's field, so a language added to the app fails
  // to compile here until it has one.
  const translationFields = {
    es: (
      <CategoryNameField
        id={ids.es}
        locale="es"
        value={spanishValue}
        onChange={editSpanish}
        onSubmitEditing={submit}
        onBlur={askedInSpanish ? target.flush : undefined}
        isSuggested={!askedInSpanish && target.isSuggested}
        onSuggestionSeen={askedInSpanish ? undefined : target.markSeen}
        translateFrom={
          askedInSpanish ? undefined : { locale: "en", text: englishValue }
        }
        error={localSpanishError ?? spanishError}
        readOnly={pending}
        testId={`category-approve-es-${request.id}`}
      />
    ),
  } satisfies Record<CategoryTranslationLocale, ReactNode>;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={String(t("admin.pcApproveNamed", { name: request.name }))}
      data-testid={`category-approve-form-${request.id}`}
    >
      <YStack gap={12}>
        {/* Top-aligned, so the two labels and the two inputs line up even
            when the name column is taller (its Translate link wrapped). */}
        <XStack gap={12} flexWrap="wrap" alignItems="flex-start">
          <YStack flexGrow={1} flexShrink={1} flexBasis={140} minWidth={0}>
            <YStack gap={4} minWidth={0}>
              <label htmlFor={ids.language} style={LABEL_STYLE}>
                <Text variant="overline" tone="muted" tag="span">
                  {String(t("admin.pcLanguageLabel"))}
                </Text>
              </label>
              <LanguageSelect
                value={selection.language}
                onChange={selection.setLanguage}
                selectId={ids.language}
                ariaLabel={String(
                  t("admin.pcLanguageFor", { name: request.name }),
                )}
                testId={`category-approve-language-${request.id}`}
              />
              <SuggestionNotice
                unreviewed={unreviewed}
                onReview={selection.reveal}
                name={request.name}
                testId={`category-approve-suggestion-notice-${request.id}`}
              />
            </YStack>
          </YStack>
          <YStack flexGrow={1} flexShrink={1} flexBasis={240} minWidth={0}>
            {selection.language === "en"
              ? englishField
              : translationFields[selection.language]}
          </YStack>
        </XStack>
        <XStack gap={8} flexWrap="wrap">
          <Button
            variant="primary"
            {...ACTION_BUTTON_PROPS}
            disabled={pending}
            onPress={submit}
            // Web-only: the press handler submits, so the rendered <button>
            // must not also be the form's submit button.
            {...({ type: "button" } as object)}
            data-testid={`category-approve-submit-${request.id}`}
          >
            {pending ? <Spinner size="small" /> : <Check size={16} />}
            {String(t("admin.pcApprove"))}
          </Button>
          <Button
            variant="ghost"
            {...ACTION_BUTTON_PROPS}
            disabled={pending}
            onPress={onCancel}
            {...({ type: "button" } as object)}
            data-testid={`category-approve-cancel-${request.id}`}
          >
            {String(t("admin.pcCancel"))}
          </Button>
        </XStack>
      </YStack>
    </form>
  );
}
