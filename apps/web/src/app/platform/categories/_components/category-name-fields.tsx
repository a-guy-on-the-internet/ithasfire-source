"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { XStack, YStack } from "tamagui";
import { ExternalLink } from "lucide-react";

import { Text, TextInput, useTranslations } from "@th/ui";
import type { CategoryNameLocale } from "@th/types";
import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { ACCENT_TEXT, MUTED_TEXT } from "@/lib/design-tokens";
import {
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_NAME_MIN_LENGTH,
  categoryNameIssue,
  categorySlugNameIssue,
  normalizeCategoryName,
} from "@th/types/category-name-rules";

/**
 * Name fields in more than one language on /platform/categories
 * (category-translations spec FR-004 to FR-007): the label per language, the
 * "Suggested" marker on a machine-filled value, the Google Translate link,
 * and the hook that asks the server for a suggestion.
 */

// The server's boundary bounds (`@th/types/category-name-rules`), so a name
// the boundary schema would refuse gets the inline message, not a raw Zod
// toast.
export const CATEGORY_NAME_MIN = CATEGORY_NAME_MIN_LENGTH;
export const CATEGORY_NAME_MAX = CATEGORY_NAME_MAX_LENGTH;

/** The field label per language. */
export const NAME_LABEL_KEYS = {
  en: "admin.pcNameEnLabel",
  es: "admin.pcNameEsLabel",
} as const satisfies Record<CategoryNameLocale, string>;

/** The language's own name, for sentences ("Translate to Spanish"). */
export const LANGUAGE_NAME_KEYS = {
  en: "admin.pcLanguageEn",
  es: "admin.pcLanguageEs",
} as const satisfies Record<CategoryNameLocale, string>;

/** Google Translate with the text filled in (spec FR-006). */
export function googleTranslateHref(
  sourceLocale: CategoryNameLocale,
  targetLocale: CategoryNameLocale,
  text: string,
): string {
  return `https://translate.google.com/?sl=${sourceLocale}&tl=${targetLocale}&text=${encodeURIComponent(text)}`;
}

/**
 * True when a translated name passes the word rules (any script, 2–80
 * characters): a translation never derives a slug. Checked before a round
 * trip, so a refusal of a create or approval can be put under the English
 * field: the translations sent have already passed this.
 */
export const isTranslatedNameAcceptable = (name: string): boolean =>
  categoryNameIssue(name) === null;

/** True when an English name passes the word rules and slugs to 2–40. */
export const isEnglishNameAcceptable = (name: string): boolean =>
  categorySlugNameIssue(name) === null;

/** Why a translated name was refused: taken in its language, or not valid. */
export type TranslationError = "exists" | "invalid";

export const translationErrorKey = (error: TranslationError) =>
  error === "exists"
    ? ("admin.pcTranslationErrorExists" as const)
    : ("admin.pcTranslationErrorInvalid" as const);

/**
 * The message for a refused translated name. Only the duplicate message names
 * the language; the invalid-name rule is the same in every language.
 */
export const translationErrorMessage = (
  t: (key: string, values?: Record<string, string>) => unknown,
  error: TranslationError,
): string =>
  String(
    error === "exists"
      ? t(translationErrorKey(error), {
          language: String(t(LANGUAGE_NAME_KEYS.es)),
        })
      : t(translationErrorKey(error)),
  );

/**
 * The language a refusal is about when it is about a translated name: a
 * duplicate in that language (`CATEGORY_ALREADY_EXISTS` with
 * `meta.field: "nameTranslations"`), or the input schema refusing a
 * `translations.<locale>` value. `null` for anything else.
 */
