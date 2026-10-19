"use client";

import { Fragment, memo, useCallback, useMemo, type ReactElement } from "react";
import { type TextInputChangeEvent } from "react-native";
import { Separator, Stack, XStack, YStack } from "tamagui";

import { Button } from "../forms/Button";
import { Checkbox } from "../forms/Checkbox";
import { TextInput } from "../forms/TextInput";
import { Text } from "../typography/Text";
import type { EventGridFilterState, FilterOption } from "./types";
import { isWeb } from "./constants";

export interface EventGridFiltersProps {
  state: EventGridFilterState;
  onChange: (state: EventGridFilterState) => void;
  variant?: "inline" | "popover" | "sheet";
  showSearch?: boolean;
  availableCategories?: FilterOption[];
  availableVenues?: FilterOption[];
  availableOrganizers?: FilterOption[];
  dateLimits?: { min?: string; max?: string };
  priceRange?: { min?: number; max?: number; step?: number };
  align?: "start" | "center" | "end";
  testIdBase?: string;
  qaId?: string;
}

const toggleValue = (values: string[] | undefined, id: string) => {
  const set = new Set(values ?? []);
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  return Array.from(set);
};

const resolveAutomationProps = (testId?: string, qaId?: string) => {
  if (!testId) {
    return {};
  }
  if (isWeb) {
    return {
      "data-testid": testId,
      ...(qaId ? { "data-qa": qaId } : {}),
    };
  }
  return {
    testID: testId,
    ...(qaId ? { accessibilityLabel: qaId } : {}),
  };
};

