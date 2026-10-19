"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import { XStack, YStack, styled } from "tamagui";

import { Spinner } from "../feedback/Spinner";
import { Text } from "../typography/Text";
import { TextInput, type TextInputProps } from "./TextInput";
import { Separator } from "../display/Separator";

const Container = styled(YStack, {
  name: "AutocompleteField",
  width: "100%",
  gap: "$2",
});

const InputGroup = styled(YStack, {
  name: "AutocompleteInputGroup",
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  alignSelf: "flex-start",
  position: "relative",
});

const DropdownSurface = styled(YStack, {
  name: "AutocompleteDropdown",
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  alignSelf: "flex-start",
  gap: "$2",
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  paddingTop: "$2",
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "$surface",
  opacity: 1,
  flexShrink: 0,
  // On web, long strings inside flex children can extend layout width unless we
  // explicitly allow the container to clip.
  overflow: "hidden",
  // Minimum height prevents layout jitter when switching between empty/populated states
  minHeight: 80,
  // Cap the expanded list so long result sets scroll instead of pushing the
  // page down. ~10 compact rows + section headers + the request-new footer
  // fit comfortably below this.
  maxHeight: 360,
  // styled() doesn't expose overflowY directly — set via `style` so the y
  // axis can scroll while x stays clipped by the `overflow: "hidden"` above.
  style: { overflowY: "auto" },
});

const SectionStack = styled(YStack, {
  name: "AutocompleteSection",
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  gap: "$1",
  paddingTop: "$1",
  paddingBottom: "$1",
});

const SectionContent = styled(YStack, {
  name: "AutocompleteSectionContent",
  width: "100%",
  maxWidth: "100%",
  // Tight row-to-row gap — rows already enforce their own minHeight, so this
  // is just breathing room. "$2" stacked with the section gap above was
  // doubling the visual padding.
  gap: "$0.5",
  paddingHorizontal: "$1",
  paddingTop: 0,
  minWidth: 0,
  overflow: "hidden",
});

const SectionFooter = styled(YStack, {
  name: "AutocompleteSectionFooter",
  width: "100%",
  gap: "$2",
  paddingTop: "$1",
});

const SectionDivider = styled(Separator, {
  name: "AutocompleteSectionDivider",
  width: "100%",
  height: 1,
  borderWidth: 0,
  backgroundColor: "$borderColor",
  opacity: 0.6,
});

// Active-row wash. Deliberately `$surfaceMuted`, NEVER `$surfaceStrong`: the
// strong token is the ink itself on Stub (#211C16 === `$color`), so it painted
// the highlighted option's own label ink-on-ink at 1.00:1 — the active row went
// blank exactly when the user arrowed onto it. It fails on Swiss too (#35589A
// vs #181818 = 2.55:1). Rows render fixed-ink foregrounds (`$color` titles,
// `$colorMuted` subtitles) that cannot invert per-row, so the fill has to stay
// light: `$surfaceMuted` keeps every foreground AA in all three themes
// (title 13.7/16.3/13.4, subtitle 6.1/4.5/6.1) and is the only surface token
// that is also distinguishable from `$surface` in all three. The wash is
// intentionally quiet — the load-bearing "this row is active" signal is the
// consumer's 3px `$accent` left rule, which is a position cue and so does not
// rely on color alone. That rule sits ON the active row, so the ratio that
// matters is `$accent` vs this `$surfaceMuted` fill: 3.30/6.39/4.23
// (stub/swiss/ember) — clears WCAG 1.4.11's 3:1. (Against the RESTING
// `$surface` it is 3.89/6.97/4.96; that pair is what the earlier
// "3.9/7.0/5.0" note here measured, which was the wrong substrate.)
// Enforced by `__tests__/contrast-pairs.test.ts`.
const SuggestionRowHighlight = styled(YStack, {
  name: "AutocompleteSuggestionRowHighlight",
  width: "100%",
  borderRadius: 0,
  backgroundColor: "transparent",
  variants: {
    active: {
      true: {
        backgroundColor: "$surfaceMuted",
      },
    },
  },
});

const EmptyStateWrapper = styled(YStack, {
  name: "AutocompleteEmptyState",
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: "$4",
  gap: "$2",
  backgroundColor: "$surface",
  opacity: 1,
  // Minimum height prevents layout jitter when switching between empty/populated
  minHeight: 60,
});

const StatusRow = styled(XStack, {
  name: "AutocompleteStatus",
  gap: "$2",
  alignItems: "center",
});

