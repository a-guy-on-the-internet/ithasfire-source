import type { EventSchemaType } from "@th/types";

import { DEMO_IDS } from "./ids.js";
import { slugify } from "./utils.js";

// ── Types ────────────────────────────────────────────────────────────────

export type TicketFixture = {
  name: string;
  priceCents: number;
  capacity: number;
  /** Link this ticket type to a PlaceLayout section by its stable layout ID (e.g. "ga-floor"). */
  layoutSectionId?: string;
};

export type EventSeedFixture = {
  slug: string;
  title: string;
  addressText: string;
  regionCode: string;
  daysFromNow: number;
  startHour: number;
  durationHours: number;
  status: "PUBLISHED" | "DRAFT" | "CANCELLED" | "COMPLETED";
  visibility: "PUBLIC" | "PRIVATE";
  gateType: "NONE" | "PASSWORD" | "APPLICATION";
  /** For PASSWORD gated events - the plaintext password to set */
  gatePassword?: string;
  /** For APPLICATION gated events - application form questions */
  applicationQuestions?: Array<{
    prompt: string;
    type: "SHORT_TEXT" | "LONG_TEXT";
  }>;
  /** Category slug for this event (matched against seeded categories). */
  categorySlug?: string;
  /** Event type (sub-category) slug for this event. */
  /** Which org owns this event. Assigned at fixture-build time based on region. */
  orgId?: string;
  /** The human acting on behalf of the org (must be a member). */
  actorHumanId?: string;
  /** Link this event to a Place (venue) so the seat painter is available. */
  placeId?: string;
  tickets: TicketFixture[];
};

export type HumanEventFixture = {
  slug: string;
  title: string;
  addressText: string;
  regionCode: string;
  daysFromNow: number;
  startHour: number;
  durationHours: number;
  status: "PUBLISHED" | "DRAFT";
  categorySlug: string;
  /** Event type (sub-category) slug for this event. */
  tickets: TicketFixture[];
};

export type AdditionalHumanFixture = {
  id: string;
  authUserId: string;
  email: string;
  name: string;
  profileSlug: string;
  bio?: string;
};

export type AdditionalOrgFixture = {
  id: string;
  name: string;
  slug: string;
  memberHumanIds: string[];
  ownerHumanId: string;
  adminHumanIds?: string[];
};

export type PlaceFixture = {
  id: string;
  name: string;
  address: string;
  city: string;
  region: string; // state/province
  country: string;
  postcode: string;
  lat: number;
  lng: number;
  /**
   * IANA timezone for the venue's locale (venue-hierarchy FR-004 — calendar
   * wall-clock times resolve through Place.timezone). Required so dev never
   * runs with a NULL timezone column.
   */
  timezone: string;
  capacity?: number;
  ownerHumanId?: string;
  ownerOrgId?: string;
  /** When true the place stays UNVERIFIED (default is VERIFIED). */
  unverified?: boolean;
  /** Whether the place should appear in the public venue directory / autocomplete. */
  listedInDirectory?: boolean;
  /**
   * Whether the venue accepts booking requests (default true so seeded venue
   * pages exercise the Request-to-book CTA). The public gate
   * (`placeAcceptsBookingRequests` in @th/types) additionally requires
   * VERIFIED, so unverified fixtures keep the CTA hidden regardless.
   */
  acceptsBookingRequests?: boolean;
};

// ── Regions ──────────────────────────────────────────────────────────────

export const REGIONS: Array<{ code: string; label: string }> = [
  { code: "ca-sf", label: "San Francisco" },
  { code: "ny-nyc", label: "New York" },
  { code: "tx-aus", label: "Austin" },
  { code: "il-chi", label: "Chicago" },
];

// ── Category taxonomy ────────────────────────────────────────────────────

/**
 * Category taxonomy seeded by `pnpm seed:dev` AND (for the subset where
 * `platformDefault !== false`) by the production platform-categories
 * bootstrap script. Anything flagged `platformDefault: false` exists in
 * dev fixtures for testing but is intentionally withheld from prod
 * launches — usually because it carries moderation / sensitivity
 * concerns we want to handle deliberately rather than by default.
 */
export const SEED_CATEGORIES: ReadonlyArray<{
  slug: string;
  name: string;
  sortOrder: number;
  platformDefault?: boolean;
  /**
   * schema.org Event `@type` for JSON-LD (must be one of `EVENT_SCHEMA_TYPES`).
   * Music-adjacent categories emit `MusicEvent` — this mirrors exactly what the
   * `20260715120000_add_category_seo_type` migration backfills on prod so a
   * fresh db-push dev seed matches. Omit to default to `Event`.
   */
  seoType?: EventSchemaType;
}> = [
  { slug: "music", name: "Music", sortOrder: 0, seoType: "MusicEvent" },
  { slug: "nightlife", name: "Nightlife", sortOrder: 1, seoType: "MusicEvent" },
  { slug: "food-drink", name: "Food & Drink", sortOrder: 2 },
  { slug: "community", name: "Community", sortOrder: 3 },
  { slug: "film", name: "Film & Media", sortOrder: 4 },
  { slug: "arts", name: "Arts & Culture", sortOrder: 5 },
  { slug: "sports", name: "Sports & Fitness", sortOrder: 6 },
  { slug: "conference", name: "Conference & Workshop", sortOrder: 7 },
  {
    slug: "support-recovery",
    name: "Support & Recovery",
    sortOrder: 8,
    platformDefault: false,
  },
  { slug: "open-mics", name: "Open Mics", sortOrder: 9, seoType: "MusicEvent" },
  { slug: "other", name: "Other", sortOrder: 10 },
];

// ── Tag genre seeds ──────────────────────────────────────────────────────
// Genre / sub-flavor tags grouped by category for context. Tags themselves
// are flat (single name+slug) — `categorySlug` is informational metadata so
// the seeder can decide which set to install for which platform footprint.

