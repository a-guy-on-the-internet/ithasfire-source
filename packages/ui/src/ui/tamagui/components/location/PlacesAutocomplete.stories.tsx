import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";
import { YStack } from "tamagui";

import { Text } from "../typography/Text";
import {
  PlacesAutocompleteField,
  type PlacesAutocompleteFieldProps,
  type PlacesAutocompleteSuggestion,
} from "./PlacesAutocomplete";

const meta: Meta<typeof PlacesAutocompleteField> = {
  title: "Ui/Tamagui/Components/Location/Places Autocomplete",
  component: PlacesAutocompleteField,
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof PlacesAutocompleteField>;

const SAMPLE_PLACES: PlacesAutocompleteSuggestion[] = [
  {
    id: "brooklyn-bridge-park",
    title: "Brooklyn Bridge Park",
    subtitle: "334 Furman St, Brooklyn, NY",
    helper: "Park",
  },
  {
    id: "pier-17",
    title: "Pier 17",
    subtitle: "89 South St, New York, NY",
    helper: "Venue",
  },
  {
    id: "hollywood-bowl",
    title: "Hollywood Bowl",
    subtitle: "2301 N Highland Ave, Los Angeles, CA",
    helper: "Amphitheatre",
  },
];

type TemplateProps = Partial<PlacesAutocompleteFieldProps> & {
  containerWidth?: number | string;
};

const ControlledTemplate = (props: TemplateProps) => {
  const {
    suggestions: providedSuggestions,
    emptyState: providedEmptyState,
    statusMessage: providedStatusMessage,
    containerWidth = 360,
    ...rest
  } = props;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const trimmedQuery = query.trim();

  const filtered = useMemo(() => {
    const normalized = trimmedQuery.toLowerCase();
    if (!normalized) return [];
    return SAMPLE_PLACES.filter((place) =>
      place.title.toLowerCase().includes(normalized),
    );
  }, [trimmedQuery]);

  const resolvedSuggestions = providedSuggestions ?? filtered;
  const resolvedStatusMessage =
    providedStatusMessage ??
    (trimmedQuery ? undefined : "Start typing to filter venues");
  const resolvedEmptyState =
    providedEmptyState ??
    (trimmedQuery ? (
      <Text variant="bodySmall" tone="muted">
        No matching venues for “{trimmedQuery}”.
      </Text>
    ) : undefined);

  return (
    <YStack gap="$3" width={containerWidth}>
      <PlacesAutocompleteField
        query={query}
        onQueryChange={setQuery}
        suggestions={resolvedSuggestions}
        onSelectSuggestion={(suggestion) => setSelected(suggestion.title)}
        placeholder="Search for a venue"
        statusMessage={resolvedStatusMessage}
        emptyState={resolvedEmptyState}
        {...rest}
      />
      {selected ? (
        <Text variant="bodySmall">Selected: {selected}</Text>
      ) : (
        <Text variant="bodySmall" tone="muted">
          Pick a venue to see selection feedback
        </Text>
      )}
    </YStack>
  );
};

export const Default: Story = {
  render: () => <ControlledTemplate />,
};

export const Loading: Story = {
  render: () => (
    <ControlledTemplate loading statusMessage="Looking up places…" />
  ),
};

export const EmptyState: Story = {
  render: () => (
    <ControlledTemplate
      suggestions={[]}
      emptyState={<Text variant="bodySmall">No matching venues yet.</Text>}
      statusMessage="Try a different city or neighborhood"
    />
  ),
};

export const Mobile: Story = {
  render: () => (
    <ControlledTemplate
      containerWidth={320}
      maxVisibleSuggestions={4}
      placeholder="Search on the go"
      statusMessage="Tap to start typing"
      inputProps={{ size: "$3" }}
    />
  ),
};
