"use client";

import {
  forwardRef,
  useCallback,
  useMemo,
  type ElementRef,
  type ReactNode,
} from "react";
import { ArrowRight, Calendar, MapPin, User, Building2 } from "lucide-react";
import { XStack, YStack, styled, useTheme } from "tamagui";

import {
  AutocompleteField,
  type AutocompleteSection,
} from "../forms/AutocompleteField";
import { Button } from "../forms/Button";
import { Spinner } from "../feedback/Spinner";
import { Text } from "../typography/Text";
import { TextInput, type TextInputProps } from "../forms/TextInput";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type UnifiedSuggestionType =
  | "event"
  | "human"
  | "place"
  | "organization";

interface BaseUnifiedSuggestion {
  type: UnifiedSuggestionType;
  id: string;
  title: string;
  subtitle?: string | null;
  helper?: string | null;
}

export interface UnifiedEventSuggestion extends BaseUnifiedSuggestion {
  type: "event";
  eventId: string;
  slug?: string | null;
  /** ISO 8601 start timestamp. Optional so callers that don't pass it
   *  through (legacy code paths) still type-check; consumers that sort
   *  by date + time should prefer this over the human-readable `helper`. */
  startsAt?: string | null;
}

export interface UnifiedHumanSuggestion extends BaseUnifiedSuggestion {
  type: "human";
  humanId: string;
  username?: string | null;
  profileSlug?: string | null;
}

export interface UnifiedPlaceSuggestion extends BaseUnifiedSuggestion {
  type: "place";
  placeId: string;
  /**
   * The venue's `EntityPage.slug` — the ONLY value `/places/[slug]` resolves
   * on, and a venue's only slug. Exactly what `profileSlug` is for a human
   * suggestion. Null/absent ⇒ the venue has no entity page; route to
   * `/places/id/{placeId}` instead of emitting a known 404.
   *
   * There is deliberately no plain `slug` here (unlike the event and org
   * suggestions): that carried `Place.slug`, a multi-segment DIRECTORY key
   * this single-segment route could never match, and it is deprecated.
   */
  pageSlug?: string | null;
  city?: string | null;
}

export interface UnifiedOrganizationSuggestion extends BaseUnifiedSuggestion {
  type: "organization";
  orgId: string;
  slug: string;
}

export type UnifiedSearchSuggestion =
  | UnifiedEventSuggestion
  | UnifiedHumanSuggestion
  | UnifiedPlaceSuggestion
  | UnifiedOrganizationSuggestion;

const DEFAULT_SECTION_ID = "unified";

// ─────────────────────────────────────────────────────────────────────────────
// Type Metadata
// ─────────────────────────────────────────────────────────────────────────────

// No per-type `color`: the three non-event hues were `$blue10`/`$green10`/
// `$purple10`, which are Tamagui default-palette names this config never
// registers (it ships only the stub/swiss/ember themes). They resolved to
// nothing, so those icons fell back to `currentColor` — ink — on the ink
// `$surfaceStrong` tile, i.e. 3 of the 4 type icons were invisible on Stub.
// Restoring the coding would need 4 new hues x 3 themes and would blow the §4
// accent budget for a signal the row already carries twice: the icon SHAPE and
// the adjacent uppercase TypeLabel ("Event"/"Person"/"Place"/"Group"). Per §6
// icons ride `currentColor` and never carry their own color, so the tile owns
// the foreground.
const TYPE_META: Record<
  UnifiedSuggestionType,
  { icon: typeof Calendar; label: string }