export function translationRefusal(
  error: unknown,
): { locale: string; error: TranslationError } | null {
  if (!error || typeof error !== "object") return null;
  const code = getAppErrorCode(error);
  if (code === "CATEGORY_ALREADY_EXISTS") {
    const meta = (error as { data?: { meta?: unknown } }).data?.meta;
    if (!meta || typeof meta !== "object") return null;
    const { field, locale } = meta as { field?: unknown; locale?: unknown };
    if (field !== "nameTranslations") return null;
    return { locale: typeof locale === "string" ? locale : "es", error: "exists" };
  }
  if (code !== null) return null;
  const { data, message } = error as {
    data?: { code?: unknown };
    message?: unknown;
  };
  if (data?.code !== "BAD_REQUEST" || typeof message !== "string") return null;
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(issues) || issues.length === 0) return null;
  let locale: string | null = null;
  for (const issue of issues) {
    const path =
      issue && typeof issue === "object"
        ? (issue as { path?: unknown }).path
        : null;
    if (!Array.isArray(path) || path[0] !== "translations") return null;
    if (typeof path[1] === "string") locale = path[1];
  }
  return { locale: locale ?? "es", error: "invalid" };
}

// How long the source field must sit still before a suggestion is asked for.
// Blur asks at once.
export const SUGGEST_IDLE_MS = 700;

export interface SuggestedName {
  value: string;
  /** Start over with `value` (a form opened, or was submitted). */
  reset: (value: string) => void;
  /**
   * A person typed into the field (or cleared it). What they type is
   * theirs: the value stops being a suggestion, even if it reads the same.
   */
  setValue: (value: string) => void;
  /** True while the value is a machine suggestion nobody has edited. */
  isSuggested: boolean;
  /**
   * True while the value is a suggestion nobody has edited OR seen: its
   * field has not been on screen since it landed (it sits behind the
   * language selector). Forms leave such a value out of what they send.
   */
  unreviewed: boolean;
  /**
   * True when a submit must leave the value out: it is unreviewed, or it is
   * an untouched suggestion for source text that has changed since (its
   * newer suggestion has not landed yet). Read by submit paths only, so the
   * notice does not flicker while the source is typed. A value a person
   * typed is never left out.
   */
  leaveOutOnSubmit: boolean;
  /** The field is on screen holding the current value (CategoryNameField). */
  markSeen: () => void;
  /** Ask now for the current source text (the source field's blur). */
  flush: () => void;
}

/**
 * One name field that a machine translation of another field can fill
 * (spec FR-005). The suggestion only lands in a field that is blank or still
 * holds an untouched earlier suggestion: once a person has typed in it,
 * nothing overwrites it. A failed or empty answer leaves the field as it is,
 * with no message. Nothing is saved here; the form's submit sends the value.
 */
