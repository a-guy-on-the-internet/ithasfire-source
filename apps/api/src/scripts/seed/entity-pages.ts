import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";

/**
 * Seeds EntityPage records for every org, place, and (additional) human in
 * the demo dataset. Each page gets:
 *   - slug, displayName, bio
 *   - avatarUrl + bannerUrl (Unsplash links — same pool the events use)
 *   - a small `theme` (color tokens)
 *   - a few `PageBlock` rows (about, upcoming, links) so the consumer
 *     mobile app's entity-page renderer has real data to surface
 *
 * Idempotent: safe to re-run; uses upserts keyed on (ownerType, ownerId).
 *
 * Note: the existing identity.ts already creates EntityPage rows for the
 * dev-login user and the additional humans, but with bare displayName +
 * slug + bio. This module ENRICHES those (banner, theme, blocks) without
 * disturbing the dev user's profile slug or core identity.
 */

// ── Color presets per entity ─────────────────────────────────────────────

type ThemePreset = {
  colorPrimary: string;
  colorBg: string;
  colorText: string;
  fontKey: string;
  layoutKey: string;
};

// Valid layout keys are standard | stack | grid (theme-options.ts). Presets
// default to `standard` — the bespoke per-type layouts (PlaceEntityLayout /
// HumanEntityLayout / OrgEntityLayout) that real users get by default. Two
// deliberate holdouts stay on `grid` so the freeform block canvas path stays
// exercised by demo data: the SOMA Warehouse venue page and the Chicago
// Underground org page (overridden per-page at their seed sites below).
// Design System v2: Stub (warm cream, LIGHT) is the shipped default. These demo
// presets render ink-on-cream so every /p/[slug] standard page matches the app
// instead of leaking Ember-era dark chrome onto the cream shell. They stay
// visually distinct via ACCENT + PAPER + FONT, never via dark/light. Each accent
// is dark enough (luminance ≤ ~0.25) that a cream button label clears 3:1 on the
// fill (the standard-layout CTAs paint `color: var(--th-color-bg)` on the accent),
// and reads as ink-legible chrome on cream. Names are kept for churn-free diffs.
const THEMES: Record<string, ThemePreset> = {
  // Flagship burnt-orange — the canonical Stub accent (#E2481D → 3.52:1 cream label).
  warmDark: {
    colorPrimary: "#E2481D",
    colorBg: "#F6F0E4",
    colorText: "#211C16",
    fontKey: "montserrat",
    layoutKey: "standard",
  },
  // Steel-blue accent — kept cool on purpose so the demo set isn't orange-only
  // (DS: avoid one-note palettes). #35589A → ~5.5:1 cream label, ink-legible.
  swissAccent: {
    colorPrimary: "#35589A",
    colorBg: "#F6F0E4",
    colorText: "#211C16",
    fontKey: "montserrat",
    layoutKey: "standard",
  },
  // Deep amber/ochre on a slightly warmer paper — distinct from the redder
  // warmDark. #B45309 → ~4.6:1 cream label.
  warmAmber: {
    colorPrimary: "#B45309",
    colorBg: "#FDFAF3",
    colorText: "#211C16",
    fontKey: "montserrat",
    layoutKey: "standard",
  },
};

// The two freeform-canvas holdouts (see THEMES comment above). Everything else
// about their theme presets (colors/font) keeps rotating exactly as before —
// ONLY layoutKey is overridden.
const GRID_HOLDOUT_VENUE_SLUG = "soma-warehouse-san-francisco";

// ── Image pools ──────────────────────────────────────────────────────────

const ORG_BANNERS = [
  "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=1600&q=80",
  "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=1600&q=80",
  "https://images.unsplash.com/photo-1567942712661-82b9b407abbf?w=1600&q=80",
  "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=1600&q=80",
];

const PLACE_BANNERS = [
  "https://images.unsplash.com/photo-1519671482749-fd09be7ccebf?w=1600&q=80",
  "https://images.unsplash.com/photo-1571266028243-d220c6db21a8?w=1600&q=80",
  "https://images.unsplash.com/photo-1574391884720-bbc049ec09ad?w=1600&q=80",
  "https://images.unsplash.com/photo-1493676304819-0d7a8d026dcf?w=1600&q=80",
];

const HUMAN_BANNERS = [
  "https://images.unsplash.com/photo-1516280440614-37939bbacd81?w=1600&q=80",
  "https://images.unsplash.com/photo-1506157786151-b8491531f063?w=1600&q=80",
  "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1600&q=80",
];

const ORG_AVATARS = [
  "https://images.unsplash.com/photo-1535448033526-c0e85c094a7d?w=400&q=80",
  "https://images.unsplash.com/photo-1554941426-44de6cb6f3d8?w=400&q=80",
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=400&q=80",
  "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=400&q=80",
];

const PLACE_AVATARS = [
  "https://images.unsplash.com/photo-1574391884720-bbc049ec09ad?w=400&q=80",
  "https://images.unsplash.com/photo-1503095396549-807759245b35?w=400&q=80",
  "https://images.unsplash.com/photo-1519671482749-fd09be7ccebf?w=400&q=80",
  "https://images.unsplash.com/photo-1571266028243-d220c6db21a8?w=400&q=80",
];

// ── Page block builders ──────────────────────────────────────────────────

// One page block row. `data` is the JSON payload the public renderer + editor
// read; every builder below produces a shape that passes `normalizeBlockData`
// (packages/core/src/use-cases/entity-pages/block-config.ts) for its kind.
// `data.columnSpan` (1 | 2) drives the block's width in the responsive grid —
// mix full-width (2) and half-width (1) blocks so the layout looks intentional.
type ColumnSpan = 1 | 2;

type SeedBlock = {
  kind: string;
  orderIndex: number;
  data: Record<string, unknown>;
  // Defaults to `true`. Set `false` for opt-in blocks (e.g. musician `stats`,
  // which stays hidden on the public page until the owner reveals it).
  visible?: boolean;
};

// NOTE: the renderer reads `data.content` (NOT `data.text`) — see
// apps/web/src/app/p/[slug]/_components/blocks/AboutBlock.tsx. Seeding `text`
// left every About block blank on the public page; `content` is correct.
const aboutBlock = (
  content: string,
  order = 0,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "about",
  orderIndex: order,
  data: { content, columnSpan },
});

const linksBlock = (
  links: Array<{ label: string; url: string }>,
  order = 1,
  columnSpan: ColumnSpan = 1,
): SeedBlock => ({
  kind: "links",
  orderIndex: order,
  data: { links, columnSpan },
});

// `upcoming_events` auto-populates from the entity's real published events for
// PLACE pages (get-public-page.ts); ORG/HUMAN pages keep whatever static
// `events` are stored (none here), rendering the empty state + "browse events"
// CTA. We only set the column width.
const upcomingEventsBlock = (order = 2, columnSpan: ColumnSpan = 2): SeedBlock => ({
  kind: "upcoming_events",
  orderIndex: order,
  data: { columnSpan },
});

const photosBlock = (
  photos: Array<{ url: string; alt?: string; caption?: string }>,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "photos",
  orderIndex: order,
  data: { photos, columnSpan },
});

// ── Musician EPK builders ──────────────────────────────────────────────────

const genreTagsBlock = (
  tags: string[],
  order: number,
  columnSpan: ColumnSpan = 1,
): SeedBlock => ({
  kind: "genre_tags",
  orderIndex: order,
  data: { heading: "Genres", tags, columnSpan },
});

const musicBlock = (
  embeds: Array<{ provider: string; url: string }>,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "music",
  orderIndex: order,
  data: { heading: "Listen", embeds, columnSpan },
});

const tracksBlock = (
  tracks: Array<{ url: string; label?: string }>,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "tracks",
  orderIndex: order,
  data: { heading: "Featured tracks", tracks, columnSpan },
});