> = {
  event: { icon: Calendar, label: "Event" },
  human: { icon: User, label: "Person" },
  place: { icon: MapPin, label: "Place" },
  organization: { icon: Building2, label: "Group" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled Components
// ─────────────────────────────────────────────────────────────────────────────

// Row-targeting states use the muted wash + the 3px `$accent` left rule, never
// `$surfaceStrong`: that token IS the ink on Stub (#211C16 === `$color`), so it
// painted this row's own ink title at 1.00:1 and the highlighted option went
// blank. See AutocompleteField's SuggestionRowHighlight for the full rationale.
const SuggestionButton = styled(Button, {
  name: "UnifiedSearchSuggestionButton",
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
  name: "UnifiedSearchSuggestionBody",
  width: "100%",
  maxWidth: "100%",
  gap: "$3",
  alignItems: "center",
  minWidth: 0,
});

// The tile keeps the strong ink fill (it is a deliberate type marker, and it
// reads against both the resting `$surface` and the active `$surfaceMuted`
// wash), so it MUST hand its glyph `$onStructure` — the only foreground that
// clears AA on `$surfaceStrong` in all three themes (16.2 / 7.0 / 9.5). The
// colour is passed to the icon at the call site from `useTheme()`: this
// component also renders on native, so it cannot use the `var(--onStructure)`
// form that the web-only call sites use, and an XStack is a View and takes no
// `color` style prop for the glyph to inherit.
const TypeIconWrapper = styled(XStack, {
  name: "UnifiedSearchTypeIcon",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 0,
  backgroundColor: "$surfaceStrong",
  flexShrink: 0,
});

const SuggestionTextColumn = styled(YStack, {
  name: "UnifiedSearchSuggestionTextColumn",
  flex: 1,
  gap: 2,
  minWidth: 0,
  maxWidth: "100%",
});

const SuggestionTitleRow = styled(XStack, {
  name: "UnifiedSearchTitleRow",
  gap: "$2",
  alignItems: "center",
});

const SuggestionTitle = styled(Text, {
  name: "UnifiedSearchSuggestionTitle",
  variant: "body" as const,
  weight: "bold" as const,
  whiteSpace: "normal" as const,
  flex: 1,
});

const TypeLabel = styled(Text, {
  name: "UnifiedSearchTypeLabel",
  variant: "caption" as const,
  tone: "muted" as const,
  textTransform: "uppercase" as const,
  letterSpacing: 0.5,
  flexShrink: 0,
});

const SuggestionSubtitle = styled(Text, {
  name: "UnifiedSearchSuggestionSubtitle",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  whiteSpace: "normal" as const,
});

const SuggestionHelper = styled(Text, {
  name: "UnifiedSearchSuggestionHelper",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  textAlign: "right" as const,
  flexShrink: 0,
  maxWidth: 140,
  whiteSpace: "normal" as const,
  overflow: "hidden" as const,
});

const SuggestionArrow = styled(XStack, {
  name: "UnifiedSearchSuggestionArrow",
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

const SpinnerWrapper = styled(XStack, {
  name: "UnifiedSearchSpinnerWrapper",
  alignItems: "center",
  justifyContent: "center",
});

const DefaultEmptyState = styled(Text, {
  name: "UnifiedSearchEmptyState",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  paddingVertical: "$4",
  textAlign: "center",
});

const KeyboardHint = styled(Text, {
  name: "UnifiedSearchKeyboardHint",
  variant: "bodySmall" as const,
  tone: "muted" as const,
  fontSize: 11,
  letterSpacing: 0.5,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component Props
// ─────────────────────────────────────────────────────────────────────────────

export interface UnifiedSearchAutocompleteProps {
  /** Current query string shown in the input. */
  query: string;
  /** Called when the query string changes. */
  onQueryChange: (nextQuery: string) => void;
  /** Invoked when the user presses enter without selecting a suggestion. */
  onSubmit?: (query: string) => void;
  /** Collection of unified suggestions to present underneath the input. */
  suggestions: UnifiedSearchSuggestion[];
  /** Invoked whenever the user chooses a suggestion from the list. */
  onSelectSuggestion?: (suggestion: UnifiedSearchSuggestion) => void;
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

// ─────────────────────────────────────────────────────────────────────────────
// Component Implementation
// ─────────────────────────────────────────────────────────────────────────────

export const UnifiedSearchAutocomplete: React.ForwardRefExoticComponent<
  UnifiedSearchAutocompleteProps & React.RefAttributes<TextInputElement>
> = forwardRef(
  (
    {
      query,
      onQueryChange,
      onSubmit,
      suggestions,
      onSelectSuggestion: externalOnSelectSuggestion,
      loading = false,
      placeholder = "Search events, artists, places, organizers...",
      emptyState,
      autoFillOnSelect = true,
      maxVisibleSuggestions = 8,
      inputProps,
      testIdBase = "unified-search",
      qaId,
    },
    ref,
  ) => {
    const theme = useTheme();
    // Foreground for the ink TypeIconWrapper tile — see its note above.
    const typeIconColor = theme.onStructure?.val;
    const resolvedQaId = qaId ?? testIdBase;
    const trimmedQuery = query.trim();
    const hasQuery = trimmedQuery.length > 0;
    const visibleSuggestions = useMemo(
      () => (hasQuery ? suggestions.slice(0, maxVisibleSuggestions) : []),
      [hasQuery, maxVisibleSuggestions, suggestions],
    );

    const sections = useMemo<AutocompleteSection<UnifiedSearchSuggestion>[]>(
      () =>
        hasQuery && visibleSuggestions.length
          ? [{ id: DEFAULT_SECTION_ID, items: visibleSuggestions }]
          : [],
      [hasQuery, visibleSuggestions],
    );

    const dropdownEmptyState = hasQuery
      ? (emptyState ?? <DefaultEmptyState>No results found.</DefaultEmptyState>)
      : null;
    const resolvedLoading = hasQuery && loading;

    const handleSuggestionSelected = useCallback(
      (suggestion?: UnifiedSearchSuggestion) => {
        if (!suggestion) return;
        if (autoFillOnSelect) {
          onQueryChange(suggestion.title);
        }
        externalOnSelectSuggestion?.(suggestion);
        onSubmit?.(suggestion.title);
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
          screenReaderLabel="Loading results"
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
        renderRow={({ suggestion, onSelect, testId, active }) => {
          const meta = TYPE_META[suggestion.type];
          const TypeIcon = meta.icon;

          return (
            <SuggestionButton
              size="$2"
              variant="ghost"
              onPress={onSelect}
              active={active}
              data-testid={testId}
            >
              <SuggestionBody>
                <TypeIconWrapper>
                  <TypeIcon size={16} strokeWidth={2} color={typeIconColor} />
                </TypeIconWrapper>
                <SuggestionTextColumn>
                  <SuggestionTitleRow>
                    <SuggestionTitle>{suggestion.title}</SuggestionTitle>
                    <TypeLabel>{meta.label}</TypeLabel>
                  </SuggestionTitleRow>
                  {suggestion.subtitle ? (
                    <SuggestionSubtitle>
                      {suggestion.subtitle}
                    </SuggestionSubtitle>
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
          );
        }}
        onSelectSuggestion={(suggestion) =>
          handleSuggestionSelected(suggestion)
        }
        onSubmitQuery={onSubmit}
        placeholder={placeholder}
        emptyState={dropdownEmptyState}
        loading={resolvedLoading}
        loadingLabel="Searching..."
        testIdBase={testIdBase}
        qaId={resolvedQaId}
        trailingAccessory={trailingAccessory}
        trailingAccessoryInset="$2"
        dropdownOverlay
        dropdownTone="overlay"
        inputProps={mergedInputProps}
      />
    );
  },
);

UnifiedSearchAutocomplete.displayName = "UnifiedSearchAutocomplete";
