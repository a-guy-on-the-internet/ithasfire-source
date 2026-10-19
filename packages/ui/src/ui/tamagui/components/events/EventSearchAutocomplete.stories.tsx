import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState, type ReactNode } from "react";
import { YStack } from "tamagui";

import {
  EventSearchAutocomplete,
  type EventSearchSuggestion,
} from "./EventSearchAutocomplete";
import { Text } from "../typography/Text";

const StoryContainer = ({ children }: { children: ReactNode }) => (
  <YStack width={420} gap="$4">
    {children}
  </YStack>
);

const SAMPLE_SUGGESTIONS: EventSearchSuggestion[] = [
  {
    id: "sunset-sessions",
    title: "Ui/Tamagui/Components/Events/Event Search Autocomplete",
    subtitle: "Los Angeles, CA",
    helper: "Jun 21",
    slug: "sunset-sessions",
  },
  {
    id: "brooklyn-block-party",
    title: "Brooklyn Block Party",
    subtitle: "Brooklyn, NY",
    helper: "Jul 12",
    slug: "brooklyn-block-party",
  },
  {
    id: "lakeview-market",
    title: "Lakeview Makers Market",
    subtitle: "Chicago, IL",
    helper: "Aug 3",
  },
  {
    id: "desert-nights",
    title: "Desert Nights Festival",
    subtitle: "Palm Springs, CA",
    helper: "Sep 14",
  },
];

type DemoProps = {
  initialQuery?: string;
  loading?: boolean;
  emptyState?: ReactNode;
};

const Demo = ({
  initialQuery = "",
  loading = false,
  emptyState,
}: DemoProps) => {
  const [query, setQuery] = useState(initialQuery);
  const trimmedQuery = query.trim().toLowerCase();

  const filteredSuggestions = useMemo(() => {
    if (!trimmedQuery) return [];
    return SAMPLE_SUGGESTIONS.filter((suggestion) =>
      suggestion.title.toLowerCase().includes(trimmedQuery),
    );
  }, [trimmedQuery]);

  return (
    <StoryContainer>
      <EventSearchAutocomplete
        query={query}
        onQueryChange={setQuery}
        onSubmit={(value) => {
          // eslint-disable-next-line no-alert -- storybook demo helper
          alert(`Submitting search for ${value}`);
        }}
        onSelectSuggestion={(suggestion) => {
          // eslint-disable-next-line no-alert -- storybook demo helper
          alert(`Selected ${suggestion.title}`);
        }}
        suggestions={filteredSuggestions}
        placeholder="Search by artist, venue, or city"
        loading={loading}
        emptyState={emptyState}
      />
    </StoryContainer>
  );
};

const meta: Meta<typeof Demo> = {
  title: "Ui/Tamagui/Components/Events/EventSearchAutocomplete",
  component: Demo,
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof Demo>;

export const Default: Story = {
  render: () => <Demo />,
};

export const WithSuggestions: Story = {
  render: () => <Demo initialQuery="festival" />,
};

export const Loading: Story = {
  render: () => <Demo initialQuery="indie" loading />,
};

export const EmptyState: Story = {
  render: () => (
    <Demo
      initialQuery="orchestra"
      emptyState={
        <Text variant="bodySmall" tone="muted">
          No matching events. Try a different artist or venue.
        </Text>
      }
    />
  ),
};
