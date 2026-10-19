"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowRight, MapPin } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import {
  AutocompleteField,
  type AutocompleteSection,
} from "../forms/AutocompleteField";
import { Button } from "../forms/Button";
import { Spinner } from "../feedback/Spinner";
import { Text } from "../typography/Text";
import type { TextInputProps } from "../forms/TextInput";

// Row-targeting states use the muted wash + the 3px `$accent` left rule, never
// `$surfaceStrong`: that token IS the ink on Stub (#211C16 === `$color`), so it
// painted this row's own ink title at 1.00:1 and the highlighted option went
// blank. The rule (not the wash) is the load-bearing active signal — see
// AutocompleteField's SuggestionRowHighlight for the full rationale.
//
// The `active` variant is NOT optional. `AutocompleteField.moveActive` sets
// `activeSuggestionId` WITHOUT moving DOM focus, so `focusVisibleStyle` never
// fires while arrowing through the list. Without the rule, the only arrow-key
// signal is the wash itself — `$surfaceMuted` over `$surface` measures
// 1.18:1 (Stub) / 1.09:1 (Swiss) / 1.17:1 (Ember), far below WCAG 1.4.11's
// 3:1 floor for identifying a state.
const SuggestionButton = styled(Button, {
  name: "PlacesAutocompleteSuggestionButton",
  justifyContent: "flex-start",
  alignItems: "stretch",
  paddingVertical: "$3",
  paddingHorizontal: "$3",
  width: "100%",
  borderRadius: 0,
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  minHeight: 0,
  focusStyle: {
    outlineWidth: 0,
  },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineColor: "$focus",
    outlineStyle: "solid" as const,
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
  name: "PlacesAutocompleteSuggestionBody",
  width: "100%",
  gap: "$3",
  alignItems: "flex-start",
});

const SuggestionTextColumn = styled(YStack, {
  name: "PlacesAutocompleteSuggestionTextColumn",
  flex: 1,
  gap: "$1",
  minWidth: 0,
});

const SuggestionTitle = styled(Text, {
  name: "PlacesAutocompleteSuggestionTitle",
  weight: "semibold",
  whiteSpace: "normal",
  width: "100%",
});

const SuggestionSubtitle = styled(Text, {
  name: "PlacesAutocompleteSuggestionSubtitle",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  whiteSpace: "normal",
});

const SuggestionHelper = styled(Text, {
  name: "PlacesAutocompleteSuggestionHelper",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  textAlign: "right" as const,
  flexShrink: 0,
  maxWidth: 120,
  whiteSpace: "normal",
});

// Second, redundant active cue (v2 §9: never rely on colour alone). Mirrors
// the other four autocompletes.
const SuggestionArrow = styled(XStack, {
  name: "PlacesAutocompleteSuggestionArrow",
  alignItems: "center",
  justifyContent: "center",
  // This file's SuggestionBody is `flex-start` (unlike the other four, which
  // centre); pin the arrow so it tracks the row's optical centre regardless.
  alignSelf: "center",
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
  name: "PlacesAutocompleteLeadingIcon",
  alignItems: "center",
  justifyContent: "center",
});

const SpinnerWrapper = styled(XStack, {
  name: "PlacesAutocompleteSpinnerWrapper",
  alignItems: "center",
  justifyContent: "center",
});

export type PlacesAutocompleteSuggestion = {
  id: string;
  title: string;
  subtitle?: string;
  helper?: string;
};

export type PlacesAutocompleteSelectionMeta = {
  sectionId: string;
  sectionIndex: number;
  index: number;
};

export type PlacesAutocompleteFieldProps = {
  query: string;
  onQueryChange: (value: string) => void;
  suggestions: PlacesAutocompleteSuggestion[];
  onSelectSuggestion?: (
    suggestion: PlacesAutocompleteSuggestion,
    meta: PlacesAutocompleteSelectionMeta,
  ) => void;
  placeholder?: string;
  statusMessage?: string | null;
  loading?: boolean;
  emptyState?: ReactNode;
  maxVisibleSuggestions?: number;
  inputProps?: Omit<TextInputProps, "value" | "onChangeText">;
  testIdBase?: string;
  qaId?: string;
  minVisibleQueryLength?: number;
};

const DEFAULT_MAX_VISIBLE = 8;
const DEFAULT_TEST_ID = "places-autocomplete";
const DEFAULT_SECTION_ID = "places";

export const PlacesAutocompleteField = ({
  query,
  onQueryChange,
  suggestions,
  onSelectSuggestion,
  placeholder = "Location",
  statusMessage,
  loading = false,
  emptyState,
  maxVisibleSuggestions = DEFAULT_MAX_VISIBLE,
  inputProps,
  testIdBase,
  qaId,
  minVisibleQueryLength = 1,
}: PlacesAutocompleteFieldProps) => {
  const trimmedQuery = query.trim();
  const meetsMinLength = trimmedQuery.length >= minVisibleQueryLength;

  const limitedSuggestions = useMemo(
    () => (meetsMinLength ? suggestions.slice(0, maxVisibleSuggestions) : []),
    [maxVisibleSuggestions, meetsMinLength, suggestions],
  );

  const sections = useMemo<AutocompleteSection<PlacesAutocompleteSuggestion>[]>(
    () =>
      meetsMinLength && limitedSuggestions.length
        ? [{ id: DEFAULT_SECTION_ID, items: limitedSuggestions }]
        : [],
    [limitedSuggestions, meetsMinLength],
  );

  const resolvedTestId = testIdBase ?? DEFAULT_TEST_ID;
  const resolvedEmptyState = meetsMinLength ? emptyState : null;
  const resolvedLoading = meetsMinLength && loading;
  const trailingAccessory = resolvedLoading ? (
    <SpinnerWrapper>
      <Spinner
        size="sm"
        indicatorColor="$colorMuted"
        qaId={`${resolvedTestId}-loading-spinner`}
        testID={`${resolvedTestId}-loading-spinner`}
        screenReaderLabel="Loading locations"
      />
    </SpinnerWrapper>
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
      onSelectSuggestion={onSelectSuggestion}
      emptyState={resolvedEmptyState}
      placeholder={placeholder}
      statusMessage={statusMessage}
      inputProps={inputProps}
      testIdBase={resolvedTestId}
      qaId={qaId ?? resolvedTestId}
      leadingAccessory={
        <IconWrapper>
          <MapPin
            size={16}
            strokeWidth={1.5}
            aria-hidden="true"
            color="currentColor"
          />
        </IconWrapper>
      }
      leadingAccessoryInset="$3"
      trailingAccessory={trailingAccessory}
      trailingAccessoryInset="$3"
      dropdownOverlay
      dropdownTone="surface"
    />
  );
};

PlacesAutocompleteField.displayName = "PlacesAutocompleteField";
