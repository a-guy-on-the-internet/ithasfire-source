import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";
import { YStack, styled } from "tamagui";

import {
  AutocompleteField,
  type AutocompleteSection,
} from "./AutocompleteField";
import { Button } from "./Button";
import { Text } from "../typography/Text";

const StoryContainer = styled(YStack, {
  name: "AutocompleteStoryContainer",
  width: 360,
  gap: "$4",
});

const StorySuggestionButton = styled(Button, {
  name: "AutocompleteStorySuggestionButton",
  justifyContent: "flex-start",
});

type DemoSuggestion = {
  id: string;
  title: string;
  subtitle?: string;
  helper?: string;
};

type HarnessProps = {
  includeRecentSection?: boolean;
};

const DemoAutocompleteHarness = ({
  includeRecentSection = false,
}: HarnessProps) => {
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!trimmedQuery) return [];
    return SAMPLE_SUGGESTIONS.filter((suggestion) =>
      suggestion.title.toLowerCase().includes(trimmedQuery),
    );
  }, [trimmedQuery]);

  const sections = useMemo<AutocompleteSection<DemoSuggestion>[]>(() => {
    const baseSections: AutocompleteSection<DemoSuggestion>[] = [];

    if (matches.length) {
      baseSections.push({
        id: "matches",
        title: "Ui/Tamagui/Components/Forms/Autocomplete Field",
        items: matches,
      });
    }

    if (includeRecentSection && trimmedQuery) {
      baseSections.push({
        id: "recent-searches",
        title: "Most recent searches",
        items: RECENT_SEARCHES,
      });
    }

    return baseSections;
  }, [includeRecentSection, matches, trimmedQuery]);

  return (
    <StoryContainer>
      <AutocompleteField<DemoSuggestion>
        query={query}
        onQueryChange={setQuery}
        data={{ sections }}
        placeholder="Search venues"
        getSuggestionId={(suggestion) => suggestion.id}
        renderRow={({ suggestion, onSelect, testId }) => (
          <StorySuggestionButton
            size="$2"
            variant="ghost"
            onPress={onSelect}
            data-testid={testId}
          >
            <YStack gap="$1" alignItems="flex-start">
              <Text weight="bold">{suggestion.title}</Text>
              {suggestion.subtitle ? (
                <Text variant="bodySmall" tone="muted">
                  {suggestion.subtitle}
                </Text>
              ) : null}
            </YStack>
            {suggestion.helper ? (
              <Text variant="bodySmall" tone="muted">
                {suggestion.helper}
              </Text>
            ) : null}
          </StorySuggestionButton>
        )}
        emptyState={
          trimmedQuery ? (
            <Text variant="bodySmall">No matches yet. Try another query.</Text>
          ) : null
        }
      />
    </StoryContainer>
  );
};

const SAMPLE_SUGGESTIONS: DemoSuggestion[] = [
  {
    id: "brooklyn-bridge-park",
    title: "Brooklyn Bridge Park",
    subtitle: "Brooklyn, NY",
    helper: "Park",
  },
  {
    id: "hollywood-bowl",
    title: "Hollywood Bowl",
    subtitle: "Los Angeles, CA",
    helper: "Amphitheatre",
  },
  {
    id: "pier-17",
    title: "Pier 17",
    subtitle: "New York, NY",
    helper: "Venue",
  },
  {
    id: "the-alcazar",
    title: "The Alcazar",
    subtitle: "Chicago, IL",
    helper: "Warehouse",
  },
];

const meta: Meta<typeof DemoAutocompleteHarness> = {
  title: "Ui/Tamagui/Components/Forms/AutocompleteField",
  component: DemoAutocompleteHarness,
  parameters: {
    layout: "centered",
  },
};

const RECENT_SEARCHES: DemoSuggestion[] = [
  {
    id: "recent-event",
    title: "Most recent gala",
    subtitle: "Brooklyn, NY",
  },
  {
    id: "recent-market",
    title: "Sunday Market",
    subtitle: "Los Angeles, CA",
  },
];

export default meta;

type Story = StoryObj<typeof DemoAutocompleteHarness>;

export const Default: Story = {
  render: () => <DemoAutocompleteHarness />,
};

export const WithRecentSection: Story = {
  render: () => <DemoAutocompleteHarness includeRecentSection />,
};
