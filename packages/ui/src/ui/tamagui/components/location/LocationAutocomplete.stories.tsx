import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";
import { YStack } from "tamagui";

import { Text } from "../typography/Text";
import {
  LocationAutocompleteField,
  type LocationAutocompleteFieldProps,
  type LocationAutocompleteSuggestion,
} from "./LocationAutocomplete";

const meta: Meta<typeof LocationAutocompleteField> = {
  title: "Ui/Tamagui/Components/Location/Location Autocomplete",
  component: LocationAutocompleteField,
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof LocationAutocompleteField>;

const SAMPLE_LOCATIONS: LocationAutocompleteSuggestion[] = [
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

type TemplateProps = Partial<LocationAutocompleteFieldProps> & {
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
    return SAMPLE_LOCATIONS.filter((location) =>
      location.title.toLowerCase().includes(normalized),
    );
  }, [trimmedQuery]);

  const resolvedSuggestions = providedSuggestions ?? filtered;
  const resolvedStatusMessage =
    providedStatusMessage ??
    (trimmedQuery ? undefined : "Start typing to filter locations");
  const resolvedEmptyState =
    providedEmptyState ??
    (trimmedQuery ? (
      <Text variant="bodySmall" tone="muted">
        No matching locations for “{trimmedQuery}”.
      </Text>
    ) : undefined);

  return (
    <YStack gap="$3" width={containerWidth}>
      <LocationAutocompleteField
        query={query}
        onQueryChange={setQuery}
        suggestions={resolvedSuggestions}
        onSelectSuggestion={(suggestion) => setSelected(suggestion.title)}
        placeholder="Location"
        statusMessage={resolvedStatusMessage}
        emptyState={resolvedEmptyState}
        {...rest}
      />
      {selected ? (
        <Text variant="bodySmall">Selected: {selected}</Text>
      ) : (
        <Text variant="bodySmall" tone="muted">
          Pick a location to see selection feedback
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
    <ControlledTemplate loading statusMessage="Looking up locations…" />
  ),
};

export const EmptyState: Story = {
  render: () => (
    <ControlledTemplate
      suggestions={[]}
      emptyState={<Text variant="bodySmall">No matching locations yet.</Text>}
      statusMessage="Try a different city or neighborhood"
    />
  ),
};

export const Mobile: Story = {
  render: () => (
    <ControlledTemplate
      containerWidth={320}
      maxVisibleSuggestions={4}
      placeholder="Location"
      statusMessage="Tap to start typing"
      inputProps={{ size: "$3" }}
    />
  ),
};
