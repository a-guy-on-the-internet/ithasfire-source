"use client";

import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ElementRef,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import { ArrowRight, Search } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import {
  AutocompleteField,
  type AutocompleteSection,
} from "../forms/AutocompleteField";
import { Button } from "../forms/Button";
import { Spinner } from "../feedback/Spinner";
import { Text } from "../typography/Text";
import { TextInput, type TextInputProps } from "../forms/TextInput";

type SuggestionMeta = {
  /** Primary label shown for the suggestion (typically the event title). */
  title: string;
  /** Optional supporting text rendered beneath the title (date, venue, etc.). */
  subtitle?: string;
  /** Optional right-aligned helper text, such as location or status. */
  helper?: string;
};

export interface EventSearchSuggestion extends SuggestionMeta {
  id: string;
  /** Optional event slug so callers can deep-link directly to detail pages. */
  slug?: string;
}

const DEFAULT_SECTION_ID = "events";

// Row-targeting states use the muted wash + the 3px `$accent` left rule, never
// `$surfaceStrong`: that token IS the ink on Stub (#211C16 === `$color`), so it
// painted this row's own ink title at 1.00:1 and the highlighted option went
// blank. See AutocompleteField's SuggestionRowHighlight for the full rationale.
const SuggestionButton = styled(Button, {
  name: "EventSearchSuggestionButton",
  justifyContent: "flex-start",
  alignItems: "stretch",
  gap: "$3",
  paddingHorizontal: "$3",
  paddingVertical: "$3",
  width: "100%",
  minHeight: 0,
  borderRadius: 0,
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  focusStyle: {
    outlineWidth: 0,
  },
  focusVisibleStyle: {
    outlineWidth: 0,
    backgroundColor: "$surfaceMuted",
    borderLeftColor: "$accent",
  },
  pressStyle: {
    backgroundColor: "$surfaceMuted",
    borderLeftColor: "$accent",
    scale: 0.98,
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$surfaceMuted",
        borderLeftColor: "$accent",
      },
      false: {},
    },
  },
});

const SuggestionBody = styled(XStack, {
  name: "EventSearchSuggestionBody",
  width: "100%",
  maxWidth: "100%",
  gap: "$3",
  alignItems: "center",
  minWidth: 0,
});

const SuggestionTextColumn = styled(YStack, {
  name: "EventSearchSuggestionTextColumn",
  flex: 1,
  gap: 2,
  minWidth: 0,
  maxWidth: "100%",
});

const SuggestionTitle = styled(Text, {
  name: "EventSearchSuggestionTitle",
  variant: "body" as const,
  weight: "bold" as const,
  whiteSpace: "normal" as const,
});

const SuggestionSubtitle = styled(Text, {
  name: "EventSearchSuggestionSubtitle",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  whiteSpace: "normal" as const,
});

const SuggestionHelper = styled(Text, {
  name: "EventSearchSuggestionHelper",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  textAlign: "right" as const,
  flexShrink: 0,
  maxWidth: 140,
  whiteSpace: "normal" as const,
  overflow: "hidden" as const,
});

const SuggestionArrow = styled(XStack, {
  name: "EventSearchSuggestionArrow",
  alignItems: "center",
  justifyContent: "center",
  opacity: 0,
  variants: {
    active: {
      true: {
        opacity: 1,
      },
    },
  },
});

const IconWrapper = styled(XStack, {
  name: "EventSearchLeadingIcon",
  alignItems: "center",
  justifyContent: "center",
});

const SpinnerWrapper = styled(XStack, {
  name: "EventSearchSpinnerWrapper",
  alignItems: "center",
  justifyContent: "center",
});

const DefaultEmptyState = styled(Text, {
  name: "EventSearchEmptyState",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  paddingVertical: "$4",
  textAlign: "center",
});

const KeyboardHint = styled(Text, {
  name: "EventSearchKeyboardHint",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  fontSize: 11,
  letterSpacing: 0.5,
});

export interface EventSearchAutocompleteProps {
  /** Current query string shown in the input. */
  query: string;
  /** Called when the query string changes. */
  onQueryChange: (nextQuery: string) => void;
  /** Invoked when the user presses enter without selecting a suggestion. */
  onSubmit?: (query: string) => void;
  /** Collection of suggestions to present underneath the input. */
  suggestions: EventSearchSuggestion[];
  /** Invoked whenever the user chooses a suggestion from the list. */
  onSelectSuggestion?: (suggestion: EventSearchSuggestion) => void;
  /** Renders while new suggestions are being fetched. */
  loading?: boolean;
  /** Placeholder text for the query input. */
  placeholder?: string;
  /** Custom content to render when no suggestions are available. */
  emptyState?: ReactNode;
  /** Automatically updates the input with the selected suggestion's title. */
  autoFillOnSelect?: boolean;
  /** Maximum visible suggestions before scrolling. */
  maxVisibleSuggestions?: number;
  /** Optional props forwarded to the underlying TextInput. */
  inputProps?: Omit<TextInputProps, "value" | "onChangeText" | "onKeyDown">;
  /** Base identifier used for test/qa tags. */
  testIdBase?: string;
  qaId?: string;
}

type TextInputElement = ElementRef<typeof TextInput>;