const InputLabel = styled(Text, {
  name: "AutocompleteFieldLabel",
  position: "absolute",
  top: "$1",
  pointerEvents: "none",
});

const LeadingAccessory = styled(XStack, {
  name: "AutocompleteFieldLeadingAccessory",
  position: "absolute",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  top: 0,
  bottom: 0,
  height: "100%",
});

const TrailingAccessory = styled(XStack, {
  name: "AutocompleteFieldTrailingAccessory",
  position: "absolute",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  top: 0,
  bottom: 0,
  height: "100%",
});

const DEFAULT_TEST_ID = "autocomplete-field";

export type AutocompleteSection<TSuggestion> = {
  id: string;
  title?: ReactNode;
  items?: TSuggestion[];
  content?: ReactNode;
  footer?: ReactNode;
};

export type AutocompleteRenderRowArgs<TSuggestion> = {
  suggestion: TSuggestion;
  section: AutocompleteSection<TSuggestion>;
  sectionIndex: number;
  index: number;
  onSelect: () => void;
  testId: string;
  active: boolean;
};

export type AutocompleteSections<TSuggestion> = {
  /** Grouped/advanced dropdown content (one or more sections). */
  sections: AutocompleteSection<TSuggestion>[];
};

export type AutocompleteFieldProps<TSuggestion> = {
  query: string;
  onQueryChange: (value: string) => void;
  /** Data for the dropdown (one or more sections). */
  data: AutocompleteSections<TSuggestion>;
  getSuggestionId: (
    suggestion: TSuggestion,
    context: { sectionId: string; sectionIndex: number; index: number },
  ) => string;
  /** Pure row formatting. AutocompleteField owns all interaction mechanics. */
  renderRow: (args: AutocompleteRenderRowArgs<TSuggestion>) => ReactNode;
  onSelectSuggestion?: (
    suggestion: TSuggestion,
    meta: { sectionId: string; sectionIndex: number; index: number },
  ) => void;
  /**
   * Called when the user presses Enter without an active (highlighted) suggestion.
   * Consumers can use this to submit the raw query text.
   */
  onSubmitQuery?: (query: string) => void;
  placeholder?: string;
  statusMessage?: string | null;
  loading?: boolean;
  loadingLabel?: string;
  emptyState?: ReactNode;
  inputProps?: Omit<
    TextInputProps,
    "value" | "onChangeText" | "testId" | "qaId"
  >;
  testIdBase?: string;
  qaId?: string;
  renderSectionHeader?: (
    section: AutocompleteSection<TSuggestion>,
  ) => ReactNode;
  label?: string;
  labelInset?: number | string;
  leadingAccessory?: ReactNode;
  leadingAccessoryInset?: number | string;
  dropdownOverlay?: boolean;
  /**
   * z-index for the floating dropdown surface (only applies when
   * `dropdownOverlay` is set). Defaults to 200, which clears in-form floating
   * UI (prose toolbar 40, image picker 120). Raise it above page chrome such
   * as the contextual action bar (z-index 1100) when the field sits low enough
   * that the open menu would otherwise be obscured by that chrome.
   */
  dropdownZIndex?: number;
  dropdownTone?: "surface" | "overlay";
  trailingAccessory?: ReactNode;
  trailingAccessoryInset?: number | string;
};

const hasSectionContent = <T,>(section: AutocompleteSection<T>) => {
  if (section.content) return true;
  if (section.items && section.items.length > 0) return true;
  return false;
};

