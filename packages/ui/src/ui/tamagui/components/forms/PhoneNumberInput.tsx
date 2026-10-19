"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";
import { Button } from "./Button";
import { Text } from "../typography/Text";
import { TextInput } from "./TextInput";
import { XStack, YStack } from "tamagui";
import { Platform } from "react-native";
import { Popover } from "../overlay/Popover";

export type CallingCodeOption = {
  iso2: string;
  callingCode: `+${string}`;
  /** Display label (optional). Falls back to iso2. */
  label?: string;
};

export type PhoneNumberValidationResult = {
  /** E.164 like "+12133734253" (only set when valid) */
  e164?: string;
  /** True when `e164` is present */
  isValid: boolean;
  /** A user-facing error message (optional) */
  error?: string;
};

export const defaultCallingCodeOptions: CallingCodeOption[] = getCountries()
  .map((iso2) => {
    const callingCode = `+${getCountryCallingCode(iso2)}` as const;
    return {
      iso2,
      callingCode,
      // Display label will be enriched at runtime when possible (Intl.DisplayNames).
      label: iso2,
    };
  })
  .sort((a, b) => {
    // Keep a stable order: by calling code, then country.
    if (a.callingCode !== b.callingCode)
      return a.callingCode.localeCompare(b.callingCode);
    return a.iso2.localeCompare(b.iso2);
  });

const buildSearchIndex = (option: CallingCodeOption) =>
  `${option.callingCode} ${option.callingCode.replace("+", "")} ${option.label ?? option.iso2}`.toLowerCase();

const getCountryDisplayName = (iso2: string) => {
  // Best-effort: use runtime-provided localized country names when available.
  // Falls back to ISO code for environments without Intl.DisplayNames.
  try {
    const DisplayNames = (
      Intl as unknown as { DisplayNames?: typeof Intl.DisplayNames }
    ).DisplayNames;
    if (!DisplayNames) return iso2;
    // Use the user's locale (undefined) and prefer region names.
    const dn = new DisplayNames(undefined, { type: "region" });
    return dn.of(iso2.toUpperCase()) ?? iso2;
  } catch {
    return iso2;
  }
};

const normalizeCallingCodeQuery = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
};

const getPreferredCountryForCallingCode = (
  callingCode: `+${string}`,
  callingCodeOptions: CallingCodeOption[],
) => {
  // Multiple countries can share a calling code; pick the first in the stable-sorted list.
  const digits = callingCode.replace("+", "");
  const match = callingCodeOptions.find(
    (o) => o.callingCode.replace("+", "") === digits,
  );
  if (!match) return undefined;
  return isSupportedCountry(match.iso2) ? match.iso2 : undefined;
};

export type PhoneNumberInputValue = {
  callingCode: `+${string}`;
  /** ISO 3166-1 alpha-2 country code (e.g. "US", "CA") to disambiguate shared calling codes. */
  iso2?: string;
  nationalNumber: string;
  /** Query input for filtering the calling code list */
  callingCodeQuery?: string;
};

export type PhoneNumberInputProps = {
  countryCodeLabel?: string;
  phoneNumberLabel?: string;
  value: PhoneNumberInputValue;
  onChange: (next: PhoneNumberInputValue) => void;

  /** Where to start if there's no value yet */
  defaultCallingCode?: `+${string}`;

  /** Optional override for supported countries */
  callingCodeOptions?: CallingCodeOption[];

  /** Disable fields + picker */
  disabled?: boolean;

  /** Render helper text. Defaults to showing the composed E.164 preview when possible */
  helperText?: string;

  /** Called whenever parse/validity changes */
  onValidationChange?: (result: PhoneNumberValidationResult) => void;

  /** Max options to show in the list */
  maxOptionsToShow?: number;
};

const computeE164AndValidate = (
  callingCode: `+${string}`,
  nationalNumber: string,
): PhoneNumberValidationResult => {
  const hasAnyDigits = /\d/.test(nationalNumber);
  if (!hasAnyDigits) return { isValid: false };

  // Let libphonenumber-js handle formatting junk like spaces, dashes, parentheses, etc.
  const raw = `${callingCode}${nationalNumber}`;
  const parsed = parsePhoneNumberFromString(raw);

  if (!parsed) {
    return { isValid: false, error: "Please enter a valid phone number." };
  }

  if (!parsed.isValid()) {
    return { isValid: false, error: "Please enter a valid phone number." };
  }

  return { isValid: true, e164: parsed.number };
};

