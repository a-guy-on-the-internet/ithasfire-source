import { z } from "zod";

import type { PageOwnerType } from "@th/types/repos/entity-pages";
import {
  plainTextMultilineOptional,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { sanitizeAnnouncementHtml } from "../../lib/announcement-html";
import { MEDIA_EMBED_PROVIDER_IDS } from "../../lib/embeds/providers";
import { matchEmbedProviderByHost } from "../../lib/embeds/parse-embed-url";

export type BlockConfigCategory =
  | "universal"
  | "identity"
  | "content"
  | "events"
  | "music"
  | "place"
  | "organization"
  | "custom";

export type BlockFieldKind =
  | "text"
  | "textarea"
  | "richText"
  | "number"
  | "boolean"
  | "select"
  | "image"
  | "imageList"
  | "linkList"
  | "objectList"
  | "html"
  | "readonly";

/**
 * The image URLs a value of an image-holding field kind carries, keyed by
 * FIELD KIND (data, not a field-name list: spec entity-page-wysiwyg-editor
 * R19). A kind absent here holds no images. The page editor's draft and
 * Publish check every URL these return (page-draft-ops / publish-page-draft:
 * the page's own upload, or a URL already on the live page).
 */
export const BLOCK_FIELD_KIND_IMAGE_URLS: Partial<
  Record<BlockFieldKind, (value: unknown) => string[]>
> = {
  image: (value) => (typeof value === "string" ? [value] : []),
  imageList: (value) =>
    Array.isArray(value)
      ? value.flatMap((item) =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as { url?: unknown }).url === "string"
            ? [(item as { url: string }).url]
            : [],
        )
      : [],
};

/** Every image URL in the image-kind fields of these blocks. */
export function blockImageUrlsIn(
  blocks: readonly { kind: string; data: unknown }[],
): Set<string> {
  const urls = new Set<string>();
  for (const block of blocks) {
    const data =
      block.data !== null && typeof block.data === "object"
        ? (block.data as Record<string, unknown>)
        : {};
    for (const field of getBlockConfig(block.kind)?.fields ?? []) {
      for (const url of BLOCK_FIELD_KIND_IMAGE_URLS[field.kind]?.(
        data[field.name],
      ) ?? []) {
        urls.add(url);
      }
    }
  }
  return urls;
}

export type BlockFieldOption = {
  value: string;
  labelKey: string;
};

export type BlockFieldConfig = {
  name: string;
  labelKey: string;
  kind: BlockFieldKind;
  required?: boolean;
  options?: readonly BlockFieldOption[];
  placeholderKey?: string;
  helpTextKey?: string;
};

export type BlockDefaultData = Readonly<Record<string, unknown>>;
export type BlockDefaultSpan = 1 | 2;

export type BlockConfig<K extends string = string> = {
  kind: K;
  ownerTypes: readonly PageOwnerType[];
  labelKey: string;
  category: BlockConfigCategory;
  defaultSpan: BlockDefaultSpan;
  defaultData: BlockDefaultData;
  fields: readonly BlockFieldConfig[];
  palette?: boolean;
  /**
   * A pinned block cannot be removed OR hidden by the page owner, and only
   * one lives on a page — it is reorderable, nothing else (venue-track-record
   * ruling R6 / FR-012). Its value is that the owner has no hand on it.
   * `managePageBlocks` refuses delete / hide / kind-change / duplicate-add
   * with `BLOCK_PINNED`. Only `track_record` is pinned.
   */
  pinned?: boolean;
  /**
   * Retired from adding: the kind stays valid (a page that has one keeps it
   * and can reorder or remove it), but no palette offers it and no template
   * seeds it. Not the same as `palette: false`, which means "seeded by a
   * template, never added by hand" (page-templates FR-007 keeps every such
   * kind reachable).
   */
  retired?: boolean;
};

export type BlockDataValidationResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: readonly string[] };

const ALL_OWNER_TYPES = [
  "HUMAN",
  "PLACE",
  "ORGANIZATION",
] as const satisfies readonly PageOwnerType[];

export const UNIVERSAL_BLOCK_KINDS = [
  "about",
  "links",
  "photos",
  "upcoming_events",
  "announcements",
  "faq",
] as const;

export const HUMAN_BLOCK_KINDS = [
  "shows",
  "music",
  "tracks",
  "video",
  "press",
  "stats",
  "past_shows",
  "rider",
  "genre_tags",
] as const;