const videoBlock = (
  videos: Array<{ url: string; title?: string }>,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "video",
  orderIndex: order,
  data: { heading: "Watch", videos, columnSpan },
});

const pressBlock = (
  mentions: Array<{
    title: string;
    source: string;
    url?: string;
    date?: string;
    excerpt?: string;
  }>,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "press",
  orderIndex: order,
  data: { heading: "Press", mentions, columnSpan },
});

const riderBlock = (
  content: string,
  requirements: string[],
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "rider",
  orderIndex: order,
  data: { heading: "Technical rider", content, requirements, columnSpan },
});

const bookingInfoBlock = (
  info: {
    contactEmail?: string;
    contactPhone?: string;
    bookingUrl?: string;
    notes?: string;
  },
  order: number,
  columnSpan: ColumnSpan = 1,
): SeedBlock => ({
  kind: "booking_info",
  orderIndex: order,
  data: { heading: "Booking", ...info, columnSpan },
});

// Server-driven blocks (`shows`, `past_shows`, `stats`, `venue_stats`,
// `audience_stats`): get-public-page.ts rebuilds these from real lineup / stats
// / review-aggregate data and only renders them when it injects its trusted
// `dataSource` marker — seeded static content is ignored by design. We seed a
// heading + width so they exist in the template (nothing gets appended on
// editor load) and render the moment real data lands. `stats` seeds HIDDEN
// (opt-in, per page-templates.ts SEED_HIDDEN_KINDS); the venue aggregates
// (`venue_stats` / `audience_stats`) seed VISIBLE — they're server-gated by
// their own k-thresholds, so a visible-but-empty block simply renders nothing.
const serverBlock = (
  kind: "shows" | "past_shows" | "stats" | "venue_stats" | "audience_stats",
  heading: string,
  order: number,
  columnSpan: ColumnSpan,
  visible = true,
): SeedBlock => ({
  kind,
  orderIndex: order,
  data: { heading, columnSpan },
  visible,
});

// ── Venue builders ─────────────────────────────────────────────────────────

// `location_map` has its address/lat/lng server-injected from the Place entity
// (get-public-page.ts); we only seed heading + width.
const locationMapBlock = (order: number, columnSpan: ColumnSpan = 2): SeedBlock => ({
  kind: "location_map",
  orderIndex: order,
  data: { heading: "Find us", columnSpan },
});

const capacityInfoBlock = (
  info: { totalCapacity?: number; standing?: number; seated?: number; notes?: string },
  order: number,
  columnSpan: ColumnSpan = 1,
): SeedBlock => ({
  kind: "capacity_info",
  orderIndex: order,
  data: { heading: "Capacity", ...info, columnSpan },
});

const houseRulesBlock = (
  rules: string[],
  order: number,
  notes?: string,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "house_rules",
  orderIndex: order,
  data: { heading: "House rules", rules, ...(notes ? { notes } : {}), columnSpan },
});

const amenitiesBlock = (
  amenities: string[],
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "amenities",
  orderIndex: order,
  data: { heading: "Amenities", amenities, columnSpan },
});

// Venue tech-spec sheet (the venue-side rider): labeled spec rows an artist
// needs to advance a show. The list field is `specs` (see block-config.ts).
const techSpecsBlock = (
  specs: Array<{ label: string; value: string }>,
  order: number,
  notes?: string,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "tech_specs",
  orderIndex: order,
  data: { heading: "Tech specs", specs, ...(notes ? { notes } : {}), columnSpan },
});

const requestToPlayBlock = (
  intro: string,
  order: number,
  columnSpan: ColumnSpan = 1,
): SeedBlock => ({
  kind: "request_to_play",
  orderIndex: order,
  data: { heading: "Request to play", intro, columnSpan },
});

// ── Org builders ───────────────────────────────────────────────────────────

const missionBlock = (
  content: string,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "mission",
  orderIndex: order,
  data: { heading: "Our mission", content, columnSpan },
});

const teamBlock = (
  members: Array<{ name: string; role?: string; avatarUrl?: string }>,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind: "team",
  orderIndex: order,
  data: { heading: "The team", members, columnSpan },
});

// `managed_places` + `past_events` are org stub blocks (backend integration
// pending) — they render a heading + "coming soon" placeholder. Seeded so the
// org template is complete and nothing is appended on editor load.
const orgStubBlock = (
  kind: "managed_places" | "past_events",
  heading: string,
  order: number,
  columnSpan: ColumnSpan = 2,
): SeedBlock => ({
  kind,
  orderIndex: order,
  data: { heading, columnSpan },
});

// ── Public API ───────────────────────────────────────────────────────────

type SeedablePage = {
  ownerType: "ORGANIZATION" | "PLACE" | "HUMAN";
  ownerId: string;
  slug: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  bannerUrl: string;
  theme: ThemePreset;
  blocks: SeedBlock[];
};

const upsertEntityPage = async (prisma: PrismaClient, page: SeedablePage) => {
  const existing = await prisma.entityPage.findUnique({
    where: {
      ownerType_ownerId: { ownerType: page.ownerType, ownerId: page.ownerId },
    },
  });

  const upserted = await prisma.entityPage.upsert({
    where: {
      ownerType_ownerId: { ownerType: page.ownerType, ownerId: page.ownerId },
    },
    update: {
      // Don't clobber a slug that may have been customized (e.g. by the
      // identity seed for the dev-login user).
      displayName: page.displayName,
      bio: page.bio,
      avatarUrl: page.avatarUrl,
      bannerUrl: page.bannerUrl,
      visibility: "PUBLIC",
    },
    create: {
      ownerType: page.ownerType,
      ownerId: page.ownerId,
      slug: page.slug,
      displayName: page.displayName,
      bio: page.bio,
      avatarUrl: page.avatarUrl,
      bannerUrl: page.bannerUrl,
      visibility: "PUBLIC",
    },
  });

  // Theme — upsert by pageId.
  await prisma.pageTheme.upsert({
    where: { pageId: upserted.id },
    update: page.theme,
    create: { pageId: upserted.id, ...page.theme },
  });

  // Blocks — wipe + recreate for determinism. Cheap, page block sets are tiny.
  if (existing) {
    await prisma.pageBlock.deleteMany({ where: { pageId: upserted.id } });
  }
  for (const block of page.blocks) {
    await prisma.pageBlock.create({
      data: {
        pageId: upserted.id,
        kind: block.kind,
        orderIndex: block.orderIndex,
        data: block.data as never,
        visible: block.visible ?? true,
      },
    });
  }

  return upserted;
};

// ── Specific seeders ─────────────────────────────────────────────────────

// ── Org content ──────────────────────────────────────────────────────────

// Per-org tailored content for the fleshed-out org page. Keyed by ownerId (the
// demo org UUIDs). `buildOrgBlocks` consumes this so every demo org gets the
// same block set with realistic, distinct copy — a SUPERSET of the slimmed
// ORGANIZATION:generic registry template (about, links, upcoming_events).
type OrgContent = {
  about: string;
  mission: string;
  team: Array<{ name: string; role?: string }>;
  links: Array<{ label: string; url: string }>;
};