export function useSuggestedName(opts: {
  /** The text to translate, as typed. */
  sourceText: string;
  sourceLocale: CategoryNameLocale;
  targetLocale: CategoryNameLocale;
  /** The initial value (a stored translation, or a request's own text). */
  initialValue?: string;
  /** False stops asking (no permission, form closed). */
  enabled?: boolean;
}): SuggestedName {
  const {
    sourceText,
    sourceLocale,
    targetLocale,
    initialValue = "",
    enabled = true,
  } = opts;
  const [value, setValueState] = useState(initialValue);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [suggestion, setSuggestion] = useState<string | null>(null);
  // The normalised source text that suggestion answered.
  const [suggestionSource, setSuggestionSource] = useState<string | null>(
    null,
  );
  // The suggestion that was on screen, if any: a later one is unseen again.
  const [seenSuggestion, setSeenSuggestion] = useState<string | null>(null);
  // Every failure is answered by leaving the field blank: no global toast.
  const suggestMutation = trpc.categories.suggestTranslations.useMutation({
    meta: { silent: true },
  });
  const mutateRef = useRef(suggestMutation.mutate);
  mutateRef.current = suggestMutation.mutate;

  const source = normalizeCategoryName(sourceText);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // Read when a reply lands: a person may have typed since it was asked.
  const fillableRef = useRef(true);
  fillableRef.current =
    value.trim().length === 0 || (suggestion !== null && value === suggestion);
  const lastAskedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ask = useCallback(
    (text: string) => {
      if (!enabled || text.length < CATEGORY_NAME_MIN) return;
      if (!fillableRef.current || lastAskedRef.current === text) return;
      lastAskedRef.current = text;
      mutateRef.current(
        { text, sourceLocale, targetLocales: [targetLocale] },
        {
          onSuccess: (data) => {
            // The source moved on, or a person filled the field meanwhile.
            if (sourceRef.current !== text || !fillableRef.current) return;
            const suggested = data.suggestions[targetLocale]?.trim();
            if (!suggested) {
              // Nothing came back: let the same text be asked again.
              if (lastAskedRef.current === text) lastAskedRef.current = null;
              return;
            }
            setValueState(suggested);
            setSuggestion(suggested);
            setSuggestionSource(text);
          },
          onError: () => {
            // Let the same text be asked again on the next pause or blur.
            if (lastAskedRef.current === text) lastAskedRef.current = null;
          },
        },
      );
    },
    [enabled, sourceLocale, targetLocale],
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!enabled) return;
    if (source.length === 0) {
      // A suggestion for text that is gone goes with it.
      if (suggestion !== null && value === suggestion) {
        setValueState("");
        setSuggestion(null);
        setSuggestionSource(null);
      }
      lastAskedRef.current = null;
      return;
    }
    timerRef.current = setTimeout(() => ask(source), SUGGEST_IDLE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // `value` and `suggestion` are read for the clear above only; a change
    // of either must not re-arm the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, enabled, ask]);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    ask(sourceRef.current);
  }, [ask]);

  const setValue = useCallback((next: string) => {
    if (next !== valueRef.current) {
      // Typed text is never a suggestion. An emptied field is still filled
      // by the next one (`fillableRef`).
      setSuggestion(null);
      setSuggestionSource(null);
    }
    setValueState(next);
  }, []);

  const reset = useCallback((next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    lastAskedRef.current = null;
    setValueState(next);
    setSuggestion(null);
    setSuggestionSource(null);
    setSeenSuggestion(null);
  }, []);

  const isSuggested =
    suggestion !== null && value === suggestion && value !== "";
  const markSeen = useCallback(() => {
    setSeenSuggestion((current) =>
      suggestion !== null && current !== suggestion ? suggestion : current,
    );
  }, [suggestion]);

  const unreviewed = isSuggested && seenSuggestion !== value;

  return {
    value,
    reset,
    setValue,
    isSuggested,
    unreviewed,
    leaveOutOnSubmit:
      unreviewed || (isSuggested && suggestionSource !== source),
    markSeen,
    flush,
  };
}

// The Translate link: the accent text-action idiom /platform/places uses
// (`places/_components/link-action-style.ts`), as tall as the input beside
// it so the whole 44px is the target.
const TRANSLATE_LINK_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  // No side padding: when the row wraps, the link starts at the field's
  // left edge, under the input.
  padding: 0,
  flexShrink: 0,
  color: ACCENT_TEXT,
  fontFamily: "var(--font-body, sans-serif)",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  textDecoration: "none",
  lineHeight: "20px",
  whiteSpace: "nowrap",
};

const TRANSLATE_INERT_STYLE: React.CSSProperties = {
  ...TRANSLATE_LINK_STYLE,
  color: MUTED_TEXT,
  cursor: "default",
};

// The narrowest the name input gets with the Translate link beside it;
// below this the link wraps under the input.
const INPUT_MIN_BASIS = 180;

const LABEL_STYLE = { display: "flex" } as const;

export interface CategoryNameFieldProps {
  id: string;
  locale: CategoryNameLocale;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /**
   * Enter in the field. A form with two text inputs and no submit button
   * gets no implicit submission, so each field submits it itself.
   */
  onSubmitEditing?: () => void;
  isSuggested?: boolean;
  /**
   * Called while the field is on screen holding a suggestion: it has been
   * seen, so the form may send it (`useSuggestedName().markSeen`).
   */
  onSuggestionSeen?: () => void;
  /**
   * Where the Translate link translates from: the other field's language and
   * text. Omitted = no link (the source field itself).
   */
  translateFrom?: { locale: CategoryNameLocale; text: string };
  /** The inline error message, already translated. */
  error?: string | null;
  /**
   * Marks the field invalid when its message is rendered elsewhere (pass
   * that message's id in `describedBy`).
   */
  invalid?: boolean;
  /** Ids of help text under the field, for `aria-describedby`. */
  describedBy?: string;
  readOnly?: boolean;
  required?: boolean;
  testId: string;
}

