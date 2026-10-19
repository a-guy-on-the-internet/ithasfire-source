import { action } from "@storybook/addon-actions";
import { useArgs } from "@storybook/preview-api";
import { useCallback, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

import { EventCard, type EventCardProps } from "./EventCard";
import type { EventSummary } from "./types";
import { EVENT_CARD_SIZE_OPTIONS, getEventCardWidthForLayout } from "./sizes";
import { storyEvents } from "./story-helpers";

// @ts-ignore -- Storybook uses direct source imports for provider configuration.
import { IthasFireProvider, themes } from "../../../tamagui";

const eventOptions = Object.fromEntries(
  storyEvents.map((event) => [`${event.title} – ${event.venue}`, event]),
);

type EventCardStoryProps = EventCardProps;

const meta: Meta<EventCardStoryProps> = {
  title: "Experiences/EventGrid/EventCard",
  component: EventCard,
  args: {
    event: storyEvents[0],
    layout: "vertical",
    size: "md",
    showFavorite: true,
    showBadge: true,
    disabled: false,
    favoriteIconStrokeWidth: 2.5,
    onPress: action("card-press"),
    onFavoriteToggle: action("favorite-toggle"),
    renderContext: { index: 0 },
  },
  argTypes: {
    event: {
      options: Object.keys(eventOptions),
      mapping: eventOptions,
      control: { type: "select" },
    },
    onPress: {
      control: false,
    },
    onFavoriteToggle: {
      control: false,
    },
    renderContext: {
      control: false,
    },
    size: {
      options: EVENT_CARD_SIZE_OPTIONS,
      control: { type: "inline-radio" },
    },
    layout: {
      options: ["vertical", "horizontal"],
      control: { type: "inline-radio" },
    },
    variant: {
      options: ["default", "feature"],
      control: { type: "inline-radio" },
    },
    favoriteIconStrokeWidth: {
      control: {
        type: "range",
        min: 1,
        max: 4,
        step: 0.25,
      },
    },
  },
  parameters: {
    controls: {
      sort: "alpha",
    },
  },
  render: (args) => {
    const [{ event: currentArgsEvent }, updateArgs] =
      useArgs<EventCardStoryProps>();
    const surfaceColor = themes.swiss.background;
    const size = args.size ?? "md";
    const layout = args.layout ?? "vertical";
    const cardWidth = getEventCardWidthForLayout(size, layout);
    const resolvedEvent = useMemo(
      () => currentArgsEvent ?? args.event ?? storyEvents[0],
      [args.event, currentArgsEvent],
    );

    const handleFavoriteToggle = useCallback<
      NonNullable<EventCardStoryProps["onFavoriteToggle"]>
    >(
      (eventSummary, nextFavorite, context) => {
        args.onFavoriteToggle?.(eventSummary, nextFavorite, context);
        updateArgs({
          event: {
            ...resolvedEvent,
            favorite: nextFavorite,
          },
        });
      },
      [args.onFavoriteToggle, resolvedEvent, updateArgs],
    );

    return (
      <IthasFireProvider theme="swiss">
        <YStack backgroundColor={surfaceColor} padding="$6" alignItems="center">
          <YStack width={cardWidth} maxWidth={cardWidth}>
            <EventCard
              {...args}
              event={{
                ...resolvedEvent,
                favorite: resolvedEvent.favorite ?? false,
              }}
              onFavoriteToggle={handleFavoriteToggle}
            />
          </YStack>
        </YStack>
      </IthasFireProvider>
    );
  },
};

type Story = StoryObj<EventCardStoryProps>;

export const Default: Story = {};

export const Small: Story = {
  args: {
    size: "sm",
  },
};

export const Medium: Story = {
  args: {
    size: "md",
  },
};

export const Large: Story = {
  args: {
    size: "lg",
  },
};

export const Horizontal: Story = {
  args: {
    layout: "horizontal",
  },
};

export const WithoutBadgeOrFavorite: Story = {
  args: {
    showBadge: false,
    showFavorite: false,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const Recurring: Story = {
  args: {
    event: {
      // `storyEvents[3]` is `EventSummary | undefined` under
      // noUncheckedIndexedAccess, so spreading it made every required field
      // optional and the object stopped satisfying `EventSummary`.
      ...(storyEvents[3] as EventSummary),
      title: "Tuesday Open Mic",
      priceLabel: "Free",
      isFree: true,
      isRecurring: true,
    },
  },
};

const hearthAndHowl = {
  id: "evt-hearth-howl",
  title: "Hearth & Howl Music Festival",
  date: "Sat Aug 15 · 2:00 PM",
  venue: "Riverfront Park, Nashville",
  priceLabel: "$45",
  serial: "001984",
  badge: { text: "Music · Festival" },
  media: {
    url: "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800&q=60",
    alt: "Festival crowd at dusk",
  },
} as const;

/**
 * The DS card tier, as the design-system folder renders it: corner category
 * tag, 3:2 art, the tear and its die-cuts, and a foot carrying the serial and
 * the price block.
 */
export const HearthAndHowl: Story = {
  args: {
    event: { ...hearthAndHowl },
    claimedPercent: 72,
  },
};

/**
 * FREE keeps the amber support treatment. That is deliberate and it is the one
 * place support colour appears in discovery — free community events are a real
 * local differentiator, not an absence of a price.
 */
export const Free: Story = {
  args: {
    event: {
      ...hearthAndHowl,
      id: "evt-smoke-ember",
      title: "Smoke & Ember BBQ Cookoff",
      venue: "Franklin Fairgrounds, Franklin",
      priceLabel: "Free",
      isFree: true,
      serial: "002140",
      badge: { text: "Food & Drink" },
      media: undefined,
    },
    claimedPercent: 88,
  },
};

/**
 * Sold out keeps FULL contrast: a quiet block and no claimed bar. Nothing is
 * dimmed — 42% opacity reads as broken rather than as unavailable, and a
 * sold-out show is social proof a thin marketplace needs.
 */
export const SoldOut: Story = {
  args: {
    event: {
      ...hearthAndHowl,
      id: "evt-neon-run",
      title: "Neon Run 5K",
      venue: "Shelby Bottoms, Nashville",
      priceLabel: "$28",
      soldOut: true,
      serial: "002011",
      badge: { text: "Sports" },
      media: undefined,
    },
    // Deliberately passed: the card must SWALLOW it when sold out.
    claimedPercent: 100,
  },
};

/** No upload at all — the initials carry the art window and it is still a ticket. */
export const NoImage: Story = {
  args: {
    event: { ...hearthAndHowl, media: undefined },
    claimedPercent: 41,
  },
};

/**
 * `variant="feature"` — the portrait poster, and the ONE place in the system
 * where type sits on an organizer's upload. One per page, and only where a
 * curator picked the event and can vouch for the image. Its scrim is the
 * system's single sanctioned gradient.
 */
export const FeaturePoster: Story = {
  args: {
    event: { ...hearthAndHowl },
    variant: "feature",
  },
};

export default meta;