const ORG_CONTENT: Record<string, OrgContent> = {
  [DEMO_IDS.org]: {
    about:
      "We host a rotating slate of demo events that exercise every flow in the platform — public, password-gated, application-only, free, paid, refunded, and POS at the door.",
    mission:
      "Give the rest of the platform something real to render. Every state a live org can be in — a sold-out paid show, a free RSVP night, a refunded order, a door sale — exists here on purpose, so no surface ships untested against an empty database.",
    team: [
      { name: "Ithas Fire Team", role: "Platform demo stewards" },
      { name: "QA Bot", role: "Fixture generation" },
    ],
    links: [
      { label: "Website", url: "https://ithasfire.com" },
      { label: "Instagram", url: "https://instagram.com/ithasfire" },
    ],
  },
  [DEMO_IDS.org2]: {
    about:
      "Independent promoter focused on touring acts that need a 200–600 cap room and a fair door split. Our roster overlaps heavily with the Austin DIY scene; if you've played a basement show in town we probably know your booker.",
    mission:
      "Keep independent live music affordable and the people who make it paid. Every show posts its door split publicly, openers always get a guarantee, and we cap our fee so more of the ticket goes to the artist. No pay-to-play, ever.",
    team: [
      { name: "Alex Rivera", role: "Founder & talent buyer" },
      { name: "Taylor Morgan", role: "Production & front of house" },
      { name: "Priya Nair", role: "Marketing & box office" },
    ],
    links: [
      { label: "Bookings", url: "https://austinliveevents.example/booking" },
      { label: "Instagram", url: "https://instagram.com/austinliveevents" },
      { label: "Bandcamp", url: "https://austinliveevents.bandcamp.com" },
    ],
  },
  [DEMO_IDS.org3]: {
    about:
      "Our slate runs from intimate Greek Theatre nights to two-day SOMA warehouse takeovers. We work with venues that respect their staff and acts that respect their crowd. Sliding-scale tickets on every show.",
    mission:
      "Build festivals that work for the whole room — fair pay for the acts, living wages for the crew, sliding-scale doors for the crowd. We'd rather program one honest weekend than three that only pencil out by squeezing somebody.",
    team: [
      { name: "Jordan Lee", role: "Festival director & talent buyer" },
      { name: "Sam Okafor", role: "Site + production lead" },
      { name: "Maya Delgado", role: "Community & volunteers" },
    ],
    links: [
      { label: "Newsletter", url: "https://example.com/bay-area-festivals" },
      {
        label: "Volunteer",
        url: "https://example.com/bay-area-festivals/volunteer",
      },
    ],
  },
  [DEMO_IDS.org4]: {
    about:
      "Cooperatively-run booking outfit covering punk, indie, jazz, and noise across Chicago's west and northwest sides. Founded 2018. All venues independent. Door splits posted publicly.",
    mission:
      "No booker gets rich off this scene, and neither should we. We run at cost, split the door evenly, and put accessibility and consent on every show. If a room won't pay its openers or won't do all-ages, we don't book it.",
    team: [
      { name: "Devon Marsh", role: "Booking collective (rotating)" },
      { name: "Río Castillo", role: "Accessibility & safer-spaces" },
      { name: "Frankie Nwosu", role: "Sound + backline share" },
    ],
    links: [
      { label: "Zine archive", url: "https://example.com/chicago-underground/zine" },
      { label: "Show listings", url: "https://example.com/chicago-underground" },
    ],
  },
};

/**
 * Fleshed-out org page block set. This is a deliberate SUPERSET of the slimmed
 * ORGANIZATION:generic registry template (about, links, upcoming_events) — it
 * additionally seeds team, mission, and the two org stubs. Because it contains
 * every kind the registry template lists, the append-on-load invariant still
 * holds (nothing is appended on editor load). Leads with the registry order
 * (about, links) then layers the org-specific blocks; `upcoming_events` sits at
 * the end and auto-populates from the org's real published events
 * (get-public-page.ts). `managed_places` / `past_events` are backend-pending
 * org stubs (heading only).
 */
const buildOrgBlocks = (content: OrgContent): SeedBlock[] => [
  aboutBlock(content.about, 0),
  linksBlock(content.links, 1),
  teamBlock(content.team, 2),
  missionBlock(content.mission, 3),
  orgStubBlock("managed_places", "Rooms we book", 4),
  orgStubBlock("past_events", "Recent shows", 5),
  upcomingEventsBlock(6),
];

export const seedOrgEntityPages = async (prisma: PrismaClient) => {
  // Metadata (slug / displayName / bio / visuals) per demo org; block content
  // comes from ORG_CONTENT via buildOrgBlocks so every org gets the full,
  // canonically-ordered ORGANIZATION:generic template. Theme + avatar + banner
  // rotation is intentionally left varied.
  const orgMeta: Array<Omit<SeedablePage, "blocks">> = [
    {
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org,
      slug: "demo",
      displayName: "Ithas Fire Demo Org",
      bio: "The flagship demo organization — running test events across San Francisco, New York, and Austin so the rest of the platform has something to render.",
      avatarUrl: ORG_AVATARS[0]!,
      bannerUrl: ORG_BANNERS[0]!,
      theme: THEMES.warmDark!,
    },
    {
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org2,
      slug: "austin-live-events",
      displayName: "Austin Live Events",
      bio: "Booking shows on Red River, South Congress, and the East Side since '09. We pay our openers and we mean it.",
      avatarUrl: ORG_AVATARS[1]!,
      bannerUrl: ORG_BANNERS[1]!,
      theme: THEMES.warmAmber!,
    },
    {
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org3,
      slug: "bay-area-festivals",
      displayName: "Bay Area Festivals",
      bio: "Curating festivals, warehouse parties, and theater nights across San Francisco, Oakland, and Berkeley.",
      avatarUrl: ORG_AVATARS[2]!,
      bannerUrl: ORG_BANNERS[2]!,
      theme: THEMES.swissAccent!,
    },
    {
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org4,
      slug: "chicago-underground",
      displayName: "Chicago Underground Collective",
      bio: "DIY booking collective — Logan Square, Pilsen, West Loop. Six rooms, no pay-to-play, sliding-scale tickets, accessibility on every show.",
      avatarUrl: ORG_AVATARS[3]!,
      bannerUrl: ORG_BANNERS[3]!,
      // Deliberate grid holdout: keeps the org freeform block canvas exercised
      // by demo data (see THEMES comment). Colors/font stay the warmDark preset.
      theme: { ...THEMES.warmDark!, layoutKey: "grid" },
    },
  ];

  for (const meta of orgMeta) {
    const content = ORG_CONTENT[meta.ownerId];
    // Fallback: an org without tailored content still seeds the full template,
    // reusing its bio as the about copy.
    const blocks = content
      ? buildOrgBlocks(content)
      : buildOrgBlocks({
          about: meta.bio,
          mission: meta.bio,
          team: [],
          links: [],
        });
    await upsertEntityPage(prisma, { ...meta, blocks });
  }
  return orgMeta.length;
};

// Photo pool for venue galleries (interior / crowd / stage / exterior). Each
// venue draws its per-photo alt/caption from VENUE_CONTENT and maps them onto
// this shared pool by index.
const VENUE_PHOTOS = [
  "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1200&q=80",
  "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1200&q=80",
  "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?w=1200&q=80",
  "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=1200&q=80",
];

// ── Venue bios (about copy) ────────────────────────────────────────────────

// Keyed by derived slug (`slugify(name-city)`). Feeds both the EntityPage.bio
// column and the venue `about` block. A slug not present here falls back to a
// DB-derived one-liner.
const VENUE_BIOS: Record<string, string> = {
  "the-paramount-theatre-austin":
    "Restored 1915 vaudeville theater on Congress Ave. 1,300 seats across orchestra, mezzanine, and balcony. Best sightlines in Austin.",
  "stubb-s-bbq-austin":
    "Two-stage BBQ joint on Red River since 1996. Indoor stage runs 250 cap; the back amphitheater holds 2,200. The brisket is incidental — the room sounds great.",
  "the-fillmore-san-francisco":
    "Geary Blvd institution since 1912. The chandeliers, the apples by the door, and the velvet curtain are all real. Capacity 1,150, mostly standing.",
  "greek-theatre-berkeley":
    "Open-air amphitheater carved into the Berkeley hills. 8,500 cap. Acoustically perfect when the fog stays away.",
  "red-rocks-amphitheatre-morrison":
    "9,525-seat natural amphitheater west of Denver. Two 300-foot sandstone walls do the acoustic work. Bring a jacket; it gets cold at altitude.",
  "soma-warehouse-san-francisco":
    "Bare-bones 600-cap warehouse on Folsom. Concrete floor, 18-foot ceilings, single bar in the back. Ideal for techno + bass-heavy bookings.",
  "the-empty-bottle-chicago":
    "Indie rock institution in Ukrainian Village since 1992. 400-cap, photo booth in back, free Monday shows. The room everyone in town has played at least once.",
  "logan-square-diy-chicago":
    "Co-operatively run loft space in Logan Square. 180 cap, all-ages, sliding scale tickets ($5–$20), no alcohol — bring your own. Booked through the collective directly.",
  "bowery-ballroom-new-york":
    "Lower East Side institution since 1998. 575-cap main room over a legendary downstairs bar. The stage every touring band wants to graduate to.",
  "brooklyn-steel-brooklyn":
    "1,800-cap warehouse-turned-venue in East Williamsburg. High ceilings, a deep floor, and a rig to match — Brooklyn's big-room step up from the clubs.",
};