export type TagGenreSeed = {
  categorySlug: string;
  slug: string;
  name: string;
  sortIndex: number;
};

/**
 * Curated genre tags. Replaces the former per-category EventType taxonomy
 * with free-form tags that an event can have multiple of (e.g. a show that
 * is both "rock" and "indie").
 */
export const SEED_TAG_GENRES: TagGenreSeed[] = [
  // Music
  { categorySlug: "music", slug: "rock", name: "Rock", sortIndex: 0 },
  { categorySlug: "music", slug: "pop", name: "Pop", sortIndex: 1 },
  { categorySlug: "music", slug: "hip-hop", name: "Hip-Hop", sortIndex: 2 },
  { categorySlug: "music", slug: "jazz", name: "Jazz", sortIndex: 3 },
  { categorySlug: "music", slug: "classical", name: "Classical", sortIndex: 4 },
  {
    categorySlug: "music",
    slug: "electronic",
    name: "Electronic",
    sortIndex: 5,
  },
  { categorySlug: "music", slug: "indie", name: "Indie", sortIndex: 6 },
  { categorySlug: "music", slug: "country", name: "Country", sortIndex: 7 },
  { categorySlug: "music", slug: "other", name: "Other", sortIndex: 99 },

  // Nightlife
  {
    categorySlug: "nightlife",
    slug: "club-night",
    name: "Club Night",
    sortIndex: 0,
  },
  { categorySlug: "nightlife", slug: "dj-set", name: "DJ Set", sortIndex: 1 },
  {
    categorySlug: "nightlife",
    slug: "after-party",
    name: "After Party",
    sortIndex: 2,
  },
  {
    categorySlug: "nightlife",
    slug: "bar-crawl",
    name: "Bar Crawl",
    sortIndex: 3,
  },
  { categorySlug: "nightlife", slug: "other", name: "Other", sortIndex: 99 },

  // Food & Drink
  {
    categorySlug: "food-drink",
    slug: "tasting",
    name: "Tasting",
    sortIndex: 0,
  },
  { categorySlug: "food-drink", slug: "pop-up", name: "Pop-Up", sortIndex: 1 },
  {
    categorySlug: "food-drink",
    slug: "cooking-class",
    name: "Cooking Class",
    sortIndex: 2,
  },
  {
    categorySlug: "food-drink",
    slug: "wine-beer",
    name: "Wine & Beer",
    sortIndex: 3,
  },
  { categorySlug: "food-drink", slug: "other", name: "Other", sortIndex: 99 },

  // Community
  {
    categorySlug: "community",
    slug: "workshop",
    name: "Workshop",
    sortIndex: 0,
  },
  { categorySlug: "community", slug: "meetup", name: "Meetup", sortIndex: 1 },
  { categorySlug: "community", slug: "panel", name: "Panel", sortIndex: 2 },
  {
    categorySlug: "community",
    slug: "fundraiser",
    name: "Fundraiser",
    sortIndex: 3,
  },
  { categorySlug: "community", slug: "other", name: "Other", sortIndex: 99 },

  // Film & Media
  { categorySlug: "film", slug: "screening", name: "Screening", sortIndex: 0 },
  { categorySlug: "film", slug: "premiere", name: "Premiere", sortIndex: 1 },
  {
    categorySlug: "film",
    slug: "documentary",
    name: "Documentary",
    sortIndex: 2,
  },
  {
    categorySlug: "film",
    slug: "film-festival",
    name: "Film Festival",
    sortIndex: 3,
  },
  { categorySlug: "film", slug: "other", name: "Other", sortIndex: 99 },

  // Arts & Culture
  { categorySlug: "arts", slug: "gallery", name: "Gallery", sortIndex: 0 },
  {
    categorySlug: "arts",
    slug: "performance",
    name: "Performance",
    sortIndex: 1,
  },
  {
    categorySlug: "arts",
    slug: "installation",
    name: "Installation",
    sortIndex: 2,
  },
  { categorySlug: "arts", slug: "theater", name: "Theater", sortIndex: 3 },
  { categorySlug: "arts", slug: "other", name: "Other", sortIndex: 99 },

  // Sports & Fitness
  { categorySlug: "sports", slug: "game", name: "Game", sortIndex: 0 },
  {
    categorySlug: "sports",
    slug: "tournament",
    name: "Tournament",
    sortIndex: 1,
  },
  {
    categorySlug: "sports",
    slug: "fitness-class",
    name: "Fitness Class",
    sortIndex: 2,
  },
  {
    categorySlug: "sports",
    slug: "run-race",
    name: "Run / Race",
    sortIndex: 3,
  },
  { categorySlug: "sports", slug: "esports", name: "Esports", sortIndex: 4 },
  { categorySlug: "sports", slug: "other", name: "Other", sortIndex: 99 },

  // Conference & Workshop
  {
    categorySlug: "conference",
    slug: "conference",
    name: "Conference",
    sortIndex: 0,
  },
  {
    categorySlug: "conference",
    slug: "seminar",
    name: "Seminar",
    sortIndex: 1,
  },
  {
    categorySlug: "conference",
    slug: "bootcamp",
    name: "Bootcamp",
    sortIndex: 2,
  },
  {
    categorySlug: "conference",
    slug: "lecture",
    name: "Lecture",
    sortIndex: 3,
  },
  { categorySlug: "conference", slug: "other", name: "Other", sortIndex: 99 },

  // Support & Recovery
  {
    categorySlug: "support-recovery",
    slug: "peer-support",
    name: "Peer Support",
    sortIndex: 0,
  },
  {
    categorySlug: "support-recovery",
    slug: "group-therapy",
    name: "Group Therapy",
    sortIndex: 1,
  },
  {
    categorySlug: "support-recovery",
    slug: "twelve-step",
    name: "12-Step",
    sortIndex: 2,
  },
  {
    categorySlug: "support-recovery",
    slug: "grief-loss",
    name: "Grief & Loss",
    sortIndex: 3,
  },
  {
    categorySlug: "support-recovery",
    slug: "wellness",
    name: "Wellness",
    sortIndex: 4,
  },
  {
    categorySlug: "support-recovery",
    slug: "other",
    name: "Other",
    sortIndex: 99,
  },

  // Open Mics
  { categorySlug: "open-mics", slug: "comedy", name: "Comedy", sortIndex: 0 },
  { categorySlug: "open-mics", slug: "music", name: "Music", sortIndex: 1 },
  { categorySlug: "open-mics", slug: "poetry", name: "Poetry", sortIndex: 2 },
  {
    categorySlug: "open-mics",
    slug: "storytelling",
    name: "Storytelling",
    sortIndex: 3,
  },
  { categorySlug: "open-mics", slug: "variety", name: "Variety", sortIndex: 4 },
  { categorySlug: "open-mics", slug: "other", name: "Other", sortIndex: 99 },
];

