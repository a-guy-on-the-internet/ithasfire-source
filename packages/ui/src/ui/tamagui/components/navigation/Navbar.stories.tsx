import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { Menu, Share2 } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import { Button } from "../forms/Button";
import {
  EventSearchAutocomplete,
  type EventSearchSuggestion,
} from "../events/EventSearchAutocomplete";
import { Navbar, type NavbarProps } from "./Navbar";
import { NotificationButton } from "../feedback/NotificationButton";
import { Text } from "../typography/Text";

const BrandMark = styled(XStack, {
  name: "NavbarBrandMark",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  borderRadius: "$md",
  backgroundColor: "$brandPrimary",
  borderWidth: 2,
  borderColor: "$surface",
});

const meta = {
  title: "Ui/Tamagui/Components/Navigation/Navbar",
  component: Navbar,
  args: {
    title: "Ithas Fire",
    border: "hairline" satisfies NavbarProps["border"],
    children: (
      <YStack gap="$2">
        <Text variant="body" tone="muted">
          Welcome back to the Ithas Fire dashboard.
        </Text>
        <Text variant="bodySmall" tone="muted">
          Use the search bar to jump to an event or browse the actions on the
          right.
        </Text>
      </YStack>
    ),
  },
  parameters: {
    layout: "fullscreen",
  },
  render: (args) => <NavbarStory args={args} />,
} satisfies Meta<NavbarProps>;

type Story = StoryObj<NavbarProps>;

export const Default: Story = {};

export const Elevated: Story = {
  args: {
    elevated: true,
  },
};

export const WithSearch: Story = {
  render: (props) => (
    <NavbarStory
      args={{
        ...props,
        searchAccessory: <SearchAccessoryStory />,
      }}
    />
  ),
};

export const Mobile: Story = {
  args: {
    title: "Ithas Fire",
    searchAccessory: undefined,
    trailingAccessory: (
      <XStack gap="$2">
        <Button size="$2" variant="ghost" icon>
          <Share2 size={18} strokeWidth={1.5} />
        </Button>
        <NotificationButton
          aria-label="View notifications"
          count={2}
          size="$2"
        />
      </XStack>
    ),
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile2",
    },
  },
};

export const WithChildren: Story = {
  args: {
    children: (
      <YStack gap="$1">
        <Text variant="bodySmall" tone="muted">
          Upcoming tasks
        </Text>
        <YStack gap="$1">
          <Text variant="body">Prep release notes</Text>
          <Text variant="body">Confirm venue deposits</Text>
        </YStack>
      </YStack>
    ),
  },
};

export default meta;

const sampleEvents: EventSearchSuggestion[] = [
  {
    id: "eras-tour-sf",
    title: "Taylor Swift | The Eras Tour",
    subtitle: "Fri, Jul 12 • Levi's Stadium",
    helper: "Santa Clara, CA",
  },
  {
    id: "bluey-live",
    title: "Bluey Live!",
    subtitle: "Sat, Aug 3 • Palace of Fine Arts",
    helper: "San Francisco, CA",
  },
  {
    id: "rock-the-docks",
    title: "Rock the Docks Festival",
    subtitle: "Sat, Jul 20 • Pier 70",
    helper: "San Francisco, CA",
  },
  {
    id: "harry-styles",
    title: "Harry Styles: Love On Tour",
    subtitle: "Tue, Sep 10 • Chase Center",
    helper: "San Francisco, CA",
  },
  {
    id: "ska-night",
    title: "Ska Night Downtown",
    subtitle: "Fri, Jun 28 • Fox Theater",
    helper: "Oakland, CA",
  },
  {
    id: "jazz-under-stars",
    title: "Jazz Under the Stars",
    subtitle: "Thu, Jul 18 • Stern Grove",
    helper: "San Francisco, CA",
  },
];

const SearchAccessoryStory = () => {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<EventSearchSuggestion[]>(
    sampleEvents.slice(0, 5),
  );
  const [loading, setLoading] = useState(false);

  const emptyState = useMemo(
    () => (
      <Text variant="bodySmall" tone="muted">
        No matching events. Try a different artist, venue, or city.
      </Text>
    ),
    [],
  );

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      const normalized = query.trim().toLowerCase();

      if (!normalized) {
        setSuggestions(sampleEvents.slice(0, 5));
      } else {
        setSuggestions(
          sampleEvents
            .filter((event) =>
              [event.title, event.subtitle, event.helper]
                .filter(Boolean)
                .some((value) => value!.toLowerCase().includes(normalized)),
            )
            .slice(0, 5),
        );
      }

      setLoading(false);
    }, 280);

    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <EventSearchAutocomplete
      query={query}
      suggestions={suggestions}
      loading={loading}
      onQueryChange={setQuery}
      onSubmit={(nextQuery) => {
        // eslint-disable-next-line no-console
        console.log("Search submitted:", nextQuery);
      }}
      onSelectSuggestion={(suggestion) => {
        // eslint-disable-next-line no-console
        console.log("Suggestion selected:", suggestion);
      }}
      emptyState={emptyState}
      placeholder="Search events, artists, or venues"
      maxVisibleSuggestions={6}
      autoFillOnSelect
    />
  );
};

const NavbarStory = ({ args }: { args: NavbarProps }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    brand: providedBrand,
    leadingAccessory: providedLeading,
    trailingAccessory: providedTrailing,
    children,
    ...restArgs
  } = args;

  const brand = providedBrand ?? (
    <BrandMark>
      <Text variant="body" weight="bold" tone="brandSecondary">
        TH
      </Text>
    </BrandMark>
  );

  const leadingAccessory = providedLeading ?? (
    <Button
      size="$3"
      variant="ghost"
      icon
      aria-pressed={menuOpen}
      onPress={() => setMenuOpen((prev) => !prev)}
    >
      <Menu size={20} strokeWidth={1.5} />
    </Button>
  );

  const trailingAccessory = providedTrailing ?? (
    <XStack gap="$2">
      <Button size="$3" variant="ghost" icon>
        <Share2 size={20} strokeWidth={1.5} />
      </Button>
      <NotificationButton aria-label="View notifications" count={5} />
      <Button size="$4">Publish</Button>
    </XStack>
  );

  const resolvedChildren = children ?? (
    <YStack gap="$2">
      <Text variant="body" tone="muted">
        Welcome back to the Ithas Fire dashboard.
      </Text>
      <Text variant="bodySmall" tone="muted">
        Use the search bar to jump to an event or browse the actions on the
        right.
      </Text>
    </YStack>
  );

  return (
    <Navbar
      {...restArgs}
      brand={brand}
      leadingAccessory={leadingAccessory}
      trailingAccessory={trailingAccessory}
    >
      {resolvedChildren}
    </Navbar>
  );
};