// Keyboard handling is owned by AutocompleteField.

export const EventSearchAutocomplete: React.ForwardRefExoticComponent<
  EventSearchAutocompleteProps & React.RefAttributes<TextInputElement>
> = forwardRef(
  (
    {
      query,
      onQueryChange,
      onSubmit,
      suggestions,
      onSelectSuggestion: externalOnSelectSuggestion,
      loading = false,
      placeholder = "Search artists, places, or cities",
      emptyState,
      autoFillOnSelect = true,
      maxVisibleSuggestions = 8,
      inputProps,
      testIdBase = "event-search",
      qaId,
    },
    ref,
  ) => {
    const resolvedQaId = qaId ?? testIdBase;
    const trimmedQuery = query.trim();
    const hasQuery = trimmedQuery.length > 0;
    const visibleSuggestions = useMemo(
      () => (hasQuery ? suggestions.slice(0, maxVisibleSuggestions) : []),
      [hasQuery, maxVisibleSuggestions, suggestions],
    );

    const sections = useMemo<AutocompleteSection<EventSearchSuggestion>[]>(
      () =>
        hasQuery && visibleSuggestions.length
          ? [{ id: DEFAULT_SECTION_ID, items: visibleSuggestions }]
          : [],
      [hasQuery, visibleSuggestions],
    );

    const dropdownEmptyState = hasQuery
      ? (emptyState ?? <DefaultEmptyState>No events found.</DefaultEmptyState>)
      : null;
    const resolvedLoading = hasQuery && loading;
    // No local highlighted index; AutocompleteField provides per-row `active`.

    const handleSuggestionSelected = useCallback(
      (suggestion?: EventSearchSuggestion) => {
        if (!suggestion) return;
        if (autoFillOnSelect) {
          onQueryChange(suggestion.title);
        }
        externalOnSelectSuggestion?.(suggestion);
        onSubmit?.(suggestion.title);
        // AutocompleteField manages actives; nothing to reset here.
      },
      [autoFillOnSelect, externalOnSelectSuggestion, onQueryChange, onSubmit],
    );

    type AugmentedInputProps = Omit<
      TextInputProps,
      "value" | "onChangeText" | "onKeyDown"
    > & {
      ref?: React.Ref<unknown>;
    };

    const mergedInputProps = useMemo<AugmentedInputProps>(
      () => ({
        ...(inputProps ?? {}),
        ref: ref as React.Ref<unknown>,
        autoComplete: inputProps?.autoComplete ?? "off",
        autoCorrect: inputProps?.autoCorrect ?? false,
        paddingLeft: inputProps?.paddingLeft ?? "$6",
        paddingVertical: inputProps?.paddingVertical ?? "$3",
        height: inputProps?.height ?? 48,
        fullWidth: true,
      }),
      [inputProps, ref],
    );

    const trailingAccessory = resolvedLoading ? (
      <SpinnerWrapper>
        <Spinner
          size="sm"
          indicatorColor="$colorMuted"
          qaId={`${testIdBase}-loading-spinner`}
          testID={`${testIdBase}-loading-spinner`}
          screenReaderLabel="Loading events"
        />
      </SpinnerWrapper>
    ) : hasQuery ? (
      <KeyboardHint>⏎</KeyboardHint>
    ) : null;

    return (
      <AutocompleteField
        query={query}
        onQueryChange={onQueryChange}
        data={{ sections }}
        getSuggestionId={(suggestion) => suggestion.id}
        renderRow={({ suggestion, onSelect, testId, active }) => (
          <SuggestionButton
            size="$2"
            variant="ghost"
            onPress={onSelect}
            active={active}
            data-testid={testId}
          >
            <SuggestionBody>
              <SuggestionTextColumn>
                <SuggestionTitle>{suggestion.title}</SuggestionTitle>
                {suggestion.subtitle ? (
                  <SuggestionSubtitle>{suggestion.subtitle}</SuggestionSubtitle>
                ) : null}
              </SuggestionTextColumn>
              {suggestion.helper ? (
                <SuggestionHelper>{suggestion.helper}</SuggestionHelper>
              ) : null}
              <SuggestionArrow active={active}>
                <ArrowRight size={16} strokeWidth={2} color="currentColor" />
              </SuggestionArrow>
            </SuggestionBody>
          </SuggestionButton>
        )}
        onSelectSuggestion={(suggestion) =>
          handleSuggestionSelected(suggestion)
        }
        onSubmitQuery={onSubmit}
        placeholder={placeholder}
        emptyState={dropdownEmptyState}
        loading={resolvedLoading}
        loadingLabel="Searching events…"
        testIdBase={testIdBase}
        qaId={resolvedQaId}
        leadingAccessory={
          <IconWrapper>
            <Search
              size={18}
              strokeWidth={2.5}
              aria-hidden
              color="currentColor"
            />
          </IconWrapper>
        }
        leadingAccessoryInset="$2"
        trailingAccessory={trailingAccessory}
        trailingAccessoryInset="$2"
        dropdownOverlay
        dropdownTone="overlay"
        inputProps={mergedInputProps}
      />
    );
  },
);

EventSearchAutocomplete.displayName = "EventSearchAutocomplete";
