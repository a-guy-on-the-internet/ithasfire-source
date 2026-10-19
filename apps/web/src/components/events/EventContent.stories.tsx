import type { Meta, StoryObj } from "@storybook/react";
import type { Decorator } from "@storybook/react";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json";
import enApp from "../../i18n/messages/en";

import { EventContent, type EventContentProps } from "./EventContent";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Deep-merge two message catalogs (mirrors AppLocaleProvider logic). */
const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

// ─────────────────────────────────────────────────────────────────────────────
// Decorator — provides the translation context EventContent relies on
// ─────────────────────────────────────────────────────────────────────────────

const withTranslations: Decorator = (Story) => (
  <TranslationProvider locale="en" messages={messages}>
    <Story />
  </TranslationProvider>
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const HERO_IMAGE =
  "https://images.unsplash.com/photo-1531058020387-3be344556be6?w=800&q=80";

const TICKET_TYPES: EventContentProps["ticketTypes"] = [
  { id: "tt-ga", name: "General Admission", priceCents: 5000, capacity: 200 },
  { id: "tt-vip", name: "VIP", priceCents: 8500, capacity: 50 },
];

const EVENT_HUMANS: EventContentProps["eventHumans"] = [
  { id: "h-1", name: "DJ Nova", role: "PERFORMER" },
  { id: "h-2", name: "Mira Chen", role: "HOST" },
];

const EXACT_COORDS: EventContentProps["locationCoords"] = {
  latitude: 37.8738,
  longitude: -122.2543,
  label: "Greek Theatre",
  isExact: true,
};

/** OBSCURED location mode, pre-reveal — obfuscated point + radius. */
const OBSCURED_COORDS: EventContentProps["locationCoords"] = {
  latitude: 40.7484,
  longitude: -73.9856,
  label: null,
  isExact: false,
  radiusMeters: 800,
  areaLabel: "Midtown Manhattan",
};

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

const meta: Meta<typeof EventContent> = {
  title: "Events/EventContent",
  component: EventContent,
  decorators: [withTranslations],
  parameters: {
    layout: "padded",
  },
  argTypes: {
    mobile: { control: "boolean" },
    ticketAvailability: {
      control: "select",
      options: ["on_sale", "sold_out", "coming_soon"],
    },
  },
};

export default meta;
type Story = StoryObj<typeof EventContent>;

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/** Full event with exact location, map pin, and direction buttons. */
export const ExactLocation: Story = {
  args: {
    title: "Greek Theatre Under the Stars",
    startsAt: "2026-03-18T00:00:00.000Z",
    endsAt: "2026-03-18T04:00:00.000Z",
    location: "Berkeley, CA",
    heroImageUrl: HERO_IMAGE,
    ticketTypes: TICKET_TYPES,
    eventHumans: EVENT_HUMANS,
    ctaHref: "/events/checkout/greek-theatre",
    currency: "USD",
    locationCoords: EXACT_COORDS,
    ticketAvailability: "on_sale",
  },
};

/**
 * Exact location at a directory-listed venue — shows the hero "At {venue}"
 * badge plus the location section's "View venue page" link.
 */
export const ExactLocationWithVenueLink: Story = {
  args: {
    ...ExactLocation.args,
    // Entity-page slug shape (`{name}-{id8}`) — what `/places/[slug]` resolves
    // on. Never `Place.slug`, which is multi-segment and routes nowhere.
    placeSlug: "the-greek-theatre-a1b2c3d4",
    venueName: "Greek Theatre",
  },
};

/**
 * Obscured location (pre-reveal): the map renders the server-obfuscated
 * radius circle (soft fill, no pin) — but NO direction buttons and no
 * maps link on the location text, since the point is deliberately not
 * the venue (location-visibility-reveal spec FR-002).
 */
export const ObscuredLocation: Story = {
  args: {
    title: "Secret Rooftop Sessions",
    startsAt: "2026-06-21T22:00:00.000Z",
    endsAt: "2026-06-22T02:00:00.000Z",
    location: "Midtown, NYC",
    heroImageUrl:
      "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800&q=80",
    ticketTypes: [
      { id: "tt-1", name: "Early Bird", priceCents: 3500, capacity: 100 },
    ],
    eventHumans: [],
    ctaHref: "/events/checkout/secret-rooftop",
    currency: "USD",
    locationCoords: OBSCURED_COORDS,
    ticketAvailability: "on_sale",
  },
};

/** Event with coordinates but no location text label. */
export const CoordsOnlyNoText: Story = {
  name: "Coordinates Only (No Text)",
  args: {
    title: "Underground Warehouse Rave",
    startsAt: "2026-08-15T23:00:00.000Z",
    heroImageUrl:
      "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800&q=80",
    ticketTypes: [
      { id: "tt-1", name: "Entry", priceCents: 2000, capacity: 300 },
    ],
    currency: "USD",
    locationCoords: {
      latitude: 34.0407,
      longitude: -118.2468,
      isExact: false,
      radiusMeters: 1200,
      areaLabel: "Downtown Los Angeles",
    },
    ticketAvailability: "on_sale",
  },
};

/** No coordinates at all — map section should not render. */
export const NoLocation: Story = {
  args: {
    title: "Online Masterclass: Music Production",
    startsAt: "2026-04-10T18:00:00.000Z",
    endsAt: "2026-04-10T20:00:00.000Z",
    heroImageUrl:
      "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&q=80",
    ticketTypes: [
      { id: "tt-1", name: "Standard", priceCents: 1500, capacity: 500 },
    ],
    ctaHref: "/events/checkout/online-masterclass",
    currency: "USD",
    ticketAvailability: "on_sale",
  },
};

/** Mobile layout with exact location. */
export const MobileExactLocation: Story = {
  args: {
    ...ExactLocation.args,
    mobile: true,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};

/** Mobile layout with an obscured (pre-reveal) location — circle map, no directions. */
export const MobileObscuredLocation: Story = {
  args: {
    ...ObscuredLocation.args,
    mobile: true,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};

/**
 * Fully-hidden location (OBSCURED with no public radius): the server sends
 * no coordinates at all, so no map renders — only the area label text.
 */
export const FullyHiddenLocation: Story = {
  args: {
    ...ObscuredLocation.args,
    title: "Undisclosed Loft Session",
    locationCoords: undefined,
    location: "Bushwick, Brooklyn",
  },
};

/** Sold-out event with location. */
export const SoldOutWithLocation: Story = {
  args: {
    title: "Summer Block Party",
    startsAt: "2026-07-04T16:00:00.000Z",
    endsAt: "2026-07-04T23:00:00.000Z",
    location: "Brooklyn, NY",
    heroImageUrl:
      "https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=80",
    ticketTypes: [
      { id: "tt-1", name: "General", priceCents: 4500, capacity: 0 },
    ],
    eventHumans: EVENT_HUMANS,
    currency: "USD",
    locationCoords: {
      latitude: 40.6782,
      longitude: -73.9442,
      label: "Prospect Park Bandshell",
      isExact: true,
    },
    ticketAvailability: "sold_out",
  },
};

/** Tickets coming soon with approximate location. */
export const ComingSoonApproximate: Story = {
  args: {
    title: "NYE 2027 — Location TBA",
    startsAt: "2026-12-31T21:00:00.000Z",
    endsAt: "2027-01-01T04:00:00.000Z",
    location: "Manhattan, NYC",
    ticketTypes: [],
    currency: "USD",
    locationCoords: {
      latitude: 40.758,
      longitude: -73.9855,
      isExact: false,
      radiusMeters: 1500,
      areaLabel: "Times Square area",
    },
    ticketAvailability: "coming_soon",
  },
};

/** Full event with all sections populated — visual regression baseline. */
export const KitchenSink: Story = {
  args: {
    title: "Ithas Fire Launch Party",
    startsAt: "2026-09-15T19:00:00.000Z",
    endsAt: "2026-09-15T23:59:00.000Z",
    location: "The Fillmore, San Francisco",
    heroImageUrl: HERO_IMAGE,
    bodyHtml: `
      <h2>About This Event</h2>
      <p>Join us for the official launch of Ithas Fire — live music, food trucks, and open bar.</p>
      <h3>What to Expect</h3>
      <ul>
        <li>Live performances by local artists</li>
        <li>Networking with the Bay Area tech community</li>
        <li>Exclusive merch giveaways</li>
      </ul>
    `,
    ticketTypes: [
      { id: "tt-ga", name: "General Admission", priceCents: 0, capacity: 500 },
      { id: "tt-vip", name: "VIP", priceCents: 7500, capacity: 100 },
      {
        id: "tt-backstage",
        name: "Backstage Pass",
        priceCents: 15000,
        capacity: 25,
      },
    ],
    eventHumans: [
      { id: "h-1", name: "DJ Nova", role: "PERFORMER" },
      { id: "h-2", name: "Mira Chen", role: "HOST" },
      { id: "h-3", name: "Jamal Harris", role: "PERFORMER" },
    ],
    ctaHref: "/events/checkout/launch-party",
    currency: "USD",
    editHref: "/admin/org-1/events/evt-1",
    locationCoords: {
      latitude: 37.784,
      longitude: -122.4334,
      label: "The Fillmore",
      isExact: true,
    },
    ticketAvailability: "on_sale",
  },
};

/**
 * Lineup with server-derived listen URLs (lineup-listen-embeds spec): rows
 * whose `listenUrl` re-parses client-side to an iframe embed get a quiet
 * "Listen" chip; the FIRST listenable entry auto-expands its player on
 * desktop (`mobile: false`). "Opening Act" has no music and renders without
 * a chip; the Bandcamp entry is `renderMode: "link"` (not inline-playable),
 * so it gets no chip either.
 */
export const LineupWithListenEmbeds: Story = {
  args: {
    title: "Listen Before You Go",
    startsAt: "2026-03-18T00:00:00.000Z",
    location: "Nashville, TN",
    ticketTypes: TICKET_TYPES,
    eventHumans: [
      { id: "h-1", name: "Opening Act", role: "PERFORMER", listenUrl: null },
      {
        id: "h-2",
        name: "The Headliners",
        role: "PERFORMER",
        listenUrl: "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb",
      },
      {
        id: "h-3",
        name: "Support Act",
        role: "PERFORMER",
        listenUrl: "https://soundcloud.com/forss/flickermood",
      },
      {
        id: "h-4",
        name: "Link-Only Band",
        role: "PERFORMER",
        listenUrl: "https://linkonly.bandcamp.com/album/demo",
      },
    ],
    ctaHref: "/events/checkout/listen-before-you-go",
    currency: "USD",
    ticketAvailability: "on_sale",
  },
};