export const PLACE_BLOCK_KINDS = [
  "location_map",
  "capacity_info",
  "house_rules",
  "amenities",
  "tech_specs",
  "resident_artists",
  "booking_info",
  "request_to_play",
  "track_record",
  "venue_stats",
  "audience_stats",
  "rate_venue",
] as const;

export const ORG_BLOCK_KINDS = [
  "team",
  "mission",
  "managed_places",
  "past_events",
] as const;

export type UniversalBlockKind = (typeof UNIVERSAL_BLOCK_KINDS)[number];
export type HumanBlockKind = (typeof HUMAN_BLOCK_KINDS)[number];
export type PlaceBlockKind = (typeof PLACE_BLOCK_KINDS)[number];
export type OrgBlockKind = (typeof ORG_BLOCK_KINDS)[number];
export type BlockKind =
  | UniversalBlockKind
  | HumanBlockKind
  | PlaceBlockKind
  | OrgBlockKind;

const headingField = {
  name: "heading",
  labelKey: "admin.peBlockFieldHeading",
  kind: "text",
} as const satisfies BlockFieldConfig;

// Plain-text free-text fields (about/mission content, captions, notes, …) —
// sanitized for the bidi-override/zero-width spoofing class, matching every
// other free-text helper in this file. Most are rendered as plain JSX text
// downstream. NOT about/mission `content` as the page editor stores it
// (sanitised HTML); see the HAZARD notes on the `about` and `mission`
// schemas below.
const optionalText = plainTextMultilineOptional(10_000).optional();
// Public-page display text (heading/title/alt/venueName/role, …) — sanitized
// so every field backed by this alias strips HTML + control chars at once.
const optionalShortText = plainTextOptional(280).optional();
const blockObjectSchema = z.object({}).passthrough();

const optionalHttpUrl = z
  .string()
  .trim()
  .max(2_048)
  .optional()
  .refine((value) => value === undefined || value === "" || isHttpUrl(value), {
    message: "expected_http_url",
  })
  .transform((value) => (value === "" ? undefined : value));

const linkItemSchema = z
  .object({
    label: plainTextRequired(160),
    url: z
      .string()
      .trim()
      .max(2_048)
      .refine(isHttpUrl, { message: "expected_http_url" }),
    icon: z.string().max(24).optional(),
  })
  .strict();

const imageItemSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2_048)
      .refine(isHttpUrl, { message: "expected_http_url" }),
    alt: optionalShortText,
    caption: optionalText,
    // Press-asset flag (FR-008): when true the public renderer offers a direct
    // download link/button for this image in addition to normal display.
    downloadable: z.boolean().optional(),
  })
  .strict();

// A media embed for the musician EPK. The URL's host must belong to the
// declared provider's domain allowlist (NFR-003) — no arbitrary iframe src.
const mediaEmbedItemSchema = z
  .object({
    provider: z.enum(MEDIA_EMBED_PROVIDER_IDS),
    url: z
      .string()
      .trim()
      .max(2_048)
      .refine(isHttpUrl, { message: "expected_http_url" }),
  })
  .strict()
  .refine((item) => matchEmbedProviderByHost(item.url) === item.provider, {
    message: "embed_url_host_provider_mismatch",
    path: ["url"],
  });

// A curated track (FR-006): a specific embed URL on the provider allowlist,
// plus an optional short freeform label ("festival closer", "sync-friendly").
const trackItemSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2_048)
      .refine(isHttpUrl, { message: "expected_http_url" })
      .refine((url) => matchEmbedProviderByHost(url) !== null, {
        message: "embed_url_not_allowlisted",
      }),
    label: plainTextOptional(60).optional(),
  })
  .strict();

const videoItemSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2_048)
      .refine(isHttpUrl, { message: "expected_http_url" }),
    title: optionalShortText,
  })
  .strict();

const eventSummarySchema = z
  .object({
    id: z.string().min(1).max(200),
    title: plainTextRequired(280),
    date: z.string().min(1).max(100),
    venueName: optionalShortText,
    slug: z.string().min(1).max(200).optional(),
  })
  .strict();

const faqItemSchema = z
  .object({
    question: plainTextOptional(1_000),
    answer: plainTextMultilineOptional(5_000),
  })
  .strict();

const announcementSchema = z
  .object({
    id: z.string().max(200).optional(),
    title: optionalShortText,
    body: optionalText,
    // Defense-in-depth: `get-public-page.ts` / `get-my-page.ts` always
    // overwrite this block's rendered data with server-sourced,
    // `sanitizeAnnouncementHtml()`-cleaned content, but sanitize at the
    // schema layer too in case this field is ever read before that
    // overwrite happens. `sanitizeAnnouncementHtml` is idempotent, so
    // running it twice downstream is safe.
    bodyHtml: z
      .string()
      .max(10_000)
      .optional()
      .transform((html) =>
        html === undefined ? undefined : sanitizeAnnouncementHtml(html),
      ),
    date: z.string().max(100).optional(),
  })
  .passthrough();