export const AutocompleteField = <TSuggestion,>({
  query,
  onQueryChange,
  data,
  getSuggestionId,
  renderRow,
  onSelectSuggestion,
  onSubmitQuery,
  placeholder = "Search",
  statusMessage,
  loading = false,
  loadingLabel = "Searching…",
  emptyState,
  inputProps,
  testIdBase,
  qaId,
  renderSectionHeader,
  label,
  labelInset,
  leadingAccessory,
  leadingAccessoryInset,
  dropdownOverlay = false,
  dropdownZIndex = 200,
  dropdownTone = "overlay",
  trailingAccessory,
  trailingAccessoryInset,
}: AutocompleteFieldProps<TSuggestion>) => {
  const resolvedTestId = testIdBase ?? DEFAULT_TEST_ID;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<any>(null);

  const {
    onLayout: providedOnLayout,
    paddingVertical: providedPaddingVertical,
    onFocus: providedOnFocus,
    onBlur: providedOnBlur,
    ...restInputProps
  } = inputProps ?? {};
  // `TextInput` doesn’t support a `fullWidth` prop, but some legacy callers may
  // still pass it through `inputProps`. Read it loosely and translate to width.
  const providedFullWidth = (inputProps as any)?.fullWidth as
    | boolean
    | undefined;
  const providedWidth = restInputProps.width;
  const hasExplicitWidth =
    providedWidth !== undefined && providedWidth !== null;
  const resolvedInputFullWidth = providedFullWidth ?? !hasExplicitWidth;

  const [inputWidth, setInputWidth] = useState<number | null>(null);
  const [hasInteracted, setHasInteracted] = useState(
    () => query.trim().length > 0,
  );
  const [isFocused, setIsFocused] = useState(false);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(
    null,
  );

  const handleInputLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setInputWidth(event.nativeEvent.layout.width);
      providedOnLayout?.(event);
    },
    [providedOnLayout],
  );

  useEffect(() => {
    if (!hasInteracted && query.trim().length > 0) {
      setHasInteracted(true);
    }
  }, [hasInteracted, query]);

  // Reset keyboard highlight when the query changes.
  useEffect(() => {
    setActiveSuggestionId(null);
  }, [query]);

  const handleFocus = useCallback<NonNullable<TextInputProps["onFocus"]>>(
    (event) => {
      setIsFocused(true);
      if (!hasInteracted) {
        setHasInteracted(true);
      }
      providedOnFocus?.(event);
    },
    [hasInteracted, providedOnFocus],
  );

  const handleBlur = useCallback<NonNullable<TextInputProps["onBlur"]>>(
    (event) => {
      // On web, we keep the dropdown open while focus moves inside the component
      // (input -> suggestion rows) via the container's native `focusout` handler.
      if (typeof window === "undefined") {
        // Small delay so that a click on a suggestion can still register before
        // the dropdown disappears.
        setTimeout(() => {
          setIsFocused(false);
        }, 200);
      }
      providedOnBlur?.(event);
    },
    [providedOnBlur],
  );

  // (web focus/keydown binding is declared later, after moveActive/commitActive)

  // On web, tabbing from the input into a suggestion would normally blur the input.
  // We want the dropdown to remain visible while focus is anywhere inside the
  // input + dropdown group, so rely on focusin/focusout bubbling at the group level.
  const handleGroupFocusCapture = useCallback(() => {
    setIsFocused(true);
    if (!hasInteracted) {
      setHasInteracted(true);
    }
  }, [hasInteracted]);

  const handleGroupBlurCapture = useCallback((event: any) => {
    const nextTarget = event?.relatedTarget as HTMLElement | null | undefined;
    // If focus is moving to another element inside the same group, keep open.
    if (
      nextTarget &&
      (event?.currentTarget as HTMLElement | null)?.contains(nextTarget)
    ) {
      return;
    }

    setTimeout(() => {
      setIsFocused(false);
    }, 0);
  }, []);

  const handleChangeText = useCallback<
    NonNullable<TextInputProps["onChangeText"]>
  >(
    (value) => {
      if (!hasInteracted) {
        setHasInteracted(true);
      }
      onQueryChange(value);
    },
    [hasInteracted, onQueryChange],
  );

  // The GROUP must never take its width from a descendant. `inputWidth` is
  // measured off the TextInput *inside* this group (its `onLayout` below), so
  // feeding it back into the group's own `width` closes a layout loop: the
  // first pass renders the group at "100%", the input measures (say) 600px,
  // and the group then becomes a FIXED 600px that no longer tracks its
  // container. From there the loop only ever ratchets DOWN — any relayout
  // that measures the input narrower pins the group narrower, and it can
  // never grow back. Saving the event builder's category field did exactly
  // that: `loading` flips true, the dropdown surface unmounts, the input
  // re-measures mid-transition, and the field collapsed from full width to
  // just the chevron hugging the left edge.
  const resolvedGroupWidth =
    providedWidth ?? (resolvedInputFullWidth ? "100%" : undefined);

  // The overlay, by contrast, is absolutely positioned OUT of the group's
  // flow, so it has no container to inherit from and genuinely needs the
  // measured pixel width to line up with the input it hangs beneath. This is
  // the one correct consumer of `inputWidth`.
  const resolvedOverlayWidth =
    inputWidth ??
    providedWidth ??
    (resolvedInputFullWidth ? "100%" : undefined);

  const sections = useMemo<AutocompleteSection<TSuggestion>[]>(
    () => data.sections,
    [data.sections],
  );
  const hasAnySectionContent = sections.some(hasSectionContent);
  const queryHasValue = query.trim().length > 0;
  const shouldShowEmptyState =
    queryHasValue && !loading && !hasAnySectionContent && Boolean(emptyState);
  const hasConnectedSurface = hasAnySectionContent || shouldShowEmptyState;
  const shouldConnectSurface = dropdownOverlay
    ? false
    : hasInteracted && isFocused && hasConnectedSurface;
  const hasLabel = Boolean(label);
  const resolvedLabelInset = labelInset ?? (leadingAccessory ? "$7" : "$3");
  const resolvedAccessoryInset = leadingAccessoryInset ?? "$3";
  const hasTrailingAccessory = Boolean(trailingAccessory);
  const resolvedTrailingInset = trailingAccessoryInset ?? "$3";
  const resolvedPaddingLeft =
    restInputProps.paddingLeft ?? (leadingAccessory ? "$7" : undefined);
  const resolvedPaddingRight =
    restInputProps.paddingRight ?? (hasTrailingAccessory ? "$7" : undefined);
  // When overriding individual padding sides we must also clear
  // `paddingHorizontal` so the shorthand class from the styled
  // definition doesn't win due to atomic-CSS insertion order.
  // Any side we don't explicitly override falls back to the base "$3".
  const needsSideOverride =
    resolvedPaddingLeft != null || resolvedPaddingRight != null;
  const computedInputProps: TextInputProps = {
    ...restInputProps,
    ...(needsSideOverride ? { paddingHorizontal: undefined as any } : {}),
    paddingLeft: resolvedPaddingLeft ?? (needsSideOverride ? "$3" : undefined),
    paddingTop: restInputProps.paddingTop ?? (hasLabel ? "$5" : undefined),
    paddingBottom:
      restInputProps.paddingBottom ?? (hasLabel ? "$1" : undefined),
    paddingRight:
      resolvedPaddingRight ?? (needsSideOverride ? "$3" : undefined),
    height: restInputProps.height ?? (hasLabel ? 56 : undefined),
  };
  const accessoryTop = hasLabel ? 28 : undefined;
  const accessoryBottom = hasLabel ? 6 : undefined;

  type FlatSuggestion = {
    suggestion: TSuggestion;
    suggestionId: string;
    section: AutocompleteSection<TSuggestion>;
    sectionIndex: number;
    index: number;
    testId: string;
  };

  const flatSuggestions = useMemo<FlatSuggestion[]>(() => {
    const result: FlatSuggestion[] = [];
    sections.forEach((section, sectionIndex) => {
      const items = section.items ?? [];
      items.forEach((suggestion, index) => {
        const suggestionId = getSuggestionId(suggestion, {
          sectionId: section.id,
          sectionIndex,
          index,
        });
        const testId = `${resolvedTestId}-section-${section.id}-suggestion-${suggestionId}`;
        result.push({
          suggestion,
          suggestionId,
          section,
          sectionIndex,
          index,
          testId,
        });
      });
    });
    return result;
  }, [getSuggestionId, resolvedTestId, sections]);

  const dropdownContent = hasAnySectionContent ? (
    (() => {
      const nodes: ReactNode[] = [];
      sections.forEach((section, sectionIndex) => {
        if (!hasSectionContent(section)) {
          return;
        }

        if (nodes.length > 0) {
          nodes.push(<SectionDivider key={`${section.id}-divider`} />);
        }

        const header = renderSectionHeader
          ? renderSectionHeader(section)
          : section.title &&
            (typeof section.title === "string" ? (
              <Text variant="overline" tone="muted">
                {section.title}
              </Text>
            ) : (
              section.title
            ));

        const items = section.items ?? [];

        nodes.push(
          <SectionStack key={section.id}>
            {header ?? null}
            {section.content ? (
              <SectionContent>{section.content}</SectionContent>
            ) : null}
            {items.length > 0 ? (
              <SectionContent>
                {items.map((suggestion, index) => {
                  const suggestionId = getSuggestionId(suggestion, {
                    sectionId: section.id,
                    sectionIndex,
                    index,
                  });
                  const testId = `${resolvedTestId}-section-${section.id}-suggestion-${suggestionId}`;
                  const handleSelect = () => {
                    onSelectSuggestion?.(suggestion, {
                      sectionId: section.id,
                      sectionIndex,
                      index,
                    });
                  };
                  const isActive = activeSuggestionId === suggestionId;
                  return (
                    <YStack key={suggestionId} width="100%">
                      <SuggestionRowHighlight active={isActive}>
                        {renderRow({
                          suggestion,
                          section,
                          sectionIndex,
                          index,
                          onSelect: handleSelect,
                          testId,
                          active: isActive,
                        })}
                      </SuggestionRowHighlight>
                    </YStack>
                  );
                })}
              </SectionContent>
            ) : null}
            {section.footer ? (
              <SectionFooter>{section.footer}</SectionFooter>
            ) : null}
          </SectionStack>,
        );
      });

      return nodes;
    })()
  ) : shouldShowEmptyState && emptyState ? (
    <EmptyStateWrapper data-testid={`${resolvedTestId}-empty`}>
      {emptyState}
    </EmptyStateWrapper>
  ) : null;

  // NOTE: `flatSuggestions` is derived from `normalizedSections` but is only used for keyboard
  // navigation. For dropdown visibility we care about whether there is *any* actual dropdown content
  // (items/custom content) OR an active empty state.
  //
  // Important for testability + controlled inputs:
  // In some jsdom flows with Tamagui TextInput wrappers, focus/interaction events may not reliably
  // hit our handlers. If the caller is already providing content for a non-empty query, render it.
  // If the caller is supplying dropdown content, we should render it.
  // Focus/interaction state is still used for connected-surface styling and
  // keyboard navigation, but visibility should be data-driven.
  //
  // When `dropdownOverlay` is true the dropdown floats above other content, so
  // we additionally gate visibility on focus state — otherwise the dropdown
  // stays open even after the user clicks away.
  const shouldDisplayDropdown = dropdownOverlay
    ? Boolean(dropdownContent) && isFocused
    : Boolean(dropdownContent);
  const overlayActive = dropdownOverlay && shouldDisplayDropdown;
  const shouldFlattenInputBottom = shouldConnectSurface || overlayActive;
  const inputGroupGap = shouldFlattenInputBottom ? 0 : "$2";

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (!flatSuggestions.length) return;

      const currentIndex = activeSuggestionId
        ? flatSuggestions.findIndex(
            (s) => s.suggestionId === activeSuggestionId,
          )
        : -1;

      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : flatSuggestions.length - 1
          : (currentIndex + direction + flatSuggestions.length) %
            flatSuggestions.length;

      setActiveSuggestionId(flatSuggestions[nextIndex]?.suggestionId ?? null);
    },
    [activeSuggestionId, flatSuggestions],
  );

  const commitActive = useCallback(() => {
    if (!activeSuggestionId) return;
    const match = flatSuggestions.find(
      (s) => s.suggestionId === activeSuggestionId,
    );
    if (!match) return;
    onSelectSuggestion?.(match.suggestion, {
      sectionId: match.section.id,
      sectionIndex: match.sectionIndex,
      index: match.index,
    });
  }, [activeSuggestionId, flatSuggestions, onSelectSuggestion]);

  // Web: Tamagui wrappers don't always surface React's `onKeyDown` / blur
  // semantics on the underlying DOM nodes. Bind directly to the group element
  // so arrow navigation and Tab behavior are consistent.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = containerRef.current;
    if (!root) return;

    const onFocusIn = () => {
      setIsFocused(true);
      setHasInteracted(true);
    };

    const onFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && root.contains(nextTarget)) return;
      setIsFocused(false);
      setActiveSuggestionId(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Only handle navigation when dropdown is visible.
      if (!(hasInteracted && isFocused)) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
        return;
      }

      if (event.key === "Enter") {
        if (activeSuggestionId) {
          event.preventDefault();
          commitActive();
          return;
        }
        // No active suggestion — submit the raw query text.
        const trimmed = query.trim();
        if (trimmed && onSubmitQuery) {
          event.preventDefault();
          setIsFocused(false);
          onSubmitQuery(trimmed);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setIsFocused(false);
        setActiveSuggestionId(null);
        (inputRef.current as any)?.focus?.();
      }
    };

    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("keydown", onKeyDown);

    return () => {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [
    activeSuggestionId,
    commitActive,
    hasInteracted,
    isFocused,
    moveActive,
    onSubmitQuery,
    query,
  ]);

  const handleInputKeyDown = useCallback(
    (event: any) => {
      const key = event?.key;

      if (key === "Enter") {
        if (activeSuggestionId) {
          event.preventDefault?.();
          commitActive();
          return;
        }
        // No active suggestion — submit the raw query text.
        const trimmed = query.trim();
        if (trimmed && onSubmitQuery) {
          event.preventDefault?.();
          setIsFocused(false);
          onSubmitQuery(trimmed);
        }
        return;
      }

      // Arrow / escape keys only matter when dropdown is visible.
      if (!shouldDisplayDropdown) {
        return;
      }

      if (key === "ArrowDown") {
        event.preventDefault?.();
        moveActive(1);
        return;
      }

      if (key === "ArrowUp") {
        event.preventDefault?.();
        moveActive(-1);
        return;
      }

      if (key === "Escape") {
        event.preventDefault?.();
        setIsFocused(false);
        setActiveSuggestionId(null);
      }
    },
    [
      activeSuggestionId,
      commitActive,
      moveActive,
      onSubmitQuery,
      query,
      shouldDisplayDropdown,
    ],
  );

  return (
    <Container data-testid={resolvedTestId} data-qa={qaId ?? resolvedTestId}>
      <InputGroup
        ref={containerRef as any}
        gap={inputGroupGap}
        width={resolvedGroupWidth ?? "100%"}
        // Web-only: allow dropdown to stay open when focus moves from the input
        // into a suggestion via Tab.
        // (RN doesn't support these props, hence the `as any`.)
        {...({
          onFocusCapture: handleGroupFocusCapture,
          onBlurCapture: handleGroupBlurCapture,
        } as any)}
      >
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          testId={`${resolvedTestId}-input`}
          qaId={qaId}
          fullWidth={resolvedInputFullWidth}
          paddingVertical={
            !hasLabel ? (providedPaddingVertical ?? "$3") : undefined
          }
          borderBottomLeftRadius={shouldFlattenInputBottom ? 0 : undefined}
          borderBottomRightRadius={shouldFlattenInputBottom ? 0 : undefined}
          borderBottomWidth={shouldFlattenInputBottom ? 0 : undefined}
          onLayout={handleInputLayout}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...({ onKeyDown: handleInputKeyDown } as any)}
          width={
            resolvedInputFullWidth && !hasExplicitWidth ? "100%" : providedWidth
          }
          {...computedInputProps}
        />

        {leadingAccessory ? (
          <LeadingAccessory
            left={resolvedAccessoryInset}
            top={accessoryTop}
            bottom={accessoryBottom}
            data-testid={`${resolvedTestId}-leading-accessory`}
          >
            {leadingAccessory}
          </LeadingAccessory>
        ) : null}

        {trailingAccessory ? (
          <TrailingAccessory
            right={resolvedTrailingInset}
            top={accessoryTop}
            bottom={accessoryBottom}
            data-testid={`${resolvedTestId}-trailing-accessory`}
          >
            {trailingAccessory}
          </TrailingAccessory>
        ) : null}

        {label ? (
          <InputLabel
            left={resolvedLabelInset}
            variant="overline"
            tone="muted"
            weight="medium"
            data-testid={`${resolvedTestId}-label`}
          >
            {label}
          </InputLabel>
        ) : null}

        {shouldDisplayDropdown ? (
          <DropdownSurface
            borderTopLeftRadius={dropdownOverlay ? undefined : 0}
            borderTopRightRadius={dropdownOverlay ? undefined : 0}
            borderTopWidth={dropdownOverlay ? undefined : 0}
            width={
              overlayActive ? (resolvedOverlayWidth ?? "100%") : "100%"
            }
            position={overlayActive ? "absolute" : undefined}
            top={overlayActive ? "100%" : undefined}
            left={overlayActive ? 0 : undefined}
            marginTop={overlayActive ? 0 : undefined}
            // Default 200 clears the prose editor sticky toolbar (zIndex 40),
            // the image-picker popover (120), and any other in-form floating
            // UI. Callers can raise `dropdownZIndex` above page chrome (e.g.
            // the contextual action bar at 1100) when the field sits low
            // enough that the open menu would be covered.
            zIndex={overlayActive ? dropdownZIndex : undefined}
            // Use the normal surface token so dropdown items stay readable.
            backgroundColor={
              dropdownTone === "surface" ? "$surface" : "$surface"
            }
            data-testid={`${resolvedTestId}-dropdown`}
          >
            {dropdownContent}
          </DropdownSurface>
        ) : null}
      </InputGroup>

      {statusMessage ? (
        <Text variant="bodySmall" tone="muted">
          {statusMessage}
        </Text>
      ) : null}
    </Container>
  );
};

AutocompleteField.displayName = "AutocompleteField";