// ── Venue content ──────────────────────────────────────────────────────────

// Per-venue tailored content for the full PLACE:venue template. `totalCapacity`
// is taken from the real Place.capacity at build time; this map supplies the
// standing/seated split + notes and the rest of the venue-specific copy. Photos
// carry per-image alt/caption mapped onto the shared VENUE_PHOTOS pool.
type VenueContent = {
  /** Standing/seated split (sums to the real capacity). */
  standing: number;
  seated: number;
  capacityNotes: string;
  booking: { contactEmail?: string; bookingUrl?: string; notes: string };
  houseRules: string[];
  loadInNote?: string;
  amenities: string[];
  /**
   * Venue tech-spec sheet rows (the venue-side rider). Optional — venues
   * without a tailored sheet fall back to FALLBACK_TECH_SPECS in
   * buildVenueBlocks so every seeded venue still matches the full template.
   */
  techSpecs?: Array<{ label: string; value: string }>;
  techSpecsNotes?: string;
  /** Per-photo alt/caption; mapped onto VENUE_PHOTOS by index. */
  photos: Array<{ alt: string; caption: string }>;
  requestIntro: string;
};

const VENUE_CONTENT: Record<string, VenueContent> = {
  "the-paramount-theatre-austin": {
    standing: 0,
    seated: 1300,
    capacityNotes:
      "Fully seated across orchestra, mezzanine, and balcony — no standing room. The balcony is steep with great sightlines and tight legroom. Assigned seating on every show.",
    booking: {
      contactEmail: "booking@paramountaustin.example",
      bookingUrl: "https://paramountaustin.example/booking",
      notes:
        "Seated concerts, film, and comedy. We program 10–12 weeks out and share settlement terms up front. House crew and hospitality included; local support is paid.",
    },
    houseRules: [
      "No standing on seats or in the aisles — fire code.",
      "No outside food or drink; full bar in the lobby.",
      "No flash photography during performances.",
      "Latecomers are seated at a suitable break in the program.",
    ],
    loadInNote: "Load-in is off the alley behind Congress; freight elevator to stage level.",
    amenities: [
      "Two lobby bars",
      "Star dressing rooms + green room",
      "House PA + LD + monitor engineer",
      "Grand piano available on request",
      "Wheelchair-accessible seating + elevator",
      "Nearby garages on Brazos",
    ],
    photos: [
      { alt: "The Paramount Theatre auditorium", caption: "Orchestra and mezzanine from the stage" },
      { alt: "The Paramount Theatre stage", caption: "House proscenium + rigging" },
      { alt: "The Paramount Theatre lobby", caption: "The historic lobby bar" },
    ],
    requestIntro:
      "We book seated concerts, film series, and comedy. Send your pitch with routing and a rough draw — we read every one and we pay support.",
  },
  "stubb-s-bbq-austin": {
    standing: 2200,
    seated: 0,
    capacityNotes:
      "Two rooms: the indoor stage runs ~250 standing, the back amphitheater holds 2,200 general admission. Outdoor is rain-or-shine — no cover over the crowd.",
    booking: {
      contactEmail: "booking@stubbsaustin.example",
      bookingUrl: "https://stubbsaustin.example/booking",
      notes:
        "Indoor and outdoor stages, often the same night. Book 8–12 weeks out. Amphitheater curfew is a firm 11pm (residential). Local openers paid, full stop.",
    },
    houseRules: [
      "All ages outside; the indoor room is 21+ after 9pm.",
      "No re-entry to the amphitheater.",
      "No outside food or drink — it's a BBQ joint.",
      "No pro cameras or audio rigs without a pass.",
    ],
    loadInNote: "Amphitheater load-in is off Red River; a small ramp serves the indoor stage.",
    amenities: [
      "Full bar + BBQ kitchen",
      "Green room + artist catering",
      "House PA + engineer on both stages",
      "Merch tables provided",
      "ADA viewing platform outdoors",
      "Street + lot parking on Red River",
    ],
    photos: [
      { alt: "Stubb's amphitheater at night", caption: "The back amphitheater, sold out" },
      { alt: "Stubb's indoor stage", caption: "The 250-cap indoor room" },
      { alt: "Stubb's BBQ kitchen", caption: "The kitchen that shares the address" },
    ],
    requestIntro:
      "Two stages, one address. Tell us which room fits and send routing — we pay every act on the bill.",
  },
  "the-fillmore-san-francisco": {
    standing: 950,
    seated: 200,
    capacityNotes:
      "General-admission floor holds ~950 standing; the horseshoe balcony adds seated rows. Chandeliers stay lit low, and there's an apple bowl on the way out — house tradition.",
    booking: {
      contactEmail: "booking@thefillmore.example",
      bookingUrl: "https://thefillmore.example/booking",
      notes:
        "Historic 1,150-cap room — standing floor, seated balcony. We book 8–10 weeks out. Local support is paid.",
    },
    houseRules: [
      "All ages with a guardian; 21+ bars require ID.",
      "No re-entry once you're on the floor.",
      "No pro cameras or recording without a pass.",
      "Take a poster on your way out — one per person.",
    ],
    loadInNote: "Load-in is off the Geary side; freight to stage right.",
    amenities: [
      "Two floor bars + a balcony bar",
      "Green room + poster archive",
      "House PA + monitor engineer",
      "Coat check",
      "Balcony seating (ADA on request)",
      "Paid lot across Geary",
    ],
    photos: [
      { alt: "The Fillmore main floor", caption: "The floor under the chandeliers" },
      { alt: "The Fillmore stage", caption: "Stage + velvet backdrop" },
      { alt: "The Fillmore poster wall", caption: "The poster room upstairs" },
    ],
    requestIntro:
      "The room everyone plays once. Send music and routing — we read it all and we pay support.",
  },
  "greek-theatre-berkeley": {
    standing: 1500,
    seated: 7000,
    capacityNotes:
      "Open-air bowl: fixed bench seating up the hill plus a GA pit down front. Fog rolls in after dark — tell your crew to layer. Curfew is firm (campus-adjacent).",
    booking: {
      contactEmail: "booking@greekberkeley.example",
      bookingUrl: "https://greekberkeley.example/booking",
      notes:
        "8,500-cap open-air amphitheater, spring through fall only. Book 12+ weeks out. Hard 10pm curfew; local support is paid.",
    },
    houseRules: [
      "All ages; the GA pit is standing, benches are first-come.",
      "No re-entry.",
      "No outside food, drink, or umbrellas.",
      "No pro cameras without a pass.",
    ],
    loadInNote: "Load-in is up the fire road behind the stage; the grade is steep — bring a spotter.",
    amenities: [
      "Concession bars throughout",
      "Backstage compound + trailers",
      "Full concert PA + line array",
      "ADA seating platform",
      "Weather cover for gear only",
      "Shuttle + uphill lot parking",
    ],
    photos: [
      { alt: "Greek Theatre bowl at dusk", caption: "The bowl before doors" },
      { alt: "Greek Theatre stage", caption: "Stage against the Berkeley hills" },
      { alt: "Greek Theatre crowd", caption: "GA pit down front" },
    ],
    requestIntro:
      "Open-air, spring to fall. Send routing early — dates go fast and we pay support.",
  },
  "red-rocks-amphitheatre-morrison": {
    standing: 0,
    seated: 9525,
    capacityNotes:
      "9,525 fixed bench seats between two 300-foot sandstone monoliths. You're at 6,450 feet — the walk up from the lot is real and it gets cold after sunset. Weather calls are the promoter's.",
    booking: {
      contactEmail: "booking@redrocksco.example",
      bookingUrl: "https://redrocksco.example/booking",
      notes:
        "Bench-seated natural amphitheater, April–October. Book 16+ weeks out — the calendar fills a year ahead. Altitude and weather clauses in every contract; local support is paid.",
    },
    houseRules: [
      "All ages; every ticket is an assigned bench spot.",
      "No re-entry.",
      "No umbrellas — they block sightlines.",
      "No pro cameras without a pass.",
      "Layers strongly advised — nights drop fast at altitude.",
    ],
    loadInNote:
      "Load-in is via the upper south lot and the stage ramp; altitude slows everyone — pad your call times.",
    amenities: [
      "Concessions on both plazas",
      "Backstage green rooms carved into the rock",
      "Full touring PA + house rigging",
      "ADA seating + cart shuttle",
      "Visitor center + trading post",
      "Tiered lot parking (long walk down)",
    ],
    photos: [
      { alt: "Red Rocks Amphitheatre seats", caption: "Bench rows between the monoliths" },
      { alt: "Red Rocks stage at sunset", caption: "Stage against Ship Rock" },
      { alt: "Red Rocks from above", caption: "The bowl from the upper lot" },
    ],
    requestIntro:
      "Bucket-list room, April to October. Send routing a season ahead — we pay support.",
  },
  "soma-warehouse-san-francisco": {
    standing: 600,
    seated: 0,
    capacityNotes:
      "One open concrete floor, 18-foot ceilings, a single bar in back. No seating, no frills — built for a sound system and a dark room. 21+ only.",
    booking: {
      contactEmail: "bookings@somawarehouse.example",
      bookingUrl: "https://somawarehouse.example/booking",
      notes:
        "600-cap bare warehouse, techno and bass first. We book 6–8 weeks out and run late — 2am license. Bring your own visuals; local support is paid.",
    },
    houseRules: [
      "21+ only, ID at the door.",
      "No re-entry after 1am.",
      "No phones on the floor during headline sets — respect the room.",
      "No pro cameras without a pass.",
    ],
    loadInNote: "Roll-up door on Folsom, straight to the floor — no stairs, no elevator needed.",
    amenities: [
      "Single back bar",
      "Green room + production office",
      "Big DJ-booth rig + sub stacks",
      "Fog + strobe (bring your own LD)",
      "Earplugs at the bar",
      "Street parking only",
    ],
    photos: [
      { alt: "SOMA warehouse floor", caption: "The floor before doors" },
      { alt: "SOMA warehouse DJ booth", caption: "Booth + sub stacks" },
      { alt: "SOMA warehouse crowd", caption: "Late set, lights down" },
    ],
    requestIntro:
      "Warehouse, sound-system first. Send a mix and routing — we pay support.",
  },
  "the-empty-bottle-chicago": {
    standing: 400,
    seated: 0,
    capacityNotes:
      "General admission, standing room only. The floor slopes gently toward the stage; sightlines are good from anywhere but the bar. All-ages until 9pm, 21+ after.",
    booking: {
      contactEmail: "booking@emptybottle.example",
      bookingUrl: "https://emptybottle.example/booking",
      notes:
        "Touring acts: send links, routing, and draw history. We book 8–10 weeks out. Local support is paid — no exposure bucks.",
    },
    houseRules: [
      "21+ after 9pm; valid ID required at the door.",
      "No re-entry once you leave the room.",
      "No professional cameras or audio rigs without a photo pass.",
      "Respect the crowd and the crew — zero tolerance for harassment.",
    ],
    loadInNote: "Load-in is off the alley on Cortland. Green room is up the back stairs.",
    amenities: [
      "Full bar",
      "Green room",
      "In-house PA + sound engineer",
      "Photo booth",
      "Backline available on request",
      "Street parking + nearby lot",
    ],
    photos: [
      { alt: "The Empty Bottle main room", caption: "The main room on a sold-out night" },
      { alt: "The Empty Bottle stage", caption: "Stage + in-house PA" },
      { alt: "The Empty Bottle bar", caption: "The bar in back" },
    ],
    requestIntro:
      "Want to play here? Send us your music, your routing dates, and a rough idea of your local draw. We read everything and we pay every act on the bill.",
  },
  "logan-square-diy-chicago": {
    standing: 180,
    seated: 0,
    capacityNotes:
      "One loft room, 180 all-ages, folding chairs along the walls. BYO — no bar, no liquor license. Sliding-scale door, nobody turned away for lack of funds.",
    booking: {
      contactEmail: "booking@logansquarediy.example",
      bookingUrl: "https://logansquarediy.example/booking",
      notes:
        "All-ages co-op loft, booked through the collective. We schedule 4–6 weeks out. Door is sliding scale ($5–$20) split evenly with the acts — no guarantees, no pay-to-play, ever.",
    },
    houseRules: [
      "All ages, always.",
      "BYO — no alcohol sold on site.",
      "Keep the volume down after 10pm (residential neighbors).",
      "Consent and access first — harassment gets you removed.",
    ],
    loadInNote: "Load-in is up the freight stairs off the alley; bring hands, no elevator.",
    amenities: [
      "BYO — water + snacks provided",
      "Shared green corner (curtained)",
      "Modest vocal PA + backline share",
      "Sliding-scale door",
      "Zine + merch table",
      "Bike parking; street only for cars",
    ],
    photos: [
      { alt: "Logan Square DIY loft", caption: "The loft set up for a show" },
      { alt: "Logan Square DIY crowd", caption: "All-ages, floor seating" },
      { alt: "Logan Square DIY merch table", caption: "Zine + merch corner" },
    ],
    requestIntro:
      "All-ages, sliding scale, booked by the collective. Send us your music — everyone on the bill splits the door.",
  },
  "bowery-ballroom-new-york": {
    standing: 500,
    seated: 75,
    capacityNotes:
      "Standing main floor with a wraparound balcony (a few seated rows up top). The downstairs bar runs all night. 16+ to the room, 21+ to drink.",
    booking: {
      contactEmail: "booking@boweryballroom.example",
      bookingUrl: "https://boweryballroom.example/booking",
      notes:
        "575-cap — standing floor plus balcony. We book 8–10 weeks out. Sharp 11pm curfew on weeknights; local support is paid.",
    },
    houseRules: [
      "16+ to enter, 21+ to drink — ID at both bars.",
      "No re-entry.",
      "No pro cameras or recording without a pass.",
      "Coat check downstairs in winter — use it.",
    ],
    loadInNote: "Load-in is off Delancey to the stage-left door; tight — no oversized trucks.",
    amenities: [
      "Upstairs + legendary downstairs bar",
      "Green room + band hospitality",
      "House PA + monitor engineer",
      "Coat check",
      "Balcony seating (ADA on request)",
      "No lot — cabs and the F/J/M/Z",
    ],
    photos: [
      { alt: "Bowery Ballroom main floor", caption: "The floor and balcony" },
      { alt: "Bowery Ballroom stage", caption: "Stage from the balcony rail" },
      { alt: "Bowery Ballroom downstairs bar", caption: "The downstairs bar" },
    ],
    requestIntro:
      "The room bands graduate to. Send music and routing — we read it all and we pay support.",
  },
  "brooklyn-steel-brooklyn": {
    standing: 1600,
    seated: 200,
    capacityNotes:
      "Cavernous standing floor with an elevated mezzanine (limited seated rows). Industrial and loud by design. All ages; 21+ for the bars.",
    booking: {
      contactEmail: "booking@brooklynsteel.example",
      bookingUrl: "https://brooklynsteel.example/booking",
      notes:
        "1,800-cap big room — standing floor plus mezzanine. Book 10–12 weeks out. Full production house; local support is paid.",
    },
    houseRules: [
      "All ages; 21+ bars with ID.",
      "No re-entry.",
      "No pro cameras or audio rigs without a pass.",
      "Mezzanine is first-come once the floor fills.",
    ],
    loadInNote: "Load-in is off Frost St to the dock — full truck access, straight to the stage.",
    techSpecs: [
      { label: "PA", value: "d&b audiotechnik line array flown L/R + flown subs, tuned for the 1,800-cap room" },
      { label: "FOH console", value: "DiGiCo SD10 at front of house" },
      { label: "Monitors", value: "Avid Profile at MON; 10 mixes — wedges, side fills, drum sub; IEM racks on advance" },
      { label: "Mics & DI", value: "Full touring package — Shure/Sennheiser vocal + drum mics, active DIs" },
      { label: "Stage", value: "40 ft × 24 ft, 4 ft trim; 8 ft × 8 ft rolling upstage riser" },
      { label: "Power", value: "200A three-phase company switch, stage left" },
      { label: "Backline", value: "None in-house — local rental arranged on advance" },
      { label: "House engineer", value: "FOH + monitor engineers on every show" },
    ],
    techSpecsNotes: "Full tech pack and stage plot go out with the advance — ask production.",
    amenities: [
      "Four bars across two levels",
      "Green rooms + production offices",
      "Full concert PA + line array + LD",
      "Merch hall",
      "Mezzanine + ADA platform",
      "Street parking; L train to Graham",
    ],
    photos: [
      { alt: "Brooklyn Steel floor", caption: "The deep standing floor" },
      { alt: "Brooklyn Steel stage", caption: "Stage under the rig" },
      { alt: "Brooklyn Steel mezzanine", caption: "The mezzanine overlook" },
    ],
    requestIntro:
      "The big Brooklyn room. Send routing and a draw history — we pay support.",
  },
};