// ── Demo event images ────────────────────────────────────────────────────

/**
 * Demo event images from Unsplash (free to use, stable URLs).
 * These rotate through seed events to give visual variety.
 */
export const DEMO_EVENT_IMAGES = [
  // Music/concerts
  {
    url: "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800&q=80",
    category: "music",
  },
  {
    url: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800&q=80",
    category: "music",
  },
  {
    url: "https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=80",
    category: "music",
  },
  {
    url: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&q=80",
    category: "music",
  },
  // Nightlife/parties
  {
    url: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800&q=80",
    category: "nightlife",
  },
  {
    url: "https://images.unsplash.com/photo-1489515217757-5fd1be406fef?w=800&q=80",
    category: "nightlife",
  },
  {
    url: "https://images.unsplash.com/photo-1545128485-c400e7702796?w=800&q=80",
    category: "nightlife",
  },
  // Food/drink
  {
    url: "https://images.unsplash.com/photo-1551218808-94e220e084d2?w=800&q=80",
    category: "food",
  },
  {
    url: "https://images.unsplash.com/photo-1468078809804-4c7b3e60a478?w=800&q=80",
    category: "food",
  },
  {
    url: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&q=80",
    category: "food",
  },
  // Community/markets
  {
    url: "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800&q=80",
    category: "community",
  },
  {
    url: "https://images.unsplash.com/photo-1531058020387-3be344556be6?w=800&q=80",
    category: "community",
  },
  // Film/arts
  {
    url: "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800&q=80",
    category: "film",
  },
  {
    url: "https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=800&q=80",
    category: "film",
  },
  // Conference/business
  {
    url: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=800&q=80",
    category: "conference",
  },
  {
    url: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80",
    category: "conference",
  },
  // Sports/outdoor
  {
    url: "https://images.unsplash.com/photo-1530549387789-4c1017266635?w=800&q=80",
    category: "sports",
  },
  {
    url: "https://images.unsplash.com/photo-1571902943202-507ec2618e8f?w=800&q=80",
    category: "sports",
  },
  // Arts & Culture
  {
    url: "https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=800&q=80",
    category: "arts",
  },
  {
    url: "https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?w=800&q=80",
    category: "arts",
  },
  // Support & Recovery / Wellness
  {
    url: "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=800&q=80",
    category: "support-recovery",
  },
  {
    url: "https://images.unsplash.com/photo-1573497620053-ea5300f94f21?w=800&q=80",
    category: "support-recovery",
  },
  // Open Mics / Comedy / Performance
  {
    url: "https://images.unsplash.com/photo-1551818176-b35b6b47cce4?w=800&q=80",
    category: "open-mics",
  },
  {
    url: "https://images.unsplash.com/photo-1503095396549-807759245b35?w=800&q=80",
    category: "open-mics",
  },
];

// ── Event body templates ─────────────────────────────────────────────────

export const SEED_BODY_TEMPLATES: Array<{
  heading: string;
  paragraphs: string[];
}> = [
  {
    heading: "About This Event",
    paragraphs: [
      "Join us for an unforgettable experience that brings together the best of local talent, community spirit, and world-class entertainment. Whether you're a first-timer or a seasoned regular, there's something here for everyone.",
      "Doors open 30 minutes before the scheduled start time. Please arrive early to secure your preferred spot and enjoy our curated selection of local food and drink vendors.",
      "This is an all-ages event. Children under 12 must be accompanied by a guardian. Accessible seating is available on request.",
    ],
  },
  {
    heading: "What to Expect",
    paragraphs: [
      "Prepare for an evening of incredible performances, immersive art installations, and meaningful connections with fellow attendees. Our lineup has been carefully curated to deliver a diverse and exciting program.",
      "Complimentary refreshments will be provided during intermission. VIP ticket holders enjoy exclusive access to the lounge area with premium bar service.",
      "Photography is encouraged! Tag us on social media and share your favorite moments from the night.",
    ],
  },
  {
    heading: "Event Details",
    paragraphs: [
      "This event is part of our ongoing series celebrating the vibrant culture and creative energy of the local scene. Each installment brings fresh voices and perspectives to the stage.",
      "On-site parking is limited. We strongly encourage using public transit or rideshare services. Bike racks are available at the venue entrance.",
      "In the event of inclement weather, the show will move indoors. All ticket sales are final. Please review our refund policy on the event page for details.",
    ],
  },
  {
    heading: "Welcome",
    paragraphs: [
      "We're thrilled to announce this special gathering, designed to bring our community together for a night of celebration, creativity, and good vibes.",
      "Featured artists and speakers will be announced in the weeks leading up to the event. Follow our page for updates and exclusive behind-the-scenes content.",
      "Early bird pricing is available for a limited time. Grab your tickets now before they sell out!",
    ],
  },
  {
    heading: "Don't Miss Out",
    paragraphs: [
      "Mark your calendars for what promises to be one of the standout events of the season. From live music to interactive workshops, this is more than just a show — it's an experience.",
      "Food trucks and artisan vendors will line the courtyard, offering everything from gourmet tacos to craft cocktails. Come hungry!",
      "Group discounts are available for parties of 6 or more. Contact us directly for pricing and availability.",
    ],
  },
];