const pressMentionSchema = z
  .object({
    title: plainTextRequired(280),
    source: z.string().min(1).max(280),
    url: optionalHttpUrl,
    date: z.string().max(100).optional(),
    excerpt: optionalText,
  })
  .strict();

const teamMemberSchema = z
  .object({
    name: plainTextRequired(280),
    role: optionalShortText,
    avatarUrl: optionalHttpUrl,
  })
  .strict();

// A single labeled row of the venue tech-spec sheet ("PA" → "d&b line array").
// Both halves are optional (like faqItemSchema) so a stray blank "Add item"
// row never rejects the whole block — the renderer skips incomplete rows.
const techSpecItemSchema = z
  .object({
    label: plainTextOptional(160).optional(),
    value: plainTextMultilineOptional(1_000).optional(),
  })
  .strict();

const stringListSchema = z.array(z.string().max(1_000)).max(100);

const blockDataSchemas: Partial<
  Record<BlockKind, z.ZodType<Record<string, unknown>>>
> = {
  // HAZARD (page editor): `content` is a rich-text field (kind "richText"
  // in BLOCK_CONFIGS), but this schema is PLAIN TEXT and strips every tag.
  // The old editor (managePageBlocks) writes plain text through it, and the
  // public AboutBlock / MissionBlock render `content` as text. The page
  // editor's draft and Publish sanitise rich text with lib/page-rich-text.ts
  // themselves and never route it through normalizeBlockData. Step 7 (the
  // public rich-text renderer) changes this schema together with the
  // renderer.
  about: blockObjectSchema.extend({
    heading: optionalShortText,
    content: optionalText,
  }),
  links: blockObjectSchema.extend({
    heading: optionalShortText,
    links: z.array(linkItemSchema).max(100).optional(),
  }),
  photos: blockObjectSchema.extend({
    heading: optionalShortText,
    photos: z.array(imageItemSchema).max(100).optional(),
  }),
  upcoming_events: blockObjectSchema.extend({
    heading: optionalShortText,
    events: z.array(eventSummarySchema).max(100).optional(),
    maxItems: z.number().int().min(1).max(100).optional(),
  }),
  announcements: blockObjectSchema.extend({
    heading: optionalShortText,
    announcements: z.array(announcementSchema).max(100).optional(),
  }),
  faq: blockObjectSchema.extend({
    heading: optionalShortText,
    items: z.array(faqItemSchema).max(100).optional(),
  }),
  past_events: blockObjectSchema.extend({
    heading: optionalShortText,
    events: z.array(eventSummarySchema).max(100).optional(),
    maxItems: z.number().int().min(1).max(100).optional(),
  }),
  // `stats` is a read-only, server-injected block: the ONLY owner-editable
  // field is `heading`. Deliberately NOT a passthrough schema (unlike the
  // others) — it STRIPS every other key so an owner can never persist fake
  // `metrics`/`eligible`/`computedAt` into the block via managePageBlocks and
  // have get-public-page echo them (NFR-001, defense in depth).
  stats: z.object({ heading: optionalShortText }),
  music: blockObjectSchema.extend({
    heading: optionalShortText,
    // Primary artist-profile embeds (FR-005) — max 3.
    embeds: z.array(mediaEmbedItemSchema).max(3).optional(),
  }),
  tracks: blockObjectSchema.extend({
    heading: optionalShortText,
    // Curated, labeled track embeds (FR-006) — max 10.
    tracks: z.array(trackItemSchema).max(10).optional(),
  }),
  video: blockObjectSchema.extend({
    heading: optionalShortText,
    videos: z.array(videoItemSchema).max(100).optional(),
  }),
  press: blockObjectSchema.extend({
    heading: optionalShortText,
    mentions: z.array(pressMentionSchema).max(100).optional(),
  }),
  rider: blockObjectSchema.extend({
    heading: optionalShortText,
    content: optionalText,
    requirements: stringListSchema.optional(),
    downloadUrl: optionalHttpUrl,
  }),
  genre_tags: blockObjectSchema.extend({
    heading: optionalShortText,
    tags: stringListSchema.optional(),
  }),
  location_map: blockObjectSchema.extend({
    heading: optionalShortText,
    address: optionalText,
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }),
  capacity_info: blockObjectSchema.extend({
    heading: optionalShortText,
    totalCapacity: z.number().int().min(0).max(1_000_000).optional(),
    standing: z.number().int().min(0).max(1_000_000).optional(),
    seated: z.number().int().min(0).max(1_000_000).optional(),
    notes: optionalText,
  }),
  house_rules: blockObjectSchema.extend({
    heading: optionalShortText,
    rules: stringListSchema.optional(),
    notes: optionalText,
  }),
  amenities: blockObjectSchema.extend({
    heading: optionalShortText,
    amenities: stringListSchema.optional(),
  }),
  // Venue-side counterpart of the artist `rider` block: the technical facts a
  // performer needs to advance a show (PA / console / monitors / backline /
  // stage size / power / load-in / house engineer), as a flexible labeled
  // spec sheet plus optional free-text notes. The list field is named `specs`
  // (NOT `items`) deliberately — the editor's object-list item models are
  // keyed by FIELD NAME and `items` is already bound to the FAQ
  // question/answer form (see apps/web block-settings-model.ts).
  tech_specs: blockObjectSchema.extend({
    heading: optionalShortText,
    specs: z.array(techSpecItemSchema).max(100).optional(),
    notes: optionalText,
  }),
  booking_info: blockObjectSchema.extend({
    heading: optionalShortText,
    contactEmail: z
      .string()
      .trim()
      .email()
      .max(320)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    // Plain text like the other display strings here; a bare z.string()
    // kept markup and control characters as given.
    contactPhone: plainTextOptional(80).optional(),
    bookingUrl: optionalHttpUrl,
    notes: optionalText,
  }),
  request_to_play: blockObjectSchema.extend({
    heading: optionalShortText,
    intro: optionalText,
  }),
  // Role-forked "Rate this venue" entry point (venue-rating-block-and-owner-
  // optin FR-001/FR-002). Owner-editable copy only — the heading and an
  // optional intro. Everything else (the modal, the role fork, the embedded
  // forms) is behaviour the public renderer owns; there is no server-injected
  // payload, so no anti-spoofing strip is needed (unlike venue_stats).
  rate_venue: blockObjectSchema.extend({
    heading: optionalShortText,
    intro: optionalText,
  }),
  // `track_record` is a read-only, server-injected block (venue-track-record-
  // and-review-switch FR-011): shows hosted, first/last show, who has played
  // — built from things that HAPPENED, never testimony. The ONLY owner-
  // editable field is `heading`. Same anti-spoofing pattern as `venue_stats`
  // below — deliberately NOT a passthrough schema; it STRIPS every other key
  // so a venue owner can never persist fake `showsHosted`/`recentActs`/
  // `dataSource` content via managePageBlocks and have get-public-page echo
  // it. Real content is rebuilt server-side from PlaceStats + the public
  // lineup history only.
  track_record: z.object({ heading: optionalShortText }),
  // `venue_stats` is a read-only, server-injected block (booking-review-data-
  // weave FR-004): the ONLY owner-editable field is `heading`. Same
  // anti-spoofing pattern as the HUMAN `stats` block above — deliberately NOT
  // a passthrough schema; it STRIPS every other key so a venue owner can never
  // persist fake `snapshot`/`dataSource` content via managePageBlocks and have
  // get-public-page echo it. Real content is rebuilt server-side from
  // PlaceStats.publicSnapshot (the anonymization-policy boundary) only.
  venue_stats: z.object({ heading: optionalShortText }),
  // `audience_stats` is a read-only, server-injected block (attendee-reviews
  // FR-005): verified-attendee testimony aggregates, DISTINCT from the
  // performer-testimony `venue_stats` block above. Same anti-spoofing pattern —
  // deliberately NOT a passthrough schema; it STRIPS every key except the
  // owner-editable `heading` so a venue owner can never persist a fake
  // `snapshot`/`dataSource` and have get-public-page echo it. Real content is
  // rebuilt server-side from the ReviewAggregate(PLACE) snapshot only.
  audience_stats: z.object({ heading: optionalShortText }),
  team: blockObjectSchema.extend({
    heading: optionalShortText,
    members: z.array(teamMemberSchema).max(100).optional(),
  }),
  // HAZARD (page editor): `content` is a rich-text field (kind "richText"
  // in BLOCK_CONFIGS), but this schema is PLAIN TEXT and strips every tag.
  // The old editor (managePageBlocks) writes plain text through it, and the
  // public AboutBlock / MissionBlock render `content` as text. The page
  // editor's draft and Publish sanitise rich text with lib/page-rich-text.ts
  // themselves and never route it through normalizeBlockData. Step 7 (the
  // public rich-text renderer) changes this schema together with the
  // renderer.
  mission: blockObjectSchema.extend({
    heading: optionalShortText,
    content: optionalText,
  }),
};

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const BLOCK_CONFIGS = {
  about: {
    kind: "about",
    ownerTypes: ALL_OWNER_TYPES,
    labelKey: "admin.peBlockKindAbout",
    category: "identity",
    defaultSpan: 2,
    defaultData: { content: "" },
    fields: [
      headingField,
      {
        name: "content",
        labelKey: "admin.peBlockFieldContent",
        // Stored as sanitised HTML by the page editor; see the HAZARD note
        // on the `about` / `mission` data schemas above.
        kind: "richText",
        required: true,
      },
    ],
  },
  links: {
    kind: "links",
    ownerTypes: ALL_OWNER_TYPES,
    labelKey: "admin.peBlockKindLinks",
    category: "identity",
    defaultSpan: 1,
    defaultData: { links: [] },
    fields: [
      headingField,
      {
        name: "links",
        labelKey: "admin.peBlockFieldLinks",
        kind: "linkList",
      },
    ],
  },
  photos: {
    kind: "photos",
    ownerTypes: ALL_OWNER_TYPES,
    labelKey: "admin.peBlockKindPhotos",
    category: "content",
    defaultSpan: 2,
    defaultData: { photos: [] },
    fields: [
      headingField,
      {
        name: "photos",
        labelKey: "admin.peBlockFieldPhotos",
        kind: "imageList",
      },
    ],
  },
  upcoming_events: {
    kind: "upcoming_events",
    ownerTypes: ALL_OWNER_TYPES,
    labelKey: "admin.peBlockKindUpcomingEvents",
    category: "events",
    defaultSpan: 2,
    defaultData: { events: [] },
    fields: [
      headingField,
      {
        name: "events",
        labelKey: "admin.peBlockFieldEvents",
        kind: "objectList",
      },
    ],
  },
  announcements: {
    kind: "announcements",
    ownerTypes: ALL_OWNER_TYPES,
    labelKey: "admin.peBlockKindAnnouncements",
    category: "content",
    defaultSpan: 2,
    defaultData: { announcements: [] },
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
  },
  faq: {
    kind: "faq",
    ownerTypes: ALL_OWNER_TYPES,
    labelKey: "admin.peBlockKindFaq",
    category: "content",
    defaultSpan: 2,
    defaultData: { items: [] },
    fields: [
      headingField,
      {
        name: "items",
        labelKey: "admin.peBlockFieldFaqItems",
        kind: "objectList",
      },
    ],
  },
  shows: {
    kind: "shows",
    ownerTypes: ["HUMAN"],
    labelKey: "admin.peBlockKindShows",
    category: "events",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
    palette: false,
  },
  music: {
    kind: "music",
    // Dual-owner (HUMAN + ORGANIZATION) — a band/act presents its music via the
    // owner-agnostic media block (the "band" org archetype). Config below is
    // owner-neutral (palette/label/fields carry no HUMAN-only assumptions).
    ownerTypes: ["HUMAN", "ORGANIZATION"],
    labelKey: "admin.peBlockKindMusic",
    category: "music",
    defaultSpan: 2,
    defaultData: { embeds: [] },
    fields: [
      headingField,
      {
        name: "embeds",
        labelKey: "admin.peBlockFieldMusicEmbeds",
        kind: "objectList",
        helpTextKey: "admin.peBlockFieldEmbedProvidersHelp",
      },
    ],
  },
  tracks: {
    kind: "tracks",
    ownerTypes: ["HUMAN"],
    labelKey: "admin.peBlockKindTracks",
    category: "music",
    defaultSpan: 2,
    defaultData: { tracks: [] },
    fields: [
      headingField,
      {
        name: "tracks",
        labelKey: "admin.peBlockFieldTracks",
        kind: "objectList",
        helpTextKey: "admin.peBlockFieldEmbedProvidersHelp",
      },
    ],
    palette: false,
  },
  video: {
    kind: "video",
    // Dual-owner (HUMAN + ORGANIZATION) — see `music` above.
    ownerTypes: ["HUMAN", "ORGANIZATION"],
    labelKey: "admin.peBlockKindVideo",
    category: "content",
    defaultSpan: 2,
    defaultData: { videos: [] },
    fields: [
      headingField,
      {
        name: "videos",
        labelKey: "admin.peBlockFieldVideos",
        kind: "objectList",
      },
    ],
  },
  press: {
    kind: "press",
    // Dual-owner (HUMAN + ORGANIZATION) — see `music` above.
    ownerTypes: ["HUMAN", "ORGANIZATION"],
    labelKey: "admin.peBlockKindPress",
    category: "content",
    defaultSpan: 2,
    defaultData: { mentions: [] },
    fields: [
      headingField,
      {
        name: "mentions",
        labelKey: "admin.peBlockFieldPressMentions",
        kind: "objectList",
      },
    ],
  },
  stats: {
    kind: "stats",
    ownerTypes: ["HUMAN"],
    labelKey: "admin.peBlockKindStats",
    category: "identity",
    defaultSpan: 1,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
  },
  past_shows: {
    kind: "past_shows",
    ownerTypes: ["HUMAN"],
    labelKey: "admin.peBlockKindPastShows",
    category: "events",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
    palette: false,
  },
  rider: {
    kind: "rider",
    ownerTypes: ["HUMAN"],
    labelKey: "admin.peBlockKindRider",
    category: "music",
    defaultSpan: 2,
    defaultData: { content: "", requirements: [] },
    fields: [
      headingField,
      {
        name: "content",
        labelKey: "admin.peBlockFieldContent",
        kind: "textarea",
      },
      {
        name: "requirements",
        labelKey: "admin.peBlockFieldRequirements",
        kind: "objectList",
      },
      {
        name: "downloadUrl",
        labelKey: "admin.peBlockFieldDownloadUrl",
        kind: "text",
      },
    ],
  },
  genre_tags: {
    kind: "genre_tags",
    // Dual-owner (HUMAN + ORGANIZATION) — a band lifts these into its hero
    // chips (OrgHero), same as a solo artist. See `music` above.
    ownerTypes: ["HUMAN", "ORGANIZATION"],
    labelKey: "admin.peBlockKindGenreTags",
    category: "music",
    defaultSpan: 1,
    defaultData: { tags: [] },
    fields: [
      headingField,
      { name: "tags", labelKey: "admin.peBlockFieldTags", kind: "objectList" },
    ],
  },
  location_map: {
    kind: "location_map",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindLocationMap",
    category: "place",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
  },
  capacity_info: {
    kind: "capacity_info",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindCapacityInfo",
    category: "place",
    defaultSpan: 1,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "totalCapacity",
        labelKey: "admin.peBlockFieldTotalCapacity",
        kind: "number",
      },
      {
        name: "standing",
        labelKey: "admin.peBlockFieldStandingCapacity",
        kind: "number",
      },
      {
        name: "seated",
        labelKey: "admin.peBlockFieldSeatedCapacity",
        kind: "number",
      },
      { name: "notes", labelKey: "admin.peBlockFieldNotes", kind: "textarea" },
    ],
  },
  house_rules: {
    kind: "house_rules",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindHouseRules",
    category: "place",
    defaultSpan: 2,
    defaultData: { rules: [] },
    fields: [
      headingField,
      {
        name: "rules",
        labelKey: "admin.peBlockFieldRules",
        kind: "objectList",
      },
      { name: "notes", labelKey: "admin.peBlockFieldNotes", kind: "textarea" },
    ],
  },
  amenities: {
    kind: "amenities",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindAmenities",
    category: "place",
    defaultSpan: 2,
    defaultData: { amenities: [] },
    fields: [
      headingField,
      {
        name: "amenities",
        labelKey: "admin.peBlockFieldAmenities",
        kind: "objectList",
      },
    ],
  },
  // Venue tech-spec sheet — what an advancing artist needs to know. See the
  // schema comment above for why the list field is `specs`, not `items`.
  tech_specs: {
    kind: "tech_specs",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindTechSpecs",
    category: "place",
    defaultSpan: 2,
    defaultData: { specs: [] },
    fields: [
      headingField,
      {
        name: "specs",
        labelKey: "admin.peBlockFieldSpecs",
        kind: "objectList",
      },
      { name: "notes", labelKey: "admin.peBlockFieldNotes", kind: "textarea" },
    ],
  },
  // Renders only a stub today, so it is retired from the add palette (page
  // editor spec FR-010). The kind stays valid: a page that already has one
  // keeps it and can still reorder or remove it.
  resident_artists: {
    kind: "resident_artists",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindResidentArtists",
    category: "place",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
    retired: true,
  },
  booking_info: {
    kind: "booking_info",
    // Tri-owner (PLACE + HUMAN + ORGANIZATION) — a band exposes its own
    // booking-contact card, same owner-neutral block as a venue/solo artist.
    ownerTypes: ["PLACE", "HUMAN", "ORGANIZATION"],
    labelKey: "admin.peBlockKindBookingInfo",
    category: "place",
    defaultSpan: 1,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "contactEmail",
        labelKey: "admin.peBlockFieldContactEmail",
        kind: "text",
      },
      {
        name: "contactPhone",
        labelKey: "admin.peBlockFieldContactPhone",
        kind: "text",
      },
      {
        name: "bookingUrl",
        labelKey: "admin.peBlockFieldBookingUrl",
        kind: "text",
      },
      { name: "notes", labelKey: "admin.peBlockFieldNotes", kind: "textarea" },
    ],
  },
  request_to_play: {
    kind: "request_to_play",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindRequestToPlay",
    category: "place",
    defaultSpan: 1,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "intro",
        labelKey: "admin.peBlockFieldRequestToPlayIntro",
        kind: "textarea",
      },
    ],
  },
  // The venue's track record (venue-track-record-and-review-switch FR-011 /
  // FR-012, rulings R6 / R8 / R9): shows hosted, first and last show, cadence,
  // who has played here. Computed from PUBLISHED venue-confirmed events that
  // have ENDED and from lineups that are already public — things that
  // happened, not testimony — and CANNOT be edited by the page owner beyond
  // the heading. PINNED: seeded once by the venue template and never
  // removable or hideable (the owner has no hand on it). `palette: false`
  // because it is seeded, not added — a second copy would be a second
  // undeletable block.
  track_record: {
    kind: "track_record",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindTrackRecord",
    category: "place",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
        helpTextKey: "admin.peBlockFieldTrackRecordHelp",
      },
    ],
    palette: false,
    pinned: true,
  },
  // Crowd-sourced venue stats reported anonymously by performers (booking-
  // review-data-weave FR-004/FR-007). Content is computed from anonymous
  // performer reviews (PlaceStats.publicSnapshot via the place-review
  // anonymization policy) and CANNOT be edited by the page owner — only the
  // heading is owner-editable. The owner may hide the block, but the same
  // aggregates remain on performer-facing surfaces (Request to Play form).
  venue_stats: {
    kind: "venue_stats",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindVenueStats",
    category: "place",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
        helpTextKey: "admin.peBlockFieldVenueStatsHelp",
      },
    ],
  },
  // Verified-attendee review aggregates reported by scanned ticket holders
  // (attendee-reviews FR-005). Content is computed from the ReviewAggregate
  // (PLACE) snapshot and CANNOT be edited by the page owner — only the heading
  // is owner-editable. Sits BESIDE `venue_stats` but is clearly distinct: this
  // is what the AUDIENCE reported, that is what PERFORMERS reported.
  audience_stats: {
    kind: "audience_stats",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindAudienceStats",
    category: "place",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
        helpTextKey: "admin.peBlockFieldAudienceStatsHelp",
      },
    ],
  },
  // Role-forked "Rate this venue" CTA (venue-rating-block-and-owner-optin
  // FR-001/FR-002). Mirrors `request_to_play`: owner edits only the heading +
  // an optional intro; the public renderer opens a modal that forks the
  // performer (PlaceReview) and attendee (community + verified upsell) paths.
  rate_venue: {
    kind: "rate_venue",
    ownerTypes: ["PLACE"],
    labelKey: "admin.peBlockKindRateVenue",
    category: "place",
    defaultSpan: 1,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "intro",
        labelKey: "admin.peBlockFieldRateVenueIntro",
        kind: "textarea",
      },
    ],
  },
  team: {
    kind: "team",
    ownerTypes: ["ORGANIZATION"],
    labelKey: "admin.peBlockKindTeam",
    category: "organization",
    defaultSpan: 2,
    defaultData: { members: [] },
    fields: [
      headingField,
      {
        name: "members",
        labelKey: "admin.peBlockFieldTeamMembers",
        kind: "objectList",
      },
    ],
  },
  mission: {
    kind: "mission",
    ownerTypes: ["ORGANIZATION"],
    labelKey: "admin.peBlockKindMission",
    category: "organization",
    defaultSpan: 2,
    defaultData: { content: "" },
    fields: [
      headingField,
      {
        name: "content",
        labelKey: "admin.peBlockFieldContent",
        // Stored as sanitised HTML by the page editor; see the HAZARD note
        // on the `about` / `mission` data schemas above.
        kind: "richText",
        required: true,
      },
    ],
    palette: false,
  },
  managed_places: {
    kind: "managed_places",
    ownerTypes: ["ORGANIZATION"],
    labelKey: "admin.peBlockKindManagedPlaces",
    category: "organization",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
  },
  past_events: {
    kind: "past_events",
    ownerTypes: ["ORGANIZATION"],
    labelKey: "admin.peBlockKindPastEvents",
    category: "events",
    defaultSpan: 2,
    defaultData: {},
    fields: [
      headingField,
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
    palette: false,
  },
} as const satisfies { readonly [K in BlockKind]: BlockConfig<K> };