export const EventGridFilters = memo<EventGridFiltersProps>(
  ({
    state,
    onChange,
    variant = "inline",
    showSearch = true,
    availableCategories,
    availableVenues,
    availableOrganizers,
    dateLimits,
    priceRange,
    align = "start",
    testIdBase = "event-grid-filters",
    qaId,
  }) => {
    const automationProps = resolveAutomationProps(
      testIdBase,
      qaId ?? testIdBase,
    );

    const handleSearchChange = useCallback(
      (value: string) => {
        onChange({ ...state, search: value });
      },
      [onChange, state],
    );

    const handleDateChange = useCallback(
      (key: "start" | "end", value: string | undefined) => {
        onChange({
          ...state,
          dateRange: {
            ...state.dateRange,
            [key]: value ?? undefined,
          },
        });
      },
      [onChange, state],
    );

    const handleToggle = useCallback(
      (key: "categoryIds" | "venueIds" | "organizerIds", id: string) => {
        onChange({
          ...state,
          [key]: toggleValue(state[key], id),
        });
      },
      [onChange, state],
    );

    const handlePriceChange = useCallback(
      (key: "min" | "max", value: string) => {
        const trimmed = value.trim();
        const numericValue = trimmed.length ? Number(trimmed) : undefined;
        onChange({
          ...state,
          priceRange: {
            ...state.priceRange,
            [key]: Number.isFinite(numericValue ?? NaN)
              ? numericValue
              : undefined,
          },
        });
      },
      [onChange, state],
    );

    const handleClear = useCallback(() => {
      onChange({});
    }, [onChange]);

    const activeFilterCount = useMemo(() => {
      const {
        search,
        dateRange,
        categoryIds,
        venueIds,
        organizerIds,
        priceRange: range,
      } = state;
      let count = 0;
      if (search) count += 1;
      if (dateRange?.start || dateRange?.end) count += 1;
      if (categoryIds?.length) count += 1;
      if (venueIds?.length) count += 1;
      if (organizerIds?.length) count += 1;
      if (range?.min !== undefined || range?.max !== undefined) count += 1;
      return count;
    }, [state]);

    const containerProps = {
      alignSelf:
        align === "center"
          ? "center"
          : align === "end"
            ? "flex-end"
            : "flex-start",
      maxWidth: "100%",
      width: "100%",
    } as const;

    const heading = (
      <XStack justifyContent="space-between" alignItems="center" gap="$3">
        <Text variant="subtitle" weight="bold">
          Filters
        </Text>
        <Button
          variant="ghost"
          size="$2"
          onPress={handleClear}
          disabled={activeFilterCount === 0}
        >
          Clear all
        </Button>
      </XStack>
    );

    const searchInput = showSearch ? (
      <YStack gap="$2">
        <Text variant="bodySmall" weight="bold">
          Search
        </Text>
        <TextInput
          width="100%"
          placeholder="Search events"
          value={state.search ?? ""}
          onChangeText={handleSearchChange}
          onChange={(event: TextInputChangeEvent) =>
            handleSearchChange(event.nativeEvent.text ?? "")
          }
          {...resolveAutomationProps(
            `${testIdBase}-search`,
            `${qaId ?? testIdBase}-search`,
          )}
        />
      </YStack>
    ) : null;

    const renderOptionGroup = (
      label: string,
      options: FilterOption[] | undefined,
      key: "categoryIds" | "venueIds" | "organizerIds",
    ) => {
      if (!options?.length) {
        return null;
      }
      const selected = new Set(state[key] ?? []);

      return (
        <YStack gap="$2">
          <Text variant="bodySmall" weight="bold">
            {label}
          </Text>
          <YStack gap="$2">
            {options.map((option) => (
              <Checkbox
                key={option.id}
                label={
                  <XStack gap="$2" alignItems="center">
                    <Text variant="body">{option.label}</Text>
                    {option.count !== undefined ? (
                      <Text variant="bodySmall" tone="muted">
                        ({option.count})
                      </Text>
                    ) : null}
                  </XStack>
                }
                checked={selected.has(option.id)}
                onCheckedChange={() => handleToggle(key, option.id)}
                testIdBase={`${testIdBase}-${key}-${option.id}`}
                qaId={`${qaId ?? testIdBase}-${key}-${option.id}`}
              />
            ))}
          </YStack>
        </YStack>
      );
    };

    const dateInputs = (
      <YStack gap="$2">
        <Text variant="bodySmall" weight="bold">
          Date range
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Stack width="45%">
            <TextInput
              width="100%"
              aria-label="Start"
              placeholder="Start (YYYY-MM-DD)"
              value={state.dateRange?.start ?? ""}
              onChangeText={(value) =>
                handleDateChange("start", value || undefined)
              }
              onChange={(event: TextInputChangeEvent) =>
                handleDateChange("start", event.nativeEvent.text || undefined)
              }
              {...(isWeb
                ? ({
                    type: "date",
                    min: dateLimits?.min,
                    max: dateLimits?.max,
                  } as const)
                : {})}
              {...resolveAutomationProps(
                `${testIdBase}-date-start`,
                `${qaId ?? testIdBase}-date-start`,
              )}
            />
          </Stack>
          <Stack width="45%">
            <TextInput
              width="100%"
              aria-label="End"
              placeholder="End (YYYY-MM-DD)"
              value={state.dateRange?.end ?? ""}
              onChangeText={(value) =>
                handleDateChange("end", value || undefined)
              }
              onChange={(event: TextInputChangeEvent) =>
                handleDateChange("end", event.nativeEvent.text || undefined)
              }
              {...(isWeb
                ? ({
                    type: "date",
                    min: dateLimits?.min,
                    max: dateLimits?.max,
                  } as const)
                : {})}
              {...resolveAutomationProps(
                `${testIdBase}-date-end`,
                `${qaId ?? testIdBase}-date-end`,
              )}
            />
          </Stack>
        </XStack>
      </YStack>
    );

    const priceInputs = priceRange ? (
      <YStack gap="$2">
        <Text variant="bodySmall" weight="bold">
          Price range
        </Text>
        <XStack gap="$2" alignItems="center">
          <Stack width="45%">
            <TextInput
              width="100%"
              placeholder="Min"
              keyboardType="numeric"
              value={state.priceRange?.min?.toString() ?? ""}
              onChangeText={(value) => handlePriceChange("min", value)}
              onChange={(event: TextInputChangeEvent) =>
                handlePriceChange("min", event.nativeEvent.text ?? "")
              }
              {...(isWeb
                ? ({
                    type: "number",
                    min: priceRange.min,
                    max: priceRange.max,
                    step: priceRange.step,
                  } as Record<string, unknown>)
                : {})}
            />
          </Stack>
          <Text variant="body">–</Text>
          <Stack width="45%">
            <TextInput
              width="100%"
              placeholder="Max"
              keyboardType="numeric"
              value={state.priceRange?.max?.toString() ?? ""}
              onChangeText={(value) => handlePriceChange("max", value)}
              onChange={(event: TextInputChangeEvent) =>
                handlePriceChange("max", event.nativeEvent.text ?? "")
              }
              {...(isWeb
                ? ({
                    type: "number",
                    min: priceRange.min,
                    max: priceRange.max,
                    step: priceRange.step,
                  } as Record<string, unknown>)
                : {})}
            />
          </Stack>
        </XStack>
      </YStack>
    ) : null;

    const sections: Array<{ key: string; node: ReactElement }> = [];

    if (searchInput) {
      sections.push({ key: "search", node: searchInput });
    }
    if (dateInputs) {
      sections.push({ key: "dates", node: dateInputs });
    }

    const categorySection = renderOptionGroup(
      "Categories",
      availableCategories,
      "categoryIds",
    );
    if (categorySection) {
      sections.push({ key: "categories", node: categorySection });
    }

    const venueSection = renderOptionGroup(
      "Places",
      availableVenues,
      "venueIds",
    );
    if (venueSection) {
      sections.push({ key: "venues", node: venueSection });
    }

    const organizerSection = renderOptionGroup(
      "Organizers",
      availableOrganizers,
      "organizerIds",
    );
    if (organizerSection) {
      sections.push({ key: "organizers", node: organizerSection });
    }

    if (priceInputs) {
      sections.push({ key: "price", node: priceInputs });
    }

    const hasSections = sections.length > 0;

    return (
      <YStack gap="$4" {...automationProps} {...containerProps} role="form">
        {heading}
        {hasSections ? <Separator borderColor="$borderColor" /> : null}
        <YStack gap="$4">
          {sections.map((section) => (
            <Fragment key={section.key}>{section.node}</Fragment>
          ))}
        </YStack>
      </YStack>
    );
  },
);

EventGridFilters.displayName = "EventGridFilters";
