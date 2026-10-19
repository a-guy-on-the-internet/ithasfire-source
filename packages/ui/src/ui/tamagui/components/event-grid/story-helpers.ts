import type {
  EventGridFilterState,
  EventGridFiltersConfig,
  EventSummary,
} from "./types";

export const storyEvents: EventSummary[] = [
  {
    id: "alpha",
    title: "Jazz at the Harbor",
    date: "2025-07-15",
    venue: "Pier 9 Pavilion",
    priceLabel: "$120",
    badge: { text: "Low fees", tone: "promo" },
    media: {
      url: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4",
      alt: "Jazz trio performing on stage",
      aspectRatio: 4 / 3,
    },
  },
  {
    id: "bravo",
    title: "Sunset Sessions",
    date: "2025-08-01",
    venue: "Skyline Deck",
    priceLabel: "$85",
    media: {
      url: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819",
      alt: "Crowd enjoying rooftop concert",
      aspectRatio: 4 / 3,
    },
    badge: { text: "Just added", tone: "hot" },
  },
  {
    id: "charlie",
    title: "Indie Film Night",
    date: "2025-09-05",
    venue: "Arcade Theater",
    priceLabel: "$42",
    media: {
      url: "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba",
      alt: "Film projector in a small theater",
      aspectRatio: 3 / 4,
    },
  },
  {
    id: "delta",
    title: "Local Makers Fair",
    date: "2025-09-18",
    venue: "Market Hall",
    priceLabel: "Free",
    media: {
      url: "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3",
      alt: "Craft market booth",
      aspectRatio: 4 / 3,
    },
  },
  {
    id: "echo",
    title: "Harvest Wine Walk",
    date: "2025-10-02",
    venue: "Old Town",
    priceLabel: "$65",
    media: {
      url: "https://images.unsplash.com/photo-1468078809804-4c7b3e60a478",
      alt: "Wine glasses on a barrel",
      aspectRatio: 4 / 3,
    },
  },
  {
    id: "foxtrot",
    title: "Autumn Folk Festival",
    date: "2025-10-14",
    venue: "Riverview Park",
    priceLabel: "$48",
    media: {
      url: "https://images.unsplash.com/photo-1506157786151-b8491531f063",
      alt: "Acoustic band on outdoor stage",
      aspectRatio: 4 / 3,
    },
  },
  {
    id: "golf",
    title: "Civic Design Summit",
    date: "2025-10-22",
    venue: "Innovation Hub",
    priceLabel: "$240",
    media: {
      url: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d",
      alt: "Audience watching a panel talk",
      aspectRatio: 16 / 9,
    },
    badge: { text: "Limited", tone: "cold" },
  },
  {
    id: "hotel",
    title: "Midnight Market",
    date: "2025-11-02",
    venue: "Warehouse Row",
    priceLabel: "$15",
    media: {
      url: "https://images.unsplash.com/photo-1489515217757-5fd1be406fef",
      alt: "Night market lights",
      aspectRatio: 4 / 3,
    },
  },
];

export const storyFilterState: EventGridFilterState = {};

export const storyFilterConfig: Pick<
  EventGridFiltersConfig,
  | "availableCategories"
  | "availableVenues"
  | "availableOrganizers"
  | "priceRange"
  | "dateLimits"
> = {
  availableCategories: [
    { id: "music", label: "Music", count: 3 },
    { id: "film", label: "Film", count: 1 },
    { id: "community", label: "Community", count: 1 },
    { id: "food", label: "Food & Drink", count: 1 },
  ],
  availableVenues: [
    { id: "pier-9", label: "Pier 9 Pavilion" },
    { id: "skyline", label: "Skyline Deck" },
    { id: "arcade", label: "Arcade Theater" },
    { id: "market-hall", label: "Market Hall" },
  ],
  availableOrganizers: [
    { id: "harbor", label: "Harbor Live" },
    { id: "sunset", label: "Sunset Collective" },
    { id: "arcade-arts", label: "Arcade Arts" },
    { id: "vintner", label: "Vintner Guild" },
  ],
  priceRange: { min: 0, max: 250, step: 5 },
  dateLimits: {
    min: "2025-07-01",
    max: "2025-12-31",
  },
};

export const storyEventById = Object.fromEntries(
  storyEvents.map((event) => [event.id, event]),
);