/**
 * One name field: an overline label (with "Suggested" beside it while the
 * value is an untouched machine suggestion), the input, and the Translate
 * link beside a field that is translated into. Strict Swiss content: radius
 * 0, 44px input and link, tokens only.
 */
export function CategoryNameField({
  id,
  locale,
  value,
  onChange,
  onBlur,
  onSubmitEditing,
  isSuggested = false,
  onSuggestionSeen,
  translateFrom,
  error,
  invalid = false,
  describedBy,
  readOnly = false,
  required = false,
  testId,
}: CategoryNameFieldProps) {
  const t = useTranslations();
  // Mounted only while its language is shown, so on screen means seen.
  // Before paint, so the notice never shows for a frame beside the field.
  useLayoutEffect(() => {
    if (isSuggested) onSuggestionSeen?.();
  }, [isSuggested, value, onSuggestionSeen]);
  const suggestedId = `${id}-suggested`;
  const errorId = `${id}-error`;
  const describedByIds = [
    error ? errorId : null,
    isSuggested ? suggestedId : null,
    describedBy ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  const sourceText = translateFrom
    ? normalizeCategoryName(translateFrom.text)
    : "";

  return (
    <YStack gap={4} minWidth={0}>
      <XStack gap={8} alignItems="center" flexWrap="wrap">
        <label htmlFor={id} style={LABEL_STYLE}>
          <Text variant="overline" tone="muted" tag="span">
            {String(t(NAME_LABEL_KEYS[locale]))}
          </Text>
        </label>
        {isSuggested ? (
          <Text
            id={suggestedId}
            variant="overline"
            color="$accentText"
            tag="span"
            data-testid={`${testId}-suggested`}
          >
            {String(t("admin.pcSuggested"))}
          </Text>
        ) : null}
      </XStack>
      {/* Wraps: the input asks for INPUT_MIN_BASIS before the link may sit
          beside it, so in a narrow tile (about 150px at a 320px viewport)
          the link drops under the input instead of squeezing it. */}
      <XStack
        gap={8}
        rowGap={4}
        alignItems="center"
        flexWrap="wrap"
        minWidth={0}
      >
        <YStack
          flexGrow={1}
          flexShrink={1}
          flexBasis={INPUT_MIN_BASIS}
          minWidth={0}
        >
          <TextInput
            id={id}
            name={`categoryName-${locale}`}
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            onSubmitEditing={onSubmitEditing}
            fullWidth
            height={44}
            minHeight={44}
            maxLength={CATEGORY_NAME_MAX}
            autoComplete="off"
            required={required}
            readOnly={readOnly}
            blurOnSubmit={false}
            status={error || invalid ? "error" : undefined}
            aria-invalid={error || invalid ? true : undefined}
            aria-describedby={describedByIds || undefined}
            testId={testId}
          />
        </YStack>
        {translateFrom ? (
          sourceText.length > 0 ? (
            <a
              href={googleTranslateHref(
                translateFrom.locale,
                locale,
                sourceText,
              )}
              target="_blank"
              rel="noopener noreferrer"
              style={TRANSLATE_LINK_STYLE}
              aria-label={String(
                t("admin.pcTranslateTo", {
                  language: String(t(LANGUAGE_NAME_KEYS[locale])),
                }),
              )}
              data-testid={`${testId}-translate`}
            >
              {String(t("admin.pcTranslate"))}
              <ExternalLink size={14} aria-hidden />
            </a>
          ) : (
            // Nothing to translate yet: the same label, inert and muted, so
            // the row keeps its shape (a hidden stand-in would leave an empty
            // line once the row wraps). Not a link: no href, no tab stop.
            <span
              aria-hidden
              style={TRANSLATE_INERT_STYLE}
              data-testid={`${testId}-translate-inert`}
            >
              {String(t("admin.pcTranslate"))}
              <ExternalLink size={14} aria-hidden />
            </span>
          )
        ) : null}
      </XStack>
      {error ? (
        <Text id={errorId} role="alert" variant="caption" tone="error">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}