export function buildSeedEventBody(title: string, index: number) {
  const template = SEED_BODY_TEMPLATES[index % SEED_BODY_TEMPLATES.length]!;

  const docContent: Array<Record<string, unknown>> = [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: template.heading }],
    },
  ];

  for (const para of template.paragraphs) {
    docContent.push({
      type: "paragraph",
      content: [{ type: "text", text: para }],
    });
  }

  // Add a bold closing line
  docContent.push({
    type: "paragraph",
    content: [
      { type: "text", text: "We can't wait to see you at " },
      {
        type: "text",
        marks: [{ type: "bold" }],
        text: title,
      },
      { type: "text", text: "!" },
    ],
  });

  return {
    version: 1 as const,
    sections: [
      {
        id: `seed-section-${index}`,
        kind: "section" as const,
        style: {
          background: "default" as const,
          density: "normal" as const,
          maxWidth: "prose" as const,
          textAlign: "left" as const,
        },
        layout: {
          type: "singleColumn" as const,
          columns: [
            {
              blocks: [
                {
                  id: `seed-rt-${index}`,
                  type: "richText" as const,
                  doc: {
                    type: "doc" as const,
                    content: docContent,
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

// ── Category inference ───────────────────────────────────────────────────

/** Map event titles to category slugs via keyword matching. */
export const inferCategorySlug = (title: string): string => {
  const t = title.toLowerCase();
  // Check more-specific multi-word patterns first to avoid `night$` stealing comedy/open-mic events.
  if (
    /open.?mic|comedy open|stand.?up|poetry slam|spoken word|comedy night/.test(
      t,
    )
  )
    return "open-mics";
  if (
    /recovery|sobriety|support group|grief|peer support|wellness circle/.test(t)
  )
    return "support-recovery";
  if (
    /jazz|music|vinyl|jam|honky|indie|live music|session|decks|showcase/.test(t)
  )
    return "music";
  if (/rave|warehouse|club|party|block party|afterparty|night$/.test(t))
    return "nightlife";
  if (/supper|bbq|food|cocktail|dinner|coffee|wine|street food/.test(t))
    return "food-drink";
  if (/cinema|movie|film|rooftop cinema/.test(t)) return "film";
  if (/run|swim|tailgate|sprint|fitness|sports/.test(t)) return "sports";
  if (/gallery|art|pop-up|makers|market|walk/.test(t)) return "arts";
  if (/masterclass|workshop|class/.test(t)) return "conference";
  // Fallback: community
  return "community";
};


// ── Event fixture builder ────────────────────────────────────────────────

export const buildEventFixtures = (): EventSeedFixture[] => {
  const fixtures: EventSeedFixture[] = [];

  // Distribute events across orgs by region so admin data tables aren't overloaded.
  const REGION_ORG_MAP: Record<
    string,
    { orgId: string; actorHumanId: string }
  > = {
    "tx-aus": { orgId: DEMO_IDS.org2, actorHumanId: DEMO_IDS.human2 },
    "ca-sf": { orgId: DEMO_IDS.org3, actorHumanId: DEMO_IDS.human3 },
    "il-chi": { orgId: DEMO_IDS.org4, actorHumanId: DEMO_IDS.human6 },
  };
  const DEFAULT_ORG = { orgId: DEMO_IDS.org, actorHumanId: DEMO_IDS.human };

  const titlesByRegion: Record<string, string[]> = {
    "ca-sf": [
      "SOMA Warehouse Rave",
      "North Beach Jazz Night",
      "Mission District Film Screening",
      "Dolores Park Fitness Bootcamp",
      "Castro Theatre Documentary Premiere",
      "Mission Recovery Wellness Circle",
    ],
    "ny-nyc": [
      "Brooklyn Warehouse Showcase",
      "Williamsburg Vinyl Club",
      "Brooklyn Open Mic Night",
      "Manhattan Gallery Walk",
      "Brooklyn Bridge Park 5K",
      "Lower East Side Charity Fundraiser",
    ],
    "tx-aus": [
      "Live Music on Red River",
      "South Congress Art Pop-up",
      "Austin Recovery Circle",
      "Sixth Street Comedy Night",
      "Zilker Park Yoga Class",
      "Austin Tech Lecture Series",
    ],
    "il-chi": [
      "Logan Square DIY Punk Show",
      "Empty Bottle Indie Showcase",
      "Pilsen Open Mic",
      "West Loop Wine Tasting",
    ],
  };

  // Map specific event titles to places so the seating tab / seat painter
  // is available in the event builder.  Events with a placeId inherit the
  // place's coordinates and skip the manual lat/lng.
  const TITLE_TO_PLACE: Record<string, string> = {
    "SOMA Warehouse Rave": DEMO_IDS.place6, // SOMA Warehouse (owned by org3)
    "Live Music on Red River": DEMO_IDS.place2, // Stubb's BBQ (owned by org2)
    "North Beach Jazz Night": DEMO_IDS.place3, // The Fillmore (owned by org3)
  };

  // Real-looking addresses for events NOT linked to a Place.
  // Keyed by event title — fallback is the region label.
  const TITLE_TO_ADDRESS: Record<string, string> = {
    "SOMA Warehouse Rave": "1015 Folsom St, San Francisco, CA 94103",
    "North Beach Jazz Night": "1805 Geary Blvd, San Francisco, CA 94115",
    "Mission District Film Screening":
      "2575 Mission St, San Francisco, CA 94110",
    "Dolores Park Fitness Bootcamp":
      "19th St & Dolores St, San Francisco, CA 94114",
    "Brooklyn Warehouse Showcase": "319 Scholes St, Brooklyn, NY 11206",
    "Williamsburg Vinyl Club": "64 N 9th St, Brooklyn, NY 11249",
    "Brooklyn Open Mic Night": "111 N 12th St, Brooklyn, NY 11249",
    "Manhattan Gallery Walk": "548 W 28th St, New York, NY 10001",
    "Live Music on Red River": "801 Red River St, Austin, TX 78701",
    "South Congress Art Pop-up": "1500 S Congress Ave, Austin, TX 78704",
    "Austin Recovery Circle": "1600 W 38th St, Austin, TX 78731",
    "Sixth Street Comedy Night": "611 E 6th St, Austin, TX 78701",
    "Castro Theatre Documentary Premiere":
      "429 Castro St, San Francisco, CA 94114",
    "Mission Recovery Wellness Circle": "3036 24th St, San Francisco, CA 94110",
    "Brooklyn Bridge Park 5K": "Pier 1, Brooklyn, NY 11201",
    "Lower East Side Charity Fundraiser": "85 Delancey St, New York, NY 10002",
    "Zilker Park Yoga Class": "2207 Lou Neff Rd, Austin, TX 78746",
    "Austin Tech Lecture Series": "1100 W 6th St, Austin, TX 78703",
    "Logan Square DIY Punk Show": "2500 N Milwaukee Ave, Chicago, IL 60647",
    "Empty Bottle Indie Showcase": "1035 N Western Ave, Chicago, IL 60622",
    "Pilsen Open Mic": "1800 S Halsted St, Chicago, IL 60608",
    "West Loop Wine Tasting": "905 W Fulton Market, Chicago, IL 60607",
  };

  // Wire Chicago events to their PlaceLayout-less venues so the place column populates.
  const CHICAGO_TITLE_TO_PLACE: Record<string, string> = {
    "Empty Bottle Indie Showcase": DEMO_IDS.place7,
    "Logan Square DIY Punk Show": DEMO_IDS.place8,
  };
  Object.assign(TITLE_TO_PLACE, CHICAGO_TITLE_TO_PLACE);

  const baseTickets: TicketFixture[] = [
    { name: "General Admission", priceCents: 3500, capacity: 250 },
    { name: "VIP", priceCents: 9500, capacity: 50 },
  ];

  // Events at venues with a PlaceLayout get section-aware ticket types.
  // The `layoutSectionId` links each ticket to the layout section's stable ID
  // so the seed can wire `seatSectionId` after materialization — no name matching.
  const TITLE_TO_TICKETS: Record<string, TicketFixture[]> = {
    "SOMA Warehouse Rave": [
      {
        name: "General Admission",
        priceCents: 3500,
        capacity: 250,
        layoutSectionId: "ga-floor",
      },
      {
        name: "VIP",
        priceCents: 9500,
        capacity: 50,
        layoutSectionId: "vip-lounge",
      },
    ],
    "Live Music on Red River": [
      {
        name: "General Admission",
        priceCents: 3500,
        capacity: 250,
        layoutSectionId: "ga",
      },
      { name: "VIP", priceCents: 9500, capacity: 50, layoutSectionId: "vip" },
    ],
    "North Beach Jazz Night": [
      {
        name: "Orchestra",
        priceCents: 5500,
        capacity: 80,
        layoutSectionId: "orch",
      },
      {
        name: "Mezzanine",
        priceCents: 4500,
        capacity: 48,
        layoutSectionId: "mezz",
      },
      {
        name: "Balcony",
        priceCents: 3500,
        capacity: 40,
        layoutSectionId: "balc",
      },
    ],
  };

  let globalIdx = 0;
  for (const region of REGIONS) {
    const titles = titlesByRegion[region.code] ?? [];
    for (const [i, title] of titles.entries()) {
      globalIdx += 1;

      const daysFromNow = (i + 1) * 5;
      const startHour = (16 + (i % 7)) % 24;
      const durationHours = 3 + (i % 3);

      const slug = `${region.code}-${slugify(title)}`;
      const addressText =
        TITLE_TO_ADDRESS[title] ?? `${region.label} · ${title}`;

      // Use section-aware ticket overrides when the event has a PlaceLayout,
      // otherwise fall back to generic base tickets with price variation.
      const priceBump = (globalIdx % 5) * 500;
      const overrideTickets = TITLE_TO_TICKETS[title];
      const tickets: TicketFixture[] = overrideTickets
        ? overrideTickets.map((t, idx) => ({
            ...t,
            priceCents: t.priceCents + priceBump + idx * 1500,
          }))
        : baseTickets.map((t, idx) => ({
            ...t,
            priceCents: t.priceCents + priceBump + idx * 1500,
          }));

      const orgMapping = REGION_ORG_MAP[region.code] ?? DEFAULT_ORG;
      const placeId = TITLE_TO_PLACE[title];
      const catSlug = inferCategorySlug(title);

      fixtures.push({
        slug,
        title,
        addressText,
        regionCode: region.code,
        daysFromNow,
        startHour,
        durationHours,
        status: "PUBLISHED",
        visibility: "PUBLIC",
        gateType: "NONE",
        categorySlug: catSlug,
        orgId: orgMapping.orgId,
        actorHumanId: orgMapping.actorHumanId,
        ...(placeId ? { placeId } : {}),
        tickets,
      });
    }
  }

  // Ensure we always seed something for DEFAULT_REGION_CODE
  const DEFAULT_REGION_CODE = (
    process.env.THC_EVENTS_DEFAULT_REGION_CODE ?? "ca-sf"
  )
    .trim()
    .toLowerCase();

  if (!fixtures.some((f) => f.regionCode === DEFAULT_REGION_CODE)) {
    fixtures.push({
      slug: `${DEFAULT_REGION_CODE}-demo-kickoff`,
      title: "Demo Kickoff",
      addressText: "101 Howard St, San Francisco, CA 94105",
      regionCode: DEFAULT_REGION_CODE,
      daysFromNow: 2,
      startHour: 19,
      durationHours: 3,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      gateType: "NONE",
      tickets: [{ name: "General Admission", priceCents: 4500, capacity: 200 }],
    });
  }

  // ── Explicit Gated Events for Testing ──────────────────────────────────

  // Password-gated VIP event
  fixtures.push({
    slug: "ca-sf-vip-members-only",
    title: "VIP Members Only Night",
    addressText: "520 Jones St, San Francisco, CA 94102",
    regionCode: "ca-sf",
    daysFromNow: 5,
    startHour: 21,
    durationHours: 4,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "PASSWORD",
    gatePassword: "demo1234",
    categorySlug: "nightlife",
    orgId: DEMO_IDS.org3,
    actorHumanId: DEMO_IDS.human3,
    tickets: [
      { name: "VIP Access", priceCents: 15000, capacity: 50 },
      { name: "VIP + Backstage", priceCents: 25000, capacity: 10 },
    ],
  });

  // Password-gated private dinner
  fixtures.push({
    slug: "ca-sf-secret-supper",
    title: "Secret Supper Club",
    addressText: "786 Bush St, San Francisco, CA 94108",
    regionCode: "ca-sf",
    daysFromNow: 10,
    startHour: 19,
    durationHours: 3,
    status: "PUBLISHED",
    visibility: "PRIVATE",
    gateType: "PASSWORD",
    gatePassword: "demo1234",
    categorySlug: "food-drink",
    orgId: DEMO_IDS.org3,
    actorHumanId: DEMO_IDS.human3,
    tickets: [{ name: "Dinner Seat", priceCents: 8500, capacity: 24 }],
  });

  // Application-gated invite-only event
  fixtures.push({
    slug: "ca-sf-founders-dinner",
    title: "Founders & Friends Dinner",
    addressText: "3127 Fillmore St, San Francisco, CA 94123",
    regionCode: "ca-sf",
    daysFromNow: 14,
    startHour: 18,
    durationHours: 4,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "APPLICATION",
    applicationQuestions: [
      { prompt: "Tell us about yourself and your work.", type: "LONG_TEXT" },
      { prompt: "How did you hear about this event?", type: "SHORT_TEXT" },
      { prompt: "Why would you like to attend?", type: "LONG_TEXT" },
    ],
    categorySlug: "food-drink",
    orgId: DEMO_IDS.org3,
    actorHumanId: DEMO_IDS.human3,
    tickets: [{ name: "Dinner Seat", priceCents: 0, capacity: 30 }],
  });

  // Application-gated workshop
  fixtures.push({
    slug: "ny-nyc-invite-only-workshop",
    title: "Exclusive Masterclass Workshop",
    addressText: "138 W 25th St, New York, NY 10001",
    regionCode: "ny-nyc",
    daysFromNow: 21,
    startHour: 14,
    durationHours: 6,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "APPLICATION",
    applicationQuestions: [
      { prompt: "What is your current skill level?", type: "SHORT_TEXT" },
      {
        prompt: "What do you hope to learn from this workshop?",
        type: "LONG_TEXT",
      },
    ],
    categorySlug: "conference",
    tickets: [{ name: "Workshop Seat", priceCents: 50000, capacity: 15 }],
  });

  // ── Venue-linked events (assigned seating / seat painter) ──────────────

  // Paramount Theatre — owned by default org
  fixtures.push({
    slug: "tx-aus-paramount-showcase",
    title: "Paramount Theatre Showcase",
    addressText: "713 Congress Ave, Austin, TX 78701",
    regionCode: "tx-aus",
    daysFromNow: 12,
    startHour: 20,
    durationHours: 3,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    categorySlug: "music",
    orgId: DEMO_IDS.org,
    actorHumanId: DEMO_IDS.human,
    placeId: DEMO_IDS.place1,
    tickets: [
      {
        name: "Orchestra",
        priceCents: 7500,
        capacity: 80,
        layoutSectionId: "orch",
      },
      {
        name: "Mezzanine",
        priceCents: 5500,
        capacity: 48,
        layoutSectionId: "mezz",
      },
      {
        name: "Balcony",
        priceCents: 3500,
        capacity: 40,
        layoutSectionId: "balc",
      },
    ],
  });

  // Greek Theatre — owned by org3
  fixtures.push({
    slug: "ca-sf-greek-theatre-night",
    title: "Greek Theatre Under the Stars",
    addressText: "2001 Gayley Rd, Berkeley, CA 94720",
    regionCode: "ca-sf",
    daysFromNow: 18,
    startHour: 19,
    durationHours: 4,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    categorySlug: "music",
    orgId: DEMO_IDS.org3,
    actorHumanId: DEMO_IDS.human3,
    placeId: DEMO_IDS.place4,
    tickets: [
      {
        name: "Lower Bowl",
        priceCents: 8500,
        capacity: 72,
        layoutSectionId: "lower",
      },
      {
        name: "Upper Bowl",
        priceCents: 5000,
        capacity: 56,
        layoutSectionId: "upper",
      },
    ],
  });

  // ── Past events — explicitly for testing ────────────────────────────────
  // Every other fixture is in the *future* relative to when the seed runs
  // (see `buildStartDate(daysFromNow, ...)` in seed/utils.ts). That's
  // intentional — the web event listings and the scanner event picker
  // both hide past events, so a fresh seed produces a list operators
  // can actually act on. These two fixtures are the deliberate
  // counter-example: they let us exercise the past-event filter in the
  // scanner picker (which hides any event whose endAt is >12h ago) and
  // give the web a small "past events" backlog for the operator's event
  // history surface. Keep the count low — past events shouldn't dominate
  // the seed output.
  fixtures.push({
    slug: "ca-sf-past-recent-recap",
    title: "Mission Recap Night (Past)",
    addressText: "2275 Market St, San Francisco, CA 94114",
    regionCode: "ca-sf",
    daysFromNow: -3, // started 3 days before seed runs
    startHour: 20,
    durationHours: 3,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    categorySlug: "music",
    orgId: DEMO_IDS.org3,
    actorHumanId: DEMO_IDS.human3,
    // Linked to a (layout-less) venue so the my-tickets + review-event
    // surfaces show a real place name. This event also backs the
    // attendee-review "Rate this show" fixture (seedAttendeeReviewShow),
    // which issues a SCANNED ticket + order for the dev-login admin.
    placeId: DEMO_IDS.place11,
    tickets: [{ name: "General Admission", priceCents: 3500, capacity: 80 }],
  });

  fixtures.push({
    slug: "ca-sf-past-three-weeks-ago",
    title: "Sunset Park Open Mic (Past)",
    addressText: "1900 Lawton St, San Francisco, CA 94122",
    regionCode: "ca-sf",
    daysFromNow: -21, // ~3 weeks before seed runs
    startHour: 18,
    durationHours: 2,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    categorySlug: "music",
    orgId: DEMO_IDS.org3,
    actorHumanId: DEMO_IDS.human3,
    tickets: [{ name: "General Admission", priceCents: 0, capacity: 60 }],
  });

  return fixtures;
};

// ── Human-owned event fixtures ───────────────────────────────────────────

export const HUMAN_EVENT_FIXTURES: HumanEventFixture[] = [
  {
    slug: "personal-vinyl-night",
    title: "Dev's Vinyl Listening Night",
    addressText: "742 Valencia St, San Francisco, CA 94110",
    regionCode: "ca-sf",
    daysFromNow: 7,
    startHour: 20,
    durationHours: 3,
    status: "PUBLISHED",
    categorySlug: "music",
    tickets: [
      { name: "Guest Spot", priceCents: 1500, capacity: 20 },
      { name: "BYOB VIP", priceCents: 3500, capacity: 8 },
    ],
  },
  {
    slug: "personal-rooftop-bbq",
    title: "Rooftop BBQ Hangout",
    addressText: "1440 Broadway, Oakland, CA 94612",
    regionCode: "ca-oak",
    daysFromNow: 14,
    startHour: 16,
    durationHours: 5,
    status: "PUBLISHED",
    categorySlug: "food-drink",
    tickets: [
      { name: "General Admission", priceCents: 2500, capacity: 40 },
      { name: "Grill Master Pass", priceCents: 5000, capacity: 10 },
    ],
  },
  {
    slug: "personal-coding-meetup",
    title: "Weekend Coding Hangout",
    addressText: "50 Beale St, San Francisco, CA 94105",
    regionCode: "ca-sf",
    daysFromNow: 21,
    startHour: 10,
    durationHours: 4,
    status: "PUBLISHED",
    categorySlug: "community",
    tickets: [{ name: "Free Seat", priceCents: 0, capacity: 30 }],
  },
];

// ── Buyer fixtures ───────────────────────────────────────────────────────

export const BUYER_FIXTURES = [
  { name: "Olivia Thompson", email: "olivia.thompson@example.com" },
  { name: "Liam Nguyen", email: "liam.nguyen@example.com" },
  { name: "Sophia Patel", email: "sophia.patel@example.com" },
  { name: "Noah Garcia", email: "noah.garcia@example.com" },
  { name: "Emma Williams", email: "emma.williams@example.com" },
  { name: "Ethan Brown", email: "ethan.brown@example.com" },
  { name: "Ava Johnson", email: "ava.johnson@example.com" },
  { name: "Mason Lee", email: "mason.lee@example.com" },
] as const;

// ── Additional humans ────────────────────────────────────────────────────

export const ADDITIONAL_HUMANS: AdditionalHumanFixture[] = [
  {
    id: DEMO_IDS.human2,
    authUserId: "00000000-0000-4000-8000-00000000a002",
    email: "alex.rivera@example.com",
    name: "Alex Rivera",
    profileSlug: "alex-rivera",
    bio: "Event promoter and music enthusiast based in Austin",
  },
  {
    id: DEMO_IDS.human3,
    authUserId: "00000000-0000-4000-8000-00000000a003",
    email: "jamie.chen@example.com",
    name: "Jamie Chen",
    profileSlug: "jamie-chen",
    bio: "Festival curator and community organizer",
  },
  {
    id: DEMO_IDS.human4,
    authUserId: "00000000-0000-4000-8000-00000000a004",
    email: "sam.okonkwo@example.com",
    name: "Sam Okonkwo",
    profileSlug: "sam-okonkwo",
    bio: "Venue manager and live entertainment specialist",
  },
  {
    id: DEMO_IDS.human5,
    authUserId: "00000000-0000-4000-8000-00000000a005",
    email: "taylor.morgan@example.com",
    name: "Taylor Morgan",
    profileSlug: "taylor-morgan",
    bio: "Concert photographer and event coordinator",
  },
  {
    id: DEMO_IDS.human6,
    authUserId: "00000000-0000-4000-8000-00000000a006",
    email: "morgan.kowalski@example.com",
    name: "Morgan Kowalski",
    profileSlug: "morgan-kowalski",
    bio: "Chicago-based DIY booker and zine maker. Loose-knit collective of 6 venues across Logan Square + Pilsen.",
  },
  {
    id: DEMO_IDS.human7,
    authUserId: "00000000-0000-4000-8000-00000000a007",
    email: "diego.alvarez@example.com",
    name: "Diego Alvarez",
    profileSlug: "diego-alvarez",
    bio: "Cinema programmer and rooftop screening curator. Day job: archives. Night job: 16mm projection.",
  },
];

// ── Additional orgs ──────────────────────────────────────────────────────

export const ADDITIONAL_ORGS: AdditionalOrgFixture[] = [
  {
    id: DEMO_IDS.org2,
    name: "Austin Live Events",
    slug: "austin-live-events",
    ownerHumanId: DEMO_IDS.human2,
    memberHumanIds: [DEMO_IDS.human2, DEMO_IDS.human5],
    adminHumanIds: [DEMO_IDS.devUser], // Dev-login gets admin access
  },
  {
    id: DEMO_IDS.org3,
    name: "Bay Area Festivals",
    slug: "bay-area-festivals",
    ownerHumanId: DEMO_IDS.human3,
    memberHumanIds: [DEMO_IDS.human3, DEMO_IDS.human4],
    adminHumanIds: [DEMO_IDS.devUser], // Dev-login gets admin access
  },
  {
    id: DEMO_IDS.org4,
    name: "Chicago Underground Collective",
    slug: "chicago-underground",
    ownerHumanId: DEMO_IDS.human6,
    memberHumanIds: [DEMO_IDS.human6, DEMO_IDS.human7],
    adminHumanIds: [DEMO_IDS.devUser],
  },
];

// ── Place fixtures ───────────────────────────────────────────────────────

export const PLACES: PlaceFixture[] = [
  {
    id: DEMO_IDS.place1,
    name: "The Paramount Theatre",
    address: "713 Congress Ave",
    city: "Austin",
    region: "TX",
    country: "US",
    postcode: "78701",
    lat: 30.2687,
    lng: -97.7426,
    timezone: "America/Chicago",
    capacity: 1300,
    ownerOrgId: DEMO_IDS.org,
  },
  {
    id: DEMO_IDS.place2,
    name: "Stubb's BBQ",
    address: "801 Red River St",
    city: "Austin",
    region: "TX",
    country: "US",
    postcode: "78701",
    lat: 30.2694,
    lng: -97.7361,
    timezone: "America/Chicago",
    capacity: 2200,
    ownerOrgId: DEMO_IDS.org2,
  },
  {
    id: DEMO_IDS.place3,
    name: "The Fillmore",
    address: "1805 Geary Blvd",
    city: "San Francisco",
    region: "CA",
    country: "US",
    postcode: "94115",
    lat: 37.7842,
    lng: -122.4331,
    timezone: "America/Los_Angeles",
    capacity: 1150,
    ownerOrgId: DEMO_IDS.org3,
    unverified: true,
  },
  {
    id: DEMO_IDS.place4,
    name: "Greek Theatre",
    address: "2001 Gayley Rd",
    city: "Berkeley",
    region: "CA",
    country: "US",
    postcode: "94720",
    lat: 37.8738,
    lng: -122.2543,
    timezone: "America/Los_Angeles",
    capacity: 8500,
    ownerOrgId: DEMO_IDS.org3,
  },
  {
    id: DEMO_IDS.place5,
    name: "Red Rocks Amphitheatre",
    address: "18300 W Alameda Pkwy",
    city: "Morrison",
    region: "CO",
    country: "US",
    postcode: "80465",
    lat: 39.6654,
    lng: -105.2057,
    timezone: "America/Denver",
    capacity: 9525,
    ownerHumanId: DEMO_IDS.devUser,
  },
  {
    id: DEMO_IDS.place6,
    name: "SOMA Warehouse",
    address: "1015 Folsom St",
    city: "San Francisco",
    region: "CA",
    country: "US",
    postcode: "94103",
    lat: 37.7764,
    lng: -122.4047,
    timezone: "America/Los_Angeles",
    capacity: 600,
    ownerOrgId: DEMO_IDS.org3,
  },
  {
    id: DEMO_IDS.place7,
    name: "The Empty Bottle",
    address: "1035 N Western Ave",
    city: "Chicago",
    region: "IL",
    country: "US",
    postcode: "60622",
    lat: 41.8989,
    lng: -87.6873,
    timezone: "America/Chicago",
    capacity: 400,
    ownerOrgId: DEMO_IDS.org4,
  },
  {
    id: DEMO_IDS.place8,
    name: "Logan Square DIY",
    address: "2500 N Milwaukee Ave",
    city: "Chicago",
    region: "IL",
    country: "US",
    postcode: "60647",
    lat: 41.9275,
    lng: -87.7058,
    timezone: "America/Chicago",
    capacity: 180,
    ownerHumanId: DEMO_IDS.human6,
    // Also owned by org4 so the org-scoped Chicago seed events can save
    // here (saveEventForOrg requires the org to be in orgIdsWithAccess).
    ownerOrgId: DEMO_IDS.org4,
    unverified: true,
  },
  {
    id: DEMO_IDS.place9,
    name: "Brooklyn Steel",
    address: "319 Frost St",
    city: "Brooklyn",
    region: "NY",
    country: "US",
    postcode: "11222",
    lat: 40.7196,
    lng: -73.9322,
    timezone: "America/New_York",
    capacity: 1800,
    ownerOrgId: DEMO_IDS.org3,
  },
  {
    id: DEMO_IDS.place10,
    name: "Bowery Ballroom",
    address: "6 Delancey St",
    city: "New York",
    region: "NY",
    country: "US",
    postcode: "10002",
    lat: 40.7204,
    lng: -73.9938,
    timezone: "America/New_York",
    capacity: 575,
    ownerOrgId: DEMO_IDS.org3,
  },
  {
    // Layout-less Mission venue for the recent-past recap event that backs
    // the attendee-review ("Rate this show") flow. Owned by org3 so the
    // org-scoped past fixture can save here (saveEventForOrg requires the
    // org to have access to the place). No PlaceLayout → the event stays GA
    // and skips seat-section materialisation, while still surfacing a real
    // venue name in my-tickets.
    id: DEMO_IDS.place11,
    name: "The Chapel",
    address: "777 Valencia St",
    city: "San Francisco",
    region: "CA",
    country: "US",
    postcode: "94110",
    lat: 37.7599,
    lng: -122.4213,
    timezone: "America/Los_Angeles",
    capacity: 500,
    ownerOrgId: DEMO_IDS.org3,
  },
];