export type EntityPageBlockConfig = (typeof BLOCK_CONFIGS)[BlockKind];

export function getBlockConfig(
  kind: string,
): EntityPageBlockConfig | undefined {
  return BLOCK_CONFIGS[kind as BlockKind];
}

export function getAllBlockConfigs(): readonly EntityPageBlockConfig[] {
  return Object.values(BLOCK_CONFIGS);
}

function supportsOwnerType(
  config: Pick<BlockConfig, "ownerTypes">,
  ownerType: PageOwnerType,
): boolean {
  return config.ownerTypes.includes(ownerType);
}

export function getValidBlockConfigs(
  ownerType: PageOwnerType,
): readonly EntityPageBlockConfig[] {
  return getAllBlockConfigs().filter((config) =>
    supportsOwnerType(config, ownerType),
  );
}

export function getPaletteBlockConfigs(
  ownerType: PageOwnerType,
): readonly EntityPageBlockConfig[] {
  return getValidBlockConfigs(ownerType).filter(isPaletteVisible);
}

function isPaletteVisible(config: EntityPageBlockConfig): boolean {
  if ("retired" in config && config.retired === true) return false;
  return !("palette" in config) || config.palette !== false;
}

/**
 * True for a kind the page owner may reorder but never remove, hide, or add
 * twice (see `BlockConfig.pinned`). An unknown kind is not pinned.
 */