/**
 * Generic-but-plausible tech-spec sheet for venues without a tailored
 * VenueContent.techSpecs entry — same posture as the fallback amenities/house
 * rules: keeps every seeded venue on the FULL template (nothing appended on
 * editor load) with content a small club could realistically publish.
 */
const FALLBACK_TECH_SPECS: Array<{ label: string; value: string }> = [
  { label: "PA", value: "In-house system, sized to the room" },
  { label: "Console", value: "Digital board at FOH" },
  { label: "Monitors", value: "4 wedge mixes run from FOH" },
  { label: "Mics & DI", value: "Standard club package — vocal mics, drum mics, DIs" },
  { label: "Backline", value: "None house-provided — bring your own or advance a rental" },
  { label: "House engineer", value: "Provided on every show" },
];

/**
 * Full PLACE:venue template block set. Matches the ordered kinds in
 * page-templates.ts (about, location_map, capacity_info, house_rules,
 * amenities, tech_specs, photos, venue_stats, audience_stats,
 * request_to_play, booking_info) so nothing is appended on editor load.
 *
 * Server-driven blocks: `location_map` address is injected from the Place
 * entity; `venue_stats` (performer-review aggregates) and `audience_stats`
 * (attendee-review aggregates) are rebuilt server-side from their weekly
 * snapshots (get-public-page.ts) and seeded as visible heading placeholders —
 * they render the moment their k-thresholds are met.
 */