export const PhoneNumberInput = ({
  countryCodeLabel = "Intl. Code",
  phoneNumberLabel = "Phone number",
  value,
  onChange,
  defaultCallingCode = "+1",
  callingCodeOptions = defaultCallingCodeOptions,
  disabled = false,
  helperText,
  onValidationChange,
  maxOptionsToShow = 8,
}: PhoneNumberInputProps) => {
  const callingCode = value.callingCode || defaultCallingCode;
  const [isCallingCodeFocused, setIsCallingCodeFocused] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const highlightedIndexRef = useRef(-1);
  highlightedIndexRef.current = highlightedIndex;

  const listRef = useRef<HTMLDivElement | null>(null);
  const callingCodeInputRef = useRef<HTMLInputElement | null>(null);
  const phoneInputRef = useRef<HTMLInputElement | null>(null);

  const uniqueCallingCodeOptions = useMemo(() => {
    const seen = new Set<string>();
    const unique: CallingCodeOption[] = [];
    for (const option of callingCodeOptions) {
      if (seen.has(option.iso2)) continue;
      seen.add(option.iso2);
      unique.push(option);
    }
    return unique;
  }, [callingCodeOptions]);

  const optionsWithDisplayName = useMemo(() => {
    // Add display names for the dropdown UI + search when possible.
    return uniqueCallingCodeOptions.map((o) => ({
      ...o,
      label:
        o.label && o.label !== o.iso2 ? o.label : getCountryDisplayName(o.iso2),
    }));
  }, [uniqueCallingCodeOptions]);

  const optionsWithSearch = useMemo(
    () =>
      optionsWithDisplayName.map((o) => ({
        ...o,
        search: buildSearchIndex(o),
      })),
    [optionsWithDisplayName],
  );

  const filteredOptions = useMemo(() => {
    const rawQ = (value.callingCodeQuery ?? "").trim();
    if (!rawQ) return optionsWithSearch;

    const hasLetters = /[a-z]/i.test(rawQ);
    const lowerQ = rawQ.toLowerCase();

    if (hasLetters) {
      // Text search: match against the full search string (includes label/iso2).
      return optionsWithSearch.filter((o) => o.search.includes(lowerQ));
    }

    // Numeric search: rely on our normalized calling code matching (+1 matches 1).
    const numericQ = normalizeCallingCodeQuery(rawQ).toLowerCase();
    if (!numericQ) return optionsWithSearch;

    return optionsWithSearch.filter((o) => o.search.startsWith(numericQ));
  }, [optionsWithSearch, value.callingCodeQuery]);

  const preferredCountry = useMemo(() => {
    if (value.iso2 && isSupportedCountry(value.iso2)) {
      return value.iso2;
    }
    return getPreferredCountryForCallingCode(callingCode, callingCodeOptions);
  }, [value.iso2, callingCode, callingCodeOptions]);

  const validation = useMemo(() => {
    const result = computeE164AndValidate(callingCode, value.nationalNumber);
    onValidationChange?.(result);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callingCode, value.nationalNumber]);

  const preview = validation.e164 ?? `${callingCode}…`;

  const shouldShowCallingCodeDropdown =
    isCallingCodeFocused || (value.callingCodeQuery ?? "").trim().length > 0;

  const isWeb = Platform.OS === "web";

  const visibleOptions = useMemo(() => {
    // We used to slice to `maxOptionsToShow`, but that made the list look "truncated".
    // The popover is scrollable now, so show the full filtered list.
    return filteredOptions;
  }, [filteredOptions]);

  // Reset highlight whenever the dropdown opens/closes or the option list changes.
  // We bias to the currently selected calling code when present.
  useEffect(() => {
    if (!shouldShowCallingCodeDropdown) {
      setHighlightedIndex(-1);
      return;
    }

    // If the current highlight is still valid, keep it.
    if (
      highlightedIndexRef.current >= 0 &&
      highlightedIndexRef.current < visibleOptions.length
    ) {
      return;
    }

    let selectedIndex = -1;
    if (value.iso2) {
      selectedIndex = visibleOptions.findIndex((o) => o.iso2 === value.iso2);
    }
    if (selectedIndex === -1) {
      selectedIndex = visibleOptions.findIndex(
        (o) => o.callingCode === callingCode,
      );
    }
    setHighlightedIndex(selectedIndex);
  }, [callingCode, value.iso2, shouldShowCallingCodeDropdown, visibleOptions]);

  // Keep the highlighted option visible while keyboard navigating.
  useEffect(() => {
    if (!shouldShowCallingCodeDropdown) return;
    if (highlightedIndex < 0) return;
    if (!listRef.current) return;

    const el = listRef.current.querySelector<HTMLElement>(
      `[data-calling-code-index="${highlightedIndex}"]`,
    );

    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, shouldShowCallingCodeDropdown]);

  const clampIndex = (index: number, total: number) => {
    if (total <= 0) return -1;
    if (index < 0) return total - 1;
    if (index >= total) return 0;
    return index;
  };

  const commitHighlightedCallingCode = () => {
    const idx =
      highlightedIndexRef.current >= 0 ? highlightedIndexRef.current : 0;
    if (idx < 0 || idx >= visibleOptions.length) return;
    const option = visibleOptions[idx];
    if (!option) return;
    onChange({
      ...value,
      callingCode: option.callingCode,
      iso2: option.iso2,
      callingCodeQuery: "",
    });
    setIsCallingCodeFocused(false);
  };

  const handleCallingCodeKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    // On web, don't let Tab escape the popover and jump to unrelated page inputs.
    // Instead, close the dropdown and move focus to the phone number input (or back to the intl code input on Shift+Tab).
    if (event.key === "Tab") {
      setIsCallingCodeFocused(false);
      if (isWeb) {
        // Forward Tab should move within the component row (intl code -> phone input).
        // Shift+Tab should behave naturally and go to the previous form control if one exists.
        if (!event.shiftKey) {
          event.preventDefault();
          requestAnimationFrame(() => phoneInputRef.current?.focus());
        }
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();

      if (!shouldShowCallingCodeDropdown) {
        setIsCallingCodeFocused(true);
      }

      if (!visibleOptions.length) return;

      if (highlightedIndexRef.current === -1) {
        setHighlightedIndex(0);
        return;
      }

      setHighlightedIndex((prev) =>
        clampIndex(prev + 1, visibleOptions.length),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();

      if (!shouldShowCallingCodeDropdown) {
        setIsCallingCodeFocused(true);
      }

      if (!visibleOptions.length) return;

      if (highlightedIndexRef.current === -1) {
        setHighlightedIndex(visibleOptions.length - 1);
        return;
      }

      setHighlightedIndex((prev) =>
        clampIndex(prev - 1, visibleOptions.length),
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      commitHighlightedCallingCode();
    }
  };

  // Some environments/components may not forward `onKeyDown` reliably; keep a fallback.
  const handleCallingCodeKeyPress = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    handleCallingCodeKeyDown(event);
  };

  return (
    <YStack gap="$2">
      <XStack width="100%" gap={0} alignItems="flex-start">
        <YStack flexShrink={0} flexGrow={0} minWidth={72}>
          <Text variant="bodySmall" color="$colorMuted">
            {countryCodeLabel}
          </Text>

          <Popover
            open={shouldShowCallingCodeDropdown}
            placement="bottom-start"
            tone="surface"
            matchAnchorWidth={false}
            anchor={
              <TextInput
                // @ts-expect-error Tamagui's input ref typing varies between platforms; on web this is an HTMLInputElement.
                ref={callingCodeInputRef}
                value={value.callingCodeQuery ?? ""}
                onChangeText={(next) =>
                  onChange({ ...value, callingCodeQuery: next })
                }
                placeholder={callingCode}
                autoCapitalize="none"
                autoComplete="tel-country-code"
                autoCorrect={false}
                disabled={disabled}
                containerWidth="70px"
                // Join with the phone input: square off the inner edge.
                borderTopRightRadius={0}
                borderBottomRightRadius={0}
                {...(isWeb
                  ? ({
                      // Tamagui input doesn't type DOM keyboard events, but we want arrow/enter navigation on web.
                      onKeyDown: handleCallingCodeKeyDown,
                      onKeyPress: handleCallingCodeKeyPress,
                    } as unknown as Record<string, unknown>)
                  : {})}
                onFocus={() => setIsCallingCodeFocused(true)}
                onBlur={() => setIsCallingCodeFocused(false)}
              />
            }
          >
            <YStack
              ref={listRef}
              // Give the dropdown more room now that it includes country names.
              // We still keep it constrained by the popover and allow truncation as needed.
              width={isWeb ? 260 : "100%"}
              minWidth={isWeb ? 220 : undefined}
              maxHeight={180}
              overflow="scroll"
              // When open, keep tab navigation inside the component on web instead of letting focus jump elsewhere.
              {...(isWeb
                ? ({
                    tabIndex: -1,
                    onKeyDown: (event: React.KeyboardEvent) => {
                      if (event.key !== "Tab") return;
                      setIsCallingCodeFocused(false);

                      // Mirror the input behavior:
                      // - Tab goes to phone input.
                      // - Shift+Tab is natural browser navigation to the previous control.
                      if ((event as React.KeyboardEvent).shiftKey) {
                        return;
                      }

                      event.preventDefault();
                      requestAnimationFrame(() =>
                        phoneInputRef.current?.focus(),
                      );
                    },
                  } as unknown as Record<string, unknown>)
                : {})}
            >
              {visibleOptions.map((option, index) => {
                const isHighlighted = index === highlightedIndex;
                const resolvedBackgroundColor = isHighlighted
                  ? "$accentSoft"
                  : undefined;

                // Prevent Tab from entering the list on web by ensuring these items aren't in the tab order.
                // Users can still use ArrowUp/ArrowDown + Enter from the input.
                const webTabSafetyProps = isWeb
                  ? ({
                      tabIndex: -1,
                      onMouseDown: (event: unknown) => {
                        // Avoid stealing focus from the calling code input on click.
                        (
                          event as { preventDefault?: () => void }
                        ).preventDefault?.();
                      },
                    } as unknown as Record<string, unknown>)
                  : {};

                return (
                  <YStack key={option.iso2} {...webTabSafetyProps}>
                    <Button
                      data-calling-code-index={index}
                      variant="ghost"
                      size="$2"
                      width="100%"
                      justifyContent="flex-start"
                      backgroundColor={resolvedBackgroundColor}
                      data-highlighted={isHighlighted ? "true" : "false"}
                      onPress={() => {
                        onChange({
                          ...value,
                          callingCode: option.callingCode,
                          iso2: option.iso2,
                          callingCodeQuery: "",
                        });
                        setIsCallingCodeFocused(false);
                        // On web, keep navigation within the current form row.
                        requestAnimationFrame(() =>
                          phoneInputRef.current?.focus(),
                        );
                      }}
                      disabled={disabled}
                    >
                      <XStack alignItems="center" gap="$2" width="100%">
                        <Text variant="subtitle" weight="bold">
                          {option.callingCode}
                        </Text>
                        <Text
                          variant="bodySmall"
                          color="$colorMuted"
                          flexShrink={1}
                          minWidth={0}
                          truncate
                        >
                          {option.label ?? option.iso2}
                        </Text>
                      </XStack>
                    </Button>
                  </YStack>
                );
              })}
              {filteredOptions.length === 0 ? (
                <YStack padding="$3">
                  <Text variant="bodySmall" color="$colorMuted">
                    No matches.
                  </Text>
                </YStack>
              ) : null}
            </YStack>
          </Popover>
        </YStack>

        <YStack flexGrow={1} flexShrink={1} flexBasis={0} marginLeft={-1}>
          <Text variant="bodySmall" color="$colorMuted">
            {phoneNumberLabel}
          </Text>
          <TextInput
            // @ts-expect-error Tamagui's input ref typing varies between platforms; on web this is an HTMLInputElement.
            ref={phoneInputRef}
            value={value.nationalNumber}
            onChangeText={(next) => {
              const formatted = preferredCountry
                ? new AsYouType(preferredCountry).input(next)
                : next;
              onChange({ ...value, nationalNumber: formatted });
            }}
            placeholder="Phone number"
            keyboardType="phone-pad"
            inputMode="tel"
            autoCapitalize="none"
            autoComplete="tel-national"
            autoCorrect={false}
            containerWidth="100%"
            disabled={disabled}
            // Join with the country code input: square off the inner edge.
            borderTopLeftRadius={0}
            borderBottomLeftRadius={0}
          />
        </YStack>
      </XStack>

      <Text variant="bodySmall" color="$colorMuted">
        {helperText ?? `We'll use ${preview} for SMS verification.`}
      </Text>
    </YStack>
  );
};