export function isPinnedBlockKind(kind: string): boolean {
  const config = getBlockConfig(kind);
  return config !== undefined && "pinned" in config && config.pinned === true;
}

/** Every pinned kind, in registry order. */
export function getPinnedBlockKinds(): readonly BlockKind[] {
  return getAllBlockConfigs()
    .filter((config) => "pinned" in config && config.pinned === true)
    .map((config) => config.kind);
}

export function getValidBlockKinds(
  ownerType: PageOwnerType,
): readonly BlockKind[] {
  return getValidBlockConfigs(ownerType).map((config) => config.kind);
}

export function isValidBlockKind(
  ownerType: PageOwnerType,
  kind: string,
): kind is BlockKind {
  const config = getBlockConfig(kind);
  return config ? supportsOwnerType(config, ownerType) : false;
}

export function getDefaultBlockData(kind: string): Record<string, unknown> {
  const config = getBlockConfig(kind);
  if (!config) return {};
  return JSON.parse(JSON.stringify(config.defaultData)) as Record<
    string,
    unknown
  >;
}

export function normalizeBlockData(
  kind: string,
  data: unknown,
): BlockDataValidationResult {
  const config = getBlockConfig(kind);
  if (!config) {
    return { ok: false, issues: ["unknown_block_kind"] };
  }

  const parsedRecord =
    data === undefined
      ? { success: true as const, data: {} }
      : blockObjectSchema.safeParse(data);
  if (!parsedRecord.success) {
    return { ok: false, issues: ["expected_object"] };
  }

  const candidate = {
    ...getDefaultBlockData(kind),
    ...parsedRecord.data,
  };

  const schema = blockDataSchemas[config.kind];
  if (!schema) {
    return { ok: true, data: candidate };
  }

  const result = schema.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      ),
    };
  }

  return { ok: true, data: result.data };
}

/**
 * True when the kind has a data schema. For a kind without one,
 * `normalizeBlockData` returns the candidate UNVALIDATED (any JSON), so a
 * caller that accepts single-field edits (the page editor's draft ops) must
 * refuse them for such kinds rather than store unchecked values.
 */
export function hasBlockDataSchema(kind: string): boolean {
  const config = getBlockConfig(kind);
  return config !== undefined && blockDataSchemas[config.kind] !== undefined;
}

export function getDefaultBlockSpan(kind: string): BlockDefaultSpan {
  return getBlockConfig(kind)?.defaultSpan ?? 2;
}

export function getBlockLabelKey(kind: string): string | undefined {
  return getBlockConfig(kind)?.labelKey;
}