const buildVenueBlocks = (args: {
  slug: string;
  bio: string;
  totalCapacity: number | null;
  content: VenueContent;
}): SeedBlock[] => {
  const { slug, bio, totalCapacity, content } = args;
  // Reconciliation guard: `totalCapacity` comes from the DB (Place.capacity)
  // while `standing`/`seated` are hardcoded in VENUE_CONTENT — two independent
  // sources. Editing a capacity in fixtures.ts without updating VENUE_CONTENT
  // would silently render an inconsistent CapacityInfo block; fail loudly at
  // seed time instead. (The fallback path always reconciles by construction, so
  // it's exempt — its content is derived from totalCapacity directly.)
  if (
    totalCapacity != null &&
    content.standing + content.seated !== totalCapacity
  ) {
    throw new Error(
      `Capacity mismatch for ${slug}: standing(${content.standing})+seated(${content.seated}) !== place.capacity(${totalCapacity})`,
    );
  }
  return [
    aboutBlock(bio, 0),
    locationMapBlock(1),
    capacityInfoBlock(
      {
        ...(totalCapacity != null ? { totalCapacity } : {}),
        standing: content.standing,
        seated: content.seated,
        notes: content.capacityNotes,
      },
      2,
    ),
    houseRulesBlock(content.houseRules, 3, content.loadInNote),
    amenitiesBlock(content.amenities, 4),
    techSpecsBlock(
      content.techSpecs ?? FALLBACK_TECH_SPECS,
      5,
      content.techSpecsNotes,
    ),
    photosBlock(
      content.photos.map((photo, idx) => ({
        url: VENUE_PHOTOS[idx % VENUE_PHOTOS.length]!,
        alt: photo.alt,
        caption: photo.caption,
      })),
      6,
    ),
    serverBlock("venue_stats", "What performers report", 7, 2),
    serverBlock("audience_stats", "What attendees report", 8, 2),
    requestToPlayBlock(content.requestIntro, 9),
    bookingInfoBlock(content.booking, 10),
  ];
};

/**
 * Graceful fallback content for a venue with no tailored VENUE_CONTENT entry —
 * still seeds the FULL PLACE:venue template so a future fixture is never left on
 * a lean stub. Everything is DB-derived + generic-but-plausible.
 */
const deriveFallbackVenueContent = (place: {
  name: string;
  capacity: number | null;
}): VenueContent => {
  const cap = place.capacity ?? 0;
  const slugSafe = place.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
  return {
    // No known split — treat capacity as standing-room GA by default.
    standing: cap,
    seated: 0,
    capacityNotes:
      "General admission. Standing/seated split varies by show — check the event page for the configuration.",
    booking: {
      contactEmail: `booking@${slugSafe || "venue"}.example`,
      notes:
        "Send music, routing, and a rough idea of your local draw. We book a few weeks out and pay local support.",
    },
    houseRules: [
      "Valid ID required for the bars.",
      "No re-entry once you leave the room.",
      "No pro cameras or audio rigs without a pass.",
      "Respect the crowd and the crew — zero tolerance for harassment.",
    ],
    amenities: [
      "Bar",
      "Green room",
      "In-house PA + sound engineer",
      "Accessible entrance",
      "Street parking nearby",
    ],
    photos: [
      { alt: `${place.name} main room`, caption: "The main room" },
      { alt: `${place.name} stage`, caption: "Stage + PA" },
    ],
    requestIntro:
      "Want to play here? Send us your music, your routing dates, and a rough idea of your local draw — we pay every act on the bill.",
  };
};

