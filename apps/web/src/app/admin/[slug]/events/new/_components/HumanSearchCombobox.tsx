"use client";

import { useRef, useState, useCallback } from "react";
import { styled, XStack, YStack, useTheme } from "tamagui";
import { X, User } from "lucide-react";

import { Text, TextInput, useTranslations } from "@th/ui";
import type { UnifiedHumanSuggestion } from "@th/ui";
import { trpc } from "@/trpc";

/* ── Types ───────────────────────────────────────────────────────── */

export type HumanSearchComboboxProps = {
  selectedHumanId: string | null;
  selectedDisplayName: string | null;
  inputValue: string;
  onInputChange: (text: string) => void;
  onSelect: (humanId: string, displayName: string) => void;
  onClear: () => void;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
  /**
   * Stretch the combobox input/frame to fill its column (width: 100%) instead
   * of the default fixed 240px. Used on mobile add-rows so the input hits the
   * 44px / 16px touch + no-zoom target without depth-coupled CSS overrides.
   */
  fullWidth?: boolean;
};

/* ── Styled components ───────────────────────────────────────────── */

const DropdownContainer = styled(YStack, {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 50,
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "$surface",
  overflow: "hidden",
});

const SuggestionItem = styled(XStack, {
  paddingHorizontal: 12,
  paddingVertical: 8,
  gap: 8,
  alignItems: "center",
  cursor: "pointer",
  backgroundColor: "$surface",
  variants: {
    highlighted: {
      true: {
        backgroundColor: "$surfaceMuted",
      },
    },
  } as const,
});

const LinkedInput = styled(XStack, {
  height: 36,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
  paddingHorizontal: 10,
  alignItems: "center",
  gap: 8,
  flex: 1,
});

/* ── Component ───────────────────────────────────────────────────── */

export function HumanSearchCombobox({
  selectedHumanId,
  selectedDisplayName,
  inputValue,
  onInputChange,
  onSelect,
  onClear,
  placeholder = "Search by name…",
  disabled = false,
  testId = "human-search-combobox",
  fullWidth = false,
}: HumanSearchComboboxProps) {
  const theme = useTheme();
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchQuery = trpc.search.autocompleteAdmin.useQuery(
    { query: debouncedQuery, types: ["human"], limit: 8 },
    {
      enabled: debouncedQuery.trim().length >= 2 && !selectedHumanId,
      staleTime: 15_000,
    },
  );

  const humanSuggestions = (searchQuery.data?.suggestions ?? []).filter(
    (s) => s.type === "human",
  ) as UnifiedHumanSuggestion[];

  const handleInputChange = useCallback(
    (text: string) => {
      onInputChange(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setDebouncedQuery(text);
        if (text.trim().length >= 2) setIsOpen(true);
        else setIsOpen(false);
      }, 250);
    },
    [onInputChange],
  );

  const handleSelect = useCallback(
    (suggestion: UnifiedHumanSuggestion) => {
      onSelect(suggestion.humanId, suggestion.title);
      setIsOpen(false);
      setDebouncedQuery("");
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    onClear();
    setIsOpen(false);
    setDebouncedQuery("");
  }, [onClear]);

  /* ── Linked state: show display name + clear button ─────────────── */
  if (selectedHumanId) {
    return (
      <LinkedInput
        data-testid={`${testId}-linked`}
        {...(fullWidth ? { width: "100%" } : {})}
      >
        <User
          size={12}
          color={theme.colorMuted?.val}
          style={{ flexShrink: 0 }}
        />
        <Text
          variant="body"
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selectedDisplayName ?? "—"}
        </Text>
        {!disabled && (
          <XStack
            cursor="pointer"
            onPress={handleClear}
            padding={4}
            hoverStyle={{ opacity: 0.7 }}
            data-testid={`${testId}-clear`}
          >
            <X size={12} color={theme.colorMuted?.val} />
          </XStack>
        )}
      </LinkedInput>
    );
  }

  /* ── Unlinked state: text input + dropdown ───────────────────────── */
  return (
    <YStack
      flex={1}
      position="relative"
      {...(fullWidth ? { width: "100%" } : {})}
      onFocus={() => {
        if (debouncedQuery.trim().length >= 2) setIsOpen(true);
      }}
      onBlur={(e: React.FocusEvent) => {
        // Delay close so click on suggestion fires first
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setTimeout(() => setIsOpen(false), 150);
        }
      }}
    >
      <TextInput
        value={inputValue}
        onChangeText={handleInputChange}
        placeholder={placeholder}
        maxLength={120}
        disabled={disabled}
        testId={testId}
        fullWidth={fullWidth}
      />

      {isOpen && humanSuggestions.length > 0 && (
        <DropdownContainer data-testid={`${testId}-dropdown`}>
          {humanSuggestions.map((suggestion) => (
            <SuggestionItem
              key={suggestion.humanId}
              onPress={() => handleSelect(suggestion)}
              data-testid={`${testId}-option-${suggestion.humanId}`}
            >
              <User
                size={12}
                color={theme.colorMuted?.val}
                style={{ flexShrink: 0 }}
              />
              <YStack flex={1} gap={1}>
                <Text
                  variant="body"
                  weight="medium"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {suggestion.title}
                </Text>
                {suggestion.username && (
                  <Text
                    variant="caption"
                    tone="muted"
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    @{suggestion.username}
                  </Text>
                )}
              </YStack>
            </SuggestionItem>
          ))}
        </DropdownContainer>
      )}

      {isOpen &&
        debouncedQuery.trim().length >= 2 &&
        searchQuery.isFetching && (
          <DropdownContainer data-testid={`${testId}-loading`}>
            <SuggestionItem>
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.humanSearchLoading" as Parameters<typeof t>[0]),
                )}
              </Text>
            </SuggestionItem>
          </DropdownContainer>
        )}

      {isOpen &&
        debouncedQuery.trim().length >= 2 &&
        !searchQuery.isFetching &&
        humanSuggestions.length === 0 && (
          <DropdownContainer data-testid={`${testId}-empty`}>
            <SuggestionItem>
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.humanSearchNoResults" as Parameters<typeof t>[0], {
                    query: debouncedQuery,
                  }),
                )}
              </Text>
            </SuggestionItem>
          </DropdownContainer>
        )}
    </YStack>
  );
}
