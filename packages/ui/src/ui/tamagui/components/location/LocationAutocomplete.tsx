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

// ---------------------------------------------------------------------------
// Punky suggestion row styles - bold, confident, sharp edges
// ---------------------------------------------------------------------------

// Row-targeting states use the muted wash + the 3px `$accent` left rule, never
// `$surfaceStrong`: that token IS the ink on Stub (#211C16 === `$color`), so it
// painted this row's own ink title at 1.00:1 and the highlighted option went
// blank. The rule (not the wash) is the load-bearing active signal — see
// AutocompleteField's SuggestionRowHighlight for the full rationale.
const SuggestionButton = styled(Button, {
  name: "LocationAutocompleteSuggestionButton",
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
  name: "LocationAutocompleteSuggestionBody",
  width: "100%",
  maxWidth: "100%",
  gap: "$3",
  alignItems: "center",
  minWidth: 0,
});

const SuggestionTextColumn = styled(YStack, {
  name: "LocationAutocompleteSuggestionTextColumn",
  flex: 1,
  gap: 2,
  minWidth: 0,
  maxWidth: "100%",
});

const SuggestionTitle = styled(Text, {
  name: "LocationAutocompleteSuggestionTitle",
  weight: "bold",
  whiteSpace: "normal",
  width: "100%",
});

const SuggestionSubtitle = styled(Text, {
  name: "LocationAutocompleteSuggestionSubtitle",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  whiteSpace: "normal",
});

const SuggestionHelper = styled(Text, {
  name: "LocationAutocompleteSuggestionHelper",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  textAlign: "right" as const,
  flexShrink: 0,
  maxWidth: 120,
  whiteSpace: "normal",
  overflow: "hidden" as const,
});

const SuggestionArrow = styled(XStack, {
  name: "LocationAutocompleteSuggestionArrow",
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
  name: "LocationAutocompleteLeadingIcon",
  alignItems: "center",
  justifyContent: "center",
});

const SpinnerWrapper = styled(XStack, {
  name: "LocationAutocompleteSpinnerWrapper",
  alignItems: "center",
  justifyContent: "center",
});

export type LocationAutocompleteSuggestion = {
  id: string;
  title: string;
  subtitle?: string;
  helper?: string;
};

export type LocationAutocompleteSelectionMeta = {
  sectionId: string;
  sectionIndex: number;
  index: number;
};

export type LocationAutocompleteFieldProps = {
  query: string;
  onQueryChange: (value: string) => void;
  suggestions: LocationAutocompleteSuggestion[];
  onSelectSuggestion?: (
    suggestion: LocationAutocompleteSuggestion,
    meta: LocationAutocompleteSelectionMeta,
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
const DEFAULT_TEST_ID = "location-autocomplete";
const DEFAULT_SECTION_ID = "locations";

export const LocationAutocompleteField = ({
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
}: LocationAutocompleteFieldProps) => {
  const trimmedQuery = query.trim();
  const meetsMinLength = trimmedQuery.length >= minVisibleQueryLength;

  const limitedSuggestions = useMemo(
    () => (meetsMinLength ? suggestions.slice(0, maxVisibleSuggestions) : []),
    [maxVisibleSuggestions, meetsMinLength, suggestions],
  );

  const sections = useMemo<
    AutocompleteSection<LocationAutocompleteSuggestion>[]
  >(
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
      inputProps={{
        ...inputProps,
        paddingLeft: inputProps?.paddingLeft ?? "$6",
      }}
      testIdBase={resolvedTestId}
      qaId={qaId ?? resolvedTestId}
      leadingAccessory={
        <IconWrapper>
          <MapPin
            size={18}
            strokeWidth={2.5}
            aria-hidden="true"
            color="currentColor"
          />
        </IconWrapper>
      }
      leadingAccessoryInset="$2"
      trailingAccessory={trailingAccessory}
      trailingAccessoryInset="$2"
      dropdownOverlay
      dropdownTone="surface"
    />
  );
};

LocationAutocompleteField.displayName = "LocationAutocompleteField";