export const seedPlaceEntityPages = async (prisma: PrismaClient) => {
  const places = await prisma.place.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      city: true,
      region: true,
      capacity: true,
    },
  });

  let count = 0;
  for (let i = 0; i < places.length; i++) {
    const place = places[i]!;
    // Place.slug can be null in the schema; fall back to a derived slug so
    // the EntityPage row always has a usable URL fragment.
    const slug =
      place.slug ??
      place.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const fallbackBio = `${place.name} — ${place.city}, ${place.region}. Capacity ${place.capacity ?? "—"}.`;
    const bio = VENUE_BIOS[slug] ?? fallbackBio;

    // EVERY venue gets the FULL PLACE:venue template. Tailored content comes
    // from VENUE_CONTENT keyed by slug; any venue without an entry falls back to
    // DB-derived content so the template is still complete.
    const content = VENUE_CONTENT[slug] ?? deriveFallbackVenueContent(place);
    const blocks = buildVenueBlocks({
      slug,
      bio,
      totalCapacity: place.capacity,
      content,
    });

    await upsertEntityPage(prisma, {
      ownerType: "PLACE",
      ownerId: place.id,
      slug,
      displayName: place.name,
      bio,
      avatarUrl: PLACE_AVATARS[i % PLACE_AVATARS.length]!,
      bannerUrl: PLACE_BANNERS[i % PLACE_BANNERS.length]!,
      // Preset rotation unchanged; SOMA Warehouse is the deliberate venue grid
      // holdout (freeform canvas stays exercised — see THEMES comment).
      theme: {
        ...(i % 2 === 0 ? THEMES.swissAccent! : THEMES.warmDark!),
        ...(slug === GRID_HOLDOUT_VENUE_SLUG ? { layoutKey: "grid" } : {}),
      },
      blocks,
    });
    count++;
  }
  return count;
};

// The one seeded human we flesh out with the full HUMAN:musician EPK.
const MUSICIAN_HUMAN_ID = DEMO_IDS.human2;

// A musician-style bio for the fleshed-out EPK (overrides the terse promoter
// bio the identity seed set for this human, so the page reads cohesively).
const MUSICIAN_BIO =
  "Alex Rivera writes plainspoken folk songs about leaving and coming back. Based out of East Nashville, playing rooms up and down the Southeast — porch shows, listening rooms, and the occasional loud one.";

// Photo pool for the musician EPK gallery (live + portrait).
const MUSICIAN_PHOTOS = [
  "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=1200&q=80",
  "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=1200&q=80",
];

/**
 * Full HUMAN:musician EPK block set, seeded in the canonical order (about,
 * music, tracks, video, photos, press, stats, upcoming_events, shows,
 * past_shows, genre_tags, rider, booking_info, links) so nothing is appended
 * on editor load.
 *
 * `shows` / `past_shows` / `stats` are server-driven — get-public-page.ts
 * rebuilds them from real lineup + performer-stats data and only renders them
 * with its trusted `dataSource` marker, so their seeded payload is just a
 * heading placeholder (they render once this human is attached to event
 * lineups / becomes stats-eligible). `stats` is seeded HIDDEN (opt-in).
 *
 * `music` / `tracks` embed URLs use hosts on the media-embed provider
 * allowlist (packages/core/src/lib/embeds) so they pass `matchEmbedProviderByHost`.
 */
const buildMusicianEpkBlocks = (): SeedBlock[] => [
  // Canonical HUMAN:musician order (0..13): about, music, tracks, video,
  // photos, press, stats, upcoming_events, shows, past_shows, genre_tags,
  // rider, booking_info, links. (Registry is being aligned to the same order
  // in packages/core — keep these in lockstep.)
  aboutBlock(MUSICIAN_BIO, 0),
  musicBlock(
    [
      { provider: "spotify", url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4" },
      { provider: "bandcamp", url: "https://alexrivera.bandcamp.com/album/back-roads" },
    ],
    1,
  ),
  tracksBlock(
    [
      {
        url: "https://open.spotify.com/track/2takcwOaAZWiXQijPHIx7B",
        label: "Single — radio + sync friendly",
      },
      { url: "https://www.youtube.com/watch?v=hTWKbfoikeg", label: "Live at the Basement East" },
      { url: "https://soundcloud.com/alex-rivera-music/porch-light", label: "Fan favorite" },
    ],
    2,
  ),
  videoBlock(
    [
      { url: "https://www.youtube.com/watch?v=9bZkp7q19f0", title: "Official video — \"Back Roads\"" },
    ],
    3,
  ),
  photosBlock(
    [
      { url: MUSICIAN_PHOTOS[0]!, alt: "Alex Rivera performing live", caption: "Live, spring 2026" },
      { url: MUSICIAN_PHOTOS[1]!, alt: "Alex Rivera portrait", caption: "Press photo — credit: J. Chen" },
    ],
    4,
  ),
  pressBlock(
    [
      {
        title: "Ten East Nashville songwriters to watch this year",
        source: "The Nashville Scene",
        url: "https://www.nashvillescene.com",
        date: "2026-03-14",
        excerpt:
          "Rivera's songs feel lived-in and unhurried — the kind of writing that rewards a quiet room.",
      },
      {
        title: "Live review: a sold-out night at the listening room",
        source: "No Depression",
        date: "2026-01-22",
        excerpt: "A confident set that never once reached for the cheap applause line.",
      },
    ],
    5,
  ),
  serverBlock("stats", "By the numbers", 6, 1, /* visible */ false),
  upcomingEventsBlock(7),
  serverBlock("shows", "Upcoming shows", 8, 2),
  serverBlock("past_shows", "Past shows", 9, 2),
  genreTagsBlock(["Indie Folk", "Americana", "Alt-Country", "Songwriter"], 10),
  riderBlock(
    "Solo or full-band setups are flexible. For rooms without a house engineer, I can bring a small PA for up to ~150 cap. Prefer a 15-minute line check.",
    [
      "3 vocal mics (SM58 or equivalent)",
      "2 DI boxes (acoustic guitar + keys)",
      "4 monitor mixes for full band",
      "1 bar stool, no back",
      "Bottled water x4",
    ],
    11,
  ),
  bookingInfoBlock(
    {
      contactEmail: "booking@alexriveramusic.example",
      bookingUrl: "https://alexriveramusic.example/booking",
      notes:
        "Solo or full band (up to 4-piece). Happy to play listening rooms, house shows, and festival side stages. Available for regional runs — ask about routing.",
    },
    12,
  ),
  linksBlock(
    [
      { label: "Bandcamp", url: "https://alexrivera.bandcamp.com" },
      { label: "Spotify", url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4" },
      { label: "Instagram", url: "https://instagram.com/alexriveramusic" },
    ],
    13,
  ),
];

// ── Human tiers ────────────────────────────────────────────────────────────

// Tier-2 performer: Diego Alvarez (human7). His identity-seed bio describes an
// actual performing practice — live 16mm projection sets ("Night job: 16mm
// projection") — where every other non-musician human is a staff/organizer
// role (venue manager, photographer, curator, booker). He gets the working-act
// block set below; Alex Rivera (human2) keeps the full musician EPK.
const PERFORMER_HUMAN_ID = DEMO_IDS.human7;

// Photo pool for human profile galleries (portrait / candid), same Unsplash
// pattern as VENUE_PHOTOS / MUSICIAN_PHOTOS. Per-human alt text comes from
// HUMAN_CONTENT; photos map onto this pool by index.
const HUMAN_PHOTOS = [
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&q=80",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800&q=80",
  "https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=800&q=80",
  "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=800&q=80",
  "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=800&q=80",
];

// Per-human tailored content for the fan-floor HUMAN:generic template, keyed
// by humanId. `about` comes from each page's existing bio at seed time (set by
// identity.ts); this map supplies links (https only — the public LinksBlock
// drops non-http URLs) and per-photo alt/caption mapped onto HUMAN_PHOTOS.
type HumanGenericContent = {
  links: Array<{ label: string; url: string }>;
  photos: Array<{ alt: string; caption?: string }>;
};

const HUMAN_CONTENT: Record<string, HumanGenericContent> = {
  // Jamie Chen — festival curator and community organizer.
  [DEMO_IDS.human3]: {
    links: [
      { label: "Festival portfolio", url: "https://jamiechen.example/festivals" },
      { label: "Instagram", url: "https://instagram.com/jamiechencurates" },
    ],
    photos: [{ alt: "Jamie Chen on a festival site walk", caption: "Site walk, spring build" }],
  },
  // Sam Okonkwo — venue manager and live entertainment specialist.
  [DEMO_IDS.human4]: {
    links: [
      { label: "LinkedIn", url: "https://linkedin.com/in/sam-okonkwo-example" },
    ],
    photos: [{ alt: "Sam Okonkwo at front of house", caption: "Front of house, doors open" }],
  },
  // Taylor Morgan — concert photographer and event coordinator.
  [DEMO_IDS.human5]: {
    links: [
      { label: "Photo portfolio", url: "https://taylormorgan.example/photo" },
      { label: "Instagram", url: "https://instagram.com/taylormorganshoots" },
      { label: "Print shop", url: "https://taylormorgan.example/prints" },
    ],
    photos: [
      { alt: "Taylor Morgan shooting from the pit", caption: "In the pit, three-song limit" },
      { alt: "Taylor Morgan portrait", caption: "Self-portrait, house lights up" },
    ],
  },
  // Morgan Kowalski — Chicago DIY booker and zine maker.
  [DEMO_IDS.human6]: {
    links: [
      { label: "Zine archive", url: "https://example.com/chicago-underground/zine" },
      { label: "Show listings", url: "https://example.com/chicago-underground" },
    ],
    photos: [{ alt: "Morgan Kowalski at the merch table", caption: "Zine table, Logan Square" }],
  },
  // Ithas Fire Admin (dev-login user).
  [DEMO_IDS.devUser]: {
    links: [{ label: "Ithas Fire", url: "https://ithasfire.com" }],
    photos: [{ alt: "Ithas Fire Admin", caption: "The person behind the demo data" }],
  },
};

// Pool-fallback content so no human ever seeds an empty photos block or a
// linkless links block, even if a future fixture is missing from HUMAN_CONTENT.
const deriveFallbackHumanContent = (displayName: string): HumanGenericContent => ({
  links: [{ label: "Ithas Fire", url: "https://ithasfire.com" }],
  photos: [{ alt: `${displayName} at a show` }],
});

/**
 * Fan-floor HUMAN:generic template — canonical order (about, links, photos,
 * upcoming_events) so nothing is appended on editor load.
 */
const buildHumanGenericBlocks = (
  aboutText: string,
  content: HumanGenericContent,
): SeedBlock[] => [
  aboutBlock(aboutText, 0),
  linksBlock(content.links, 1),
  photosBlock(
    content.photos.map((photo, idx) => ({
      url: HUMAN_PHOTOS[idx % HUMAN_PHOTOS.length]!,
      alt: photo.alt,
      ...(photo.caption ? { caption: photo.caption } : {}),
    })),
    2,
  ),
  upcomingEventsBlock(3),
];

/**
 * Tier-2 working-act block set for Diego Alvarez — exact order: about, music,
 * video, photos, genre_tags, upcoming_events, booking_info, links. Embed URLs
 * use hosts on the media-embed provider allowlist (packages/core/src/lib/embeds),
 * same constraint the musician EPK content satisfies.
 */
const buildPerformerBlocks = (aboutText: string): SeedBlock[] => [
  aboutBlock(aboutText, 0),
  musicBlock(
    [
      { provider: "soundcloud", url: "https://soundcloud.com/diego-alvarez-av/rooftop-score" },
      { provider: "bandcamp", url: "https://diegoalvarez.bandcamp.com/album/projection-loops" },
    ],
    1,
  ),
  videoBlock(
    [
      {
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        title: "Live A/V set — 16mm + modular, rooftop premiere",
      },
    ],
    2,
  ),
  photosBlock(
    [
      {
        url: HUMAN_PHOTOS[3]!,
        alt: "Diego Alvarez behind the projector",
        caption: "Dual 16mm rig, mid-set",
      },
      {
        url: HUMAN_PHOTOS[4]!,
        alt: "Diego Alvarez rooftop screening",
        caption: "Rooftop screening at dusk",
      },
    ],
    3,
  ),
  genreTagsBlock(["Live A/V", "Expanded Cinema", "Ambient", "Experimental"], 4),
  upcomingEventsBlock(5),
  bookingInfoBlock(
    {
      contactEmail: "bookings@diegoalvarez.example",
      notes:
        "Live 16mm projection sets with ambient score — solo or with a guest musician. Needs a dark room (or a rooftop after sunset), one 4x8 surface or a clean wall, and two mains. Set lengths 30–90 min.",
    },
    6,
  ),
  linksBlock(
    [
      { label: "Bandcamp", url: "https://diegoalvarez.bandcamp.com" },
      { label: "Screening archive", url: "https://diegoalvarez.example/screenings" },
    ],
    7,
  ),
];

export const enrichHumanEntityPages = async (prisma: PrismaClient) => {
  // Enrich the additional humans (DEMO_IDS.human2..7) with banner + theme +
  // blocks, leaving displayName/slug/bio (set by identity.ts) intact.
  const humanIds = [
    DEMO_IDS.human2,
    DEMO_IDS.human3,
    DEMO_IDS.human4,
    DEMO_IDS.human5,
    DEMO_IDS.human6,
    DEMO_IDS.human7,
    DEMO_IDS.devUser,
  ];

  let count = 0;
  for (let i = 0; i < humanIds.length; i++) {
    const humanId = humanIds[i]!;
    const page = await prisma.entityPage.findUnique({
      where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: humanId } },
    });
    if (!page) continue;

    const isMusician = humanId === MUSICIAN_HUMAN_ID;

    await prisma.entityPage.update({
      where: { id: page.id },
      data: {
        bannerUrl: HUMAN_BANNERS[i % HUMAN_BANNERS.length]!,
        showFollowerCount: true,
        // Give the fleshed-out musician a cohesive performer bio (identity.ts
        // set a terse promoter bio for this human).
        ...(isMusician ? { bio: MUSICIAN_BIO } : {}),
      },
    });

    await prisma.pageTheme.upsert({
      where: { pageId: page.id },
      update: i % 2 === 0 ? THEMES.warmDark! : THEMES.swissAccent!,
      create: {
        pageId: page.id,
        ...(i % 2 === 0 ? THEMES.warmDark! : THEMES.swissAccent!),
      },
    });

    await prisma.pageBlock.deleteMany({ where: { pageId: page.id } });

    // Three tiers (about renders from `content`, NOT `text` — AboutBlock.tsx):
    //   - human2 (Alex Rivera): the full 14-block musician EPK.
    //   - human7 (Diego Alvarez): the tier-2 working-act set.
    //   - everyone else: the fan-floor HUMAN:generic template (about, links,
    //     photos, upcoming_events) with tailored links + photos.
    const displayName = page.displayName ?? "Ithas Fire user";
    const aboutText = page.bio ?? `${displayName} on Ithas Fire.`;
    const blocks: SeedBlock[] = isMusician
      ? buildMusicianEpkBlocks()
      : humanId === PERFORMER_HUMAN_ID
        ? buildPerformerBlocks(aboutText)
        : buildHumanGenericBlocks(
            aboutText,
            HUMAN_CONTENT[humanId] ?? deriveFallbackHumanContent(displayName),
          );

    for (const block of blocks) {
      await prisma.pageBlock.create({
        data: {
          pageId: page.id,
          kind: block.kind,
          orderIndex: block.orderIndex,
          data: block.data as never,
          visible: block.visible ?? true,
        },
      });
    }
    count++;
  }
  return count;
};

export const seedAllEntityPages = async (prisma: PrismaClient) => {
  console.log("Seeding entity pages (orgs, places, enriched humans)...");
  const orgs = await seedOrgEntityPages(prisma);
  const places = await seedPlaceEntityPages(prisma);
  const humans = await enrichHumanEntityPages(prisma);
  console.log(
    `  Seeded ${orgs} org pages, ${places} place pages, enriched ${humans} human pages`,
  );
};
