/**
 * The page draft's op format and merge (page editor spec
 * docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml R2, R9, R14,
 * R19; storage: `model PageDraft` in packages/db/prisma/entity-page.prisma).
 * Pure: no I/O. getPageDraft / savePageDraft / discardPageDraft (step 4b)
 * and publishPageDraft (step 5) call these under the draft row lock.
 *
 * SERVER-ONLY. The Place field schemas come from upsert-place.ts, which
 * imports node:crypto and the search/tax use cases. This module is NOT in
 * the entity-pages barrel (web client code imports that barrel); import it
 * by its subpath, `@th/core/use-cases/entity-pages/page-draft-ops`, from
 * server code only. page-zones.ts is the web-safe half.
 *
 * ── OPS ─────────────────────────────────────────────────────────────────────
 * An op is `{ path, value }` (set the leaf) or `{ path, revert: true }`
 * (drop the leaf, so the live value shows again). A batch is applied in
 * order, atomically: one refused op refuses the batch.
 *
 * ── PATH GRAMMAR (format version 1) ─────────────────────────────────────────
 *   page.<field>                 EntityPage fields the editor owns:
 *                                PAGE_DRAFT_PAGE_FIELDS (slug, bio,
 *                                visibility, allowFollows, showFollowerCount,
 *                                avatarUrl, bannerUrl). Never displayName: a
 *                                venue has ONE name, Place.name.
 *   theme.<field>                PAGE_DRAFT_THEME_FIELDS (colorPrimary,
 *                                colorBg, colorText, fontKey).
 *   place.<field>                Place facts edited in place (R9),
 *                                PAGE_DRAFT_PLACE_FIELDS (name, capacity,
 *                                phone, website, address, locationMode,
 *                                locationRadiusMeters, locationLabel). PLACE
 *                                pages only. `address` is ONE leaf (the whole
 *                                upsertPlace address object): its parts are
 *                                geocoded together, so a per-part merge could
 *                                pair one editor's street with another's pin.
 *   blocks.<blockId>.data.<field>  one field of a block's data. The field must
 *                                be an editable (non-readonly) field of the
 *                                kind's BlockConfig. A list field (links, FAQ
 *                                items, photos) is ONE leaf holding the whole
 *                                list. `null` means "field unset".
 *   blocks.<blockId>.visible     boolean.
 *   blocks.<blockId>.removed     `true`; revert it to restore the block.
 *   blocks.new:<uuid>.kind       adds a block of that kind. Setting
 *                                `blocks.new:<uuid>.removed` drops every
 *                                `blocks.new:<uuid>.*` leaf (the block never
 *                                existed live, so there is nothing to keep).
 *   order.main                   the whole main-column order as ONE leaf: an
 *                                array of block ids (live ids and
 *                                `new:<uuid>`); last write wins on the list.
 *                                It must pass the zone rules as written. A
 *                                block it does not list (added since, by
 *                                another editor) lands at the end of its
 *                                zone (resolveMainOrder), so a concurrent
 *                                add never invalidates someone's reorder.
 *   <blockId> is a live main-section block id or `new:<uuid>`.
 *
 * ── RULES ───────────────────────────────────────────────────────────────────
 * - LEAVES ONLY. Every accepted path is a leaf of the grammar above, and no
 *   stored path may be a strict dot-prefix of another (`theme` vs
 *   `theme.colorBg`, `blocks.X.data` vs `blocks.X.data.heading`). The grammar
 *   refuses non-leaf paths (`path_not_leaf`), and `parseOps` also checks
 *   every path against the stored keys (`path_prefix_conflict`), so the rule
 *   still holds when a later grammar adds nested leaves.
 * - `v` and `v.*` are RESERVED (`path_reserved`): `data.v` is the overlay's
 *   format version, absent = 1. A draft whose version this code does not know
 *   is refused, never guessed at.
 * - Values are validated per path with the schemas the live write paths use
 *   (update-page, update-page-theme, upsert-place, block-config). Rich-text
 *   block fields are sanitised here (lib/page-rich-text.ts), so the draft
 *   never holds unsanitised HTML.
 * - Zone and pinned rules (page-zones.ts, manage-page-blocks.ts) apply to
 *   `order.main`, adds, removes and hides, so the draft never holds an op
 *   Publish would refuse.
 *
 * ── STORAGE ─────────────────────────────────────────────────────────────────
 *   data          path → value for page.*, theme.*, blocks.*, order.main (+ v)
 *   placePatch    field → value for place.* (key without the `place.` prefix)
 *   placeBase     field → live Place value when the draft first set it
 *                 (since the last clear, or since a revert of that field)
 *   fieldEditors  path → { humanId, at (ISO), rev }: last editor of each path
 *                 and the revision that wrote it. Reserved key `$base` →
 *                 { rev }: the revision this overlay started from (the last
 *                 clear, or 0). `rev` per path answers "changed since your
 *                 revision"; `$base` answers "cleared since your revision".
 *                 Reserved key `$pruned` → { rev }: entries for paths no
 *                 longer in the overlay are pruned above
 *                 PAGE_DRAFT_MAX_EDITOR_ENTRIES; a client older than it
 *                 resyncs (changedSince `resync`).
 *                 Open JSON, so no migration (paths never start with `$`).
 *
 * R19: a new draftable field is one row in a field table; per-block styles
 * are a new leaf family (`blocks.<id>.style.<prop>`) in `parsePageDraftPath`
 * plus a table; a freeform layout is a zone-table entry. A change in what
 * existing paths MEAN bumps PAGE_DRAFT_FORMAT_VERSION and adds an upgrade of
 * older overlays on read.
 */

import { z } from "zod";

import { fail } from "@th/errors";
import {
  PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
  type PageBlockRecord,
  type PageDraftRecord,
  type PageOwnerType,
  type WritePageDraftInput,
} from "@th/types/repos/entity-pages";
import type { PlaceRecord } from "@th/types/repos/places";

import { parseInput } from "../../lib/io";
import {
  PAGE_RICH_TEXT_MAX_INPUT_LENGTH,
  isRichTextEmpty,
  parsePageRichText,
  toRichTextHtml,
} from "../../lib/page-rich-text";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { sanitizeText } from "../../lib/slug-utils";
import { upsertPlaceInputSchema } from "../places/upsert-place";
import {
  BLOCK_FIELD_KIND_IMAGE_URLS,
  getBlockConfig,
  getDefaultBlockData,
  getPaletteBlockConfigs,
  hasBlockDataSchema,
  isPinnedBlockKind,
  isValidBlockKind,
  normalizeBlockData,
} from "./block-config";
import { normalizeBlockSection } from "./block-sections";
import type { PinnedRefusal } from "./manage-page-blocks";
import {
  canPlace,
  insertionIndexFor,
  sortByZone,
  zoneOf,
  type PageZoneLayout,
  type PageZoneLock,
} from "./page-zones";
import { entityPageFontKeyInputSchema } from "./theme-options";
import { updatePageInputSchema } from "./update-page";
import { updatePageThemeInputSchema } from "./update-page-theme";

// ── Constants ──────────────────────────────────────────────────────────────

/** The overlay format this code reads and writes (`data.v`, absent = 1). */
export const PAGE_DRAFT_FORMAT_VERSION = 1;
/** Reserved key in `data` holding the format version. */
export const PAGE_DRAFT_VERSION_KEY = "v";
/** Most ops one batch may carry. */
export const PAGE_DRAFT_MAX_OPS = 200;
/** Longest op path. */
export const PAGE_DRAFT_MAX_PATH_LENGTH = 200;
/** Most ids `order.main` may hold. */
export const PAGE_DRAFT_MAX_ORDER_LENGTH = 500;
/** Short bio under the name (R11, FR-021). */
export const PAGE_BIO_MAX_LENGTH = 280;
/** Id prefix of a block added in the draft. */
export const PAGE_DRAFT_NEW_BLOCK_PREFIX = "new:";
/** Reserved fieldEditors key: the revision the current overlay started at. */
export const PAGE_DRAFT_EDITORS_BASE_KEY = "$base";
/**
 * Reserved fieldEditors key: the newest revision whose editor entries were
 * pruned (see mergeOps). A client older than it must resync.
 */
export const PAGE_DRAFT_EDITORS_PRUNED_KEY = "$pruned";
/**
 * Most leaves `data` may hold (v excluded). A real venue page is about a
 * hundred (fifteen blocks of a few fields, plus page, theme and order); the
 * cap stops a draft growing without bound through adds.
 */
export const PAGE_DRAFT_MAX_LEAVES = 1_000;
/** Largest `data` overlay, in characters of its JSON. */
export const PAGE_DRAFT_MAX_DATA_JSON_LENGTH = 1_000_000;
/**
 * Most fieldEditors entries kept ($base excluded). Entries for paths no
 * longer in the overlay (reverted, or leaves of a removed new block) are
 * pruned oldest first above this; see mergeOps.
 */
export const PAGE_DRAFT_MAX_EDITOR_ENTRIES = PAGE_DRAFT_MAX_LEAVES;

/** Batch ids (idempotency keys) must be UUIDs. */
export const pageDraftBatchIdSchema = z.string().uuid();

const uuidSchema = z.string().uuid();

// ── Field tables (data: one row per draftable field) ───────────────────────

type DraftFieldSpec = {
  schema: z.ZodType;
  /** Value is an image URL the page owns (checked by ctx.isAllowedImageUrl). */
  imageUrl?: boolean;
  // Block fields need no flag: an image-holding block field is found by its
  // BlockConfig field KIND (BLOCK_FIELD_KIND_IMAGE_URLS) and checked by
  // ctx.isAllowedBlockImageUrl.
};

const pageImageUrlSchema = updatePageInputSchema.shape.avatarUrl.refine(
  (value) => value == null || /^https?:\/\//i.test(value),
  { message: "expected_http_url" },
);

// A slug must already be canonical: what `/places/[slug]` resolves on is a
// single lowercase segment, the form `sanitizeText` produces (it is how
// `buildPageSlug` mints them).
const pageSlugSchema = updatePageInputSchema.shape.slug.refine(
  (value) => value === undefined || sanitizeText(value) === value,
  { message: "slug_not_canonical" },
);

export const PAGE_DRAFT_PAGE_FIELDS = {
  slug: { schema: pageSlugSchema },
  bio: {
    schema: plainTextMultilineOptional(PAGE_BIO_MAX_LENGTH).nullable(),
  },
  visibility: { schema: updatePageInputSchema.shape.visibility },
  allowFollows: { schema: z.boolean() },
  showFollowerCount: { schema: z.boolean() },
  avatarUrl: { schema: pageImageUrlSchema, imageUrl: true },
  bannerUrl: { schema: pageImageUrlSchema, imageUrl: true },
} as const satisfies Record<string, DraftFieldSpec>;

/**
 * Theme leaves. `layoutKey` is deliberately absent: switching to a freeform
 * layout is a later phase (R7); it becomes one row here plus a zone table.
 */
export const PAGE_DRAFT_THEME_FIELDS = {
  colorPrimary: { schema: updatePageThemeInputSchema.shape.colorPrimary },
  colorBg: { schema: updatePageThemeInputSchema.shape.colorBg },
  colorText: { schema: updatePageThemeInputSchema.shape.colorText },
  fontKey: { schema: entityPageFontKeyInputSchema },
} as const satisfies Record<string, DraftFieldSpec>;

const placeShape = upsertPlaceInputSchema.shape;

/** Place facts edited on the canvas (R9), validated as upsertPlace does. */
export const PAGE_DRAFT_PLACE_FIELDS = {
  name: { schema: placeShape.name },
  capacity: { schema: placeShape.capacity },
  phone: { schema: placeShape.phone },
  website: { schema: placeShape.website },
  address: { schema: placeShape.address },
  locationMode: { schema: placeShape.locationMode },
  locationRadiusMeters: { schema: placeShape.locationRadiusMeters },
  locationLabel: { schema: placeShape.locationLabel },
} as const satisfies Record<string, DraftFieldSpec>;

export type PageDraftPageField = keyof typeof PAGE_DRAFT_PAGE_FIELDS;
export type PageDraftThemeField = keyof typeof PAGE_DRAFT_THEME_FIELDS;
export type PageDraftPlaceField = keyof typeof PAGE_DRAFT_PLACE_FIELDS;

const BLOCK_PROPS = ["kind", "visible", "removed"] as const;
type BlockProp = (typeof BLOCK_PROPS)[number];

// ── Paths ──────────────────────────────────────────────────────────────────

export type PageDraftTarget =
  | { area: "page"; field: PageDraftPageField }
  | { area: "theme"; field: PageDraftThemeField }
  | { area: "place"; field: PageDraftPlaceField }
  | { area: "block"; blockId: string; isNew: boolean; prop: BlockProp }
  | { area: "blockData"; blockId: string; isNew: boolean; field: string }
  | { area: "order"; list: "main" };

export type PageDraftPathError =
  | "path_reserved"
  | "path_not_leaf"
  | "path_unknown"
  | "block_id_invalid";

function hasOwn<T extends object>(
  table: T,
  key: string,
): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/** Parse a path against the grammar (see the module comment). */
export function parsePageDraftPath(
  path: string,
):
  | { ok: true; target: PageDraftTarget }
  | { ok: false; code: PageDraftPathError } {
  if (
    path === PAGE_DRAFT_VERSION_KEY ||
    path.startsWith(`${PAGE_DRAFT_VERSION_KEY}.`)
  ) {
    return { ok: false, code: "path_reserved" };
  }
  const segments = path.split(".");
  const [area, second, third, fourth] = segments;
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, code: "path_unknown" };
  }

  if (area === "page" || area === "theme" || area === "place") {
    if (segments.length === 1) return { ok: false, code: "path_not_leaf" };
    if (segments.length > 2) return { ok: false, code: "path_unknown" };
    const field = second!;
    if (area === "page" && hasOwn(PAGE_DRAFT_PAGE_FIELDS, field)) {
      return { ok: true, target: { area, field } };
    }
    if (area === "theme" && hasOwn(PAGE_DRAFT_THEME_FIELDS, field)) {
      return { ok: true, target: { area, field } };
    }
    if (area === "place" && hasOwn(PAGE_DRAFT_PLACE_FIELDS, field)) {
      return { ok: true, target: { area, field } };
    }
    return { ok: false, code: "path_unknown" };
  }

  if (area === "order") {
    if (segments.length === 1) return { ok: false, code: "path_not_leaf" };
    if (segments.length === 2 && second === "main") {
      return { ok: true, target: { area: "order", list: "main" } };
    }
    return { ok: false, code: "path_unknown" };
  }

  if (area === "blocks") {
    if (segments.length <= 2) return { ok: false, code: "path_not_leaf" };
    const blockId = second!;
    const isNew = blockId.startsWith(PAGE_DRAFT_NEW_BLOCK_PREFIX);
    if (
      isNew &&
      !uuidSchema.safeParse(blockId.slice(PAGE_DRAFT_NEW_BLOCK_PREFIX.length))
        .success
    ) {
      return { ok: false, code: "block_id_invalid" };
    }
    if (third === "data") {
      if (segments.length === 3) return { ok: false, code: "path_not_leaf" };
      if (segments.length === 4) {
        return {
          ok: true,
          target: { area: "blockData", blockId, isNew, field: fourth! },
        };
      }
      return { ok: false, code: "path_unknown" };
    }
    if (
      segments.length === 3 &&
      (BLOCK_PROPS as readonly string[]).includes(third!)
    ) {
      return {
        ok: true,
        target: { area: "block", blockId, isNew, prop: third as BlockProp },
      };
    }
    return { ok: false, code: "path_unknown" };
  }

  return { ok: false, code: "path_unknown" };
}

function isStrictDotPrefix(prefix: string, path: string): boolean {
  return path.length > prefix.length && path.startsWith(`${prefix}.`);
}

/** A stored key that `path` is a strict prefix of, or that is one of `path`. */
function findPrefixConflict(
  path: string,
  keys: Iterable<string>,
): string | null {
  for (const key of keys) {
    if (isStrictDotPrefix(path, key) || isStrictDotPrefix(key, path))
      return key;
  }
  return null;
}

// ── Version ────────────────────────────────────────────────────────────────

/** The overlay's format version: `data.v`, absent = 1; NaN when malformed. */
export function draftFormatVersion(data: Record<string, unknown>): number {
  const raw = data[PAGE_DRAFT_VERSION_KEY];
  if (raw === undefined) return 1;
  return typeof raw === "number" && Number.isInteger(raw) ? raw : Number.NaN;
}

function assertSupportedVersion(data: Record<string, unknown>): void {
  const version = draftFormatVersion(data);
  if (version !== PAGE_DRAFT_FORMAT_VERSION) {
    fail("INTERNAL", {
      message: `page draft format version ${String(data[PAGE_DRAFT_VERSION_KEY])} is not supported (this code reads ${PAGE_DRAFT_FORMAT_VERSION})`,
    });
  }
}

// ── Parsed ops and errors ──────────────────────────────────────────────────

export type ParsedPageDraftOp =
  | { op: "set"; path: string; target: PageDraftTarget; value: unknown }
  | { op: "revert"; path: string; target: PageDraftTarget };

export type PageDraftOpErrorCode =
  | "ops_not_array"
  | "ops_empty"
  | "ops_too_many"
  | "draft_version_unsupported"
  | "op_malformed"
  | PageDraftPathError
  | "path_prefix_conflict"
  | "path_not_for_owner"
  /**
   * A community moderator set or reverted a `place.*` path, or published a
   * draft holding a Place patch: Place facts are not page
   * content, and a moderator changes them through `updateCommunityPlace`
   * and its rules (moderator place page spec, D3). Refused by savePageDraft
   * and publishPageDraft, not by parseOps (which does not know the actor).
   */
  | "place_fact_not_for_moderator"
  | "value_invalid"
  | "image_url_not_allowed"
  | "rich_text_too_long"
  | "block_not_found"
  | "block_kind_invalid"
  | "block_kind_not_addable"
  | "block_kind_immutable"
  | "block_field_unknown"
  | "block_pinned"
  | "revert_not_allowed"
  | "order_invalid"
  | "draft_too_large"
  | "zone_order"
  | "not_on_layout";

export type PageDraftOpError = {
  /** Index of the op in the batch; -1 for a batch-level refusal. */
  index: number;
  path: string | null;
  code: PageDraftOpErrorCode;
  meta?: {
    /** block_pinned: what was refused (manage-page-blocks vocabulary). */
    attempted?: PinnedRefusal;
    kind?: string;
    blockId?: string;
    /** zone_order: the kind it may not follow, and the fixed zone's lock. */
    after?: string;
    lock?: PageZoneLock;
    /** value_invalid: zod issue messages. */
    issues?: string[];
    /** rich_text_too_long: the cap. */
    max?: number;
    /** path_prefix_conflict: the stored path it collides with. */
    conflictsWith?: string;
    /** draft_too_large: the cap that was hit. */
    maxLeaves?: number;
    maxJsonLength?: number;
  };
};

export type ParsePageDraftOpsResult =
  | { ok: true; ops: ParsedPageDraftOp[] }
  | { ok: false; errors: PageDraftOpError[] };

export type PageDraftOpsContext = {
  ownerType: PageOwnerType;
  /** The page's zone table (resolvePageZoneLayout). */
  layout: PageZoneLayout;
  /** The page's live blocks (every section; only "main" ones are draftable). */
  liveBlocks: readonly Pick<PageBlockRecord, "id" | "kind" | "section">[];
  /**
   * The draft the batch applies to. In savePageDraft this MUST be the record
   * returned by lockDraftForUpdate in the same transaction, so validation and
   * merge see the same state. null = no draft row.
   */
  draft: Pick<PageDraftRecord, "data"> | null;
  /**
   * Whether an avatar / banner URL may be stored: it must be an upload this
   * page owns (under its storage key prefix), so Discard can clean it up and
   * nobody can point a page at someone else's object.
   *
   * IMPLEMENTERS (savePageDraft): decide on the PARSED URL, never with
   * `startsWith` on the raw string. Compare `origin` exactly with the
   * storage origin and `pathname` with the page's key prefix, and refuse a
   * URL whose raw form or pathname contains `..`, `%2e` / `%2E`, a backslash
   * or userinfo (`user:pass@`), any of which can make a prefix check pass for
   * an object outside the prefix.
   */
  isAllowedImageUrl: (url: string, field: string) => boolean;
  /**
   * Whether an image URL may stand in an image-holding BLOCK field (any
   * field whose BlockConfig kind is in BLOCK_FIELD_KIND_IMAGE_URLS: today
   * `imageList`, the Photos list). savePageDraft and publishPageDraft allow
   * exactly two things: one of this page's own canonical, metadata-stripped
   * upload URLs (`ownedStrippedPageImageKeyFromUrl`: a `?w=800` variant of
   * an owned key and a raw upload key are refused), or a URL already present
   * in an image field of the LIVE page (outside photos a page already
   * shows keep working). A new
   * outside URL is refused. Without it, a key Discard queued for deletion
   * could come back as a variant URL the cancel scan cannot be relied on to
   * treat as the same object.
   */
  isAllowedBlockImageUrl: (url: string) => boolean;
};

// ── Working state (shared by parseOps' simulation and mergeOps) ────────────

type WorkingState = {
  data: Record<string, unknown>;
  placePatch: Record<string, unknown>;
};

function newBlockKindPath(blockId: string): string {
  return `blocks.${blockId}.kind`;
}

/** Ids and kinds of the blocks added in this overlay, from `blocks.new:*.kind`. */
function newBlockKinds(data: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [path, value] of Object.entries(data)) {
    const match = /^blocks\.(new:[^.]+)\.kind$/.exec(path);
    if (match && typeof value === "string") result.set(match[1]!, value);
  }
  return result;
}

function isRemoved(data: Record<string, unknown>, blockId: string): boolean {
  return data[`blocks.${blockId}.removed`] === true;
}

/**
 * Apply one already-validated op to the working state. Returns every path
 * the op changed (a new-block removal changes all of that block's leaves).
 */
function applyOp(state: WorkingState, op: ParsedPageDraftOp): string[] {
  const { target } = op;
  if (target.area === "place") {
    if (op.op === "set") state.placePatch[target.field] = op.value;
    else delete state.placePatch[target.field];
    return [op.path];
  }
  if (
    op.op === "set" &&
    target.area === "block" &&
    target.prop === "removed" &&
    target.isNew
  ) {
    const prefix = `blocks.${target.blockId}.`;
    const purged = Object.keys(state.data).filter((path) =>
      path.startsWith(prefix),
    );
    for (const path of purged) delete state.data[path];
    return [...purged, op.path];
  }
  if (op.op === "set") state.data[op.path] = op.value;
  else delete state.data[op.path];
  return [op.path];
}

// ── parseOps ───────────────────────────────────────────────────────────────

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0
      ? `${issue.path.join(".")}: ${issue.message}`
      : issue.message,
  );
}

function parseRawOp(
  raw: unknown,
): { path: string; revert: boolean; value: unknown } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => key !== "path" && key !== "value" && key !== "revert")
  ) {
    return null;
  }
  const { path } = record;
  if (typeof path !== "string" || path.length === 0) return null;
  if (path.length > PAGE_DRAFT_MAX_PATH_LENGTH) return null;
  const hasValue = "value" in record && record.value !== undefined;
  const hasRevert = "revert" in record;
  if (hasValue === hasRevert) return null;
  if (hasRevert && record.revert !== true) return null;
  return { path, revert: hasRevert, value: record.value };
}

type OpCheck =
  | { ok: true; value?: unknown }
  | { ok: false; error: Omit<PageDraftOpError, "index" | "path"> };

const refuse = (
  code: PageDraftOpErrorCode,
  meta?: PageDraftOpError["meta"],
): OpCheck => ({ ok: false, error: meta ? { code, meta } : { code } });

function checkFieldValue(
  field: string,
  spec: DraftFieldSpec,
  value: unknown,
  ctx: PageDraftOpsContext,
): OpCheck {
  const parsed = spec.schema.safeParse(value);
  if (!parsed.success)
    return refuse("value_invalid", { issues: zodIssues(parsed.error) });
  if (parsed.data === undefined)
    return refuse("value_invalid", { issues: ["required"] });
  if (
    spec.imageUrl &&
    typeof parsed.data === "string" &&
    !ctx.isAllowedImageUrl(parsed.data, field)
  ) {
    return refuse("image_url_not_allowed");
  }
  return { ok: true, value: parsed.data };
}

type BlockView = { kind: string; isNew: boolean; removed: boolean };

function findBlock(
  blockId: string,
  isNew: boolean,
  state: WorkingState,
  liveMain: ReadonlyMap<string, string>,
): BlockView | null {
  if (isNew) {
    const kind = state.data[newBlockKindPath(blockId)];
    return typeof kind === "string"
      ? { kind, isNew: true, removed: false }
      : null;
  }
  const kind = liveMain.get(blockId);
  return kind === undefined
    ? null
    : { kind, isNew: false, removed: isRemoved(state.data, blockId) };
}

/** Main-column kinds present (not removed) in live + draft, for pinned checks. */
function presentKinds(
  state: WorkingState,
  liveMain: ReadonlyMap<string, string>,
): string[] {
  const kinds: string[] = [];
  for (const [id, kind] of liveMain) {
    if (!isRemoved(state.data, id)) kinds.push(kind);
  }
  for (const kind of newBlockKinds(state.data).values()) kinds.push(kind);
  return kinds;
}

/** Raw rich-text characters one batch may carry, across all its ops. */
type BatchBudget = { richTextChars: number };

/**
 * One block field. Rich-text fields (`kind: "richText"` in BlockConfig:
 * about.content, mission.content) are sanitised here by page-rich-text
 * (`parsePageRichText`, against the batch's one rich-text budget) and stored
 * as HTML. HAZARD: block-config's data schemas for those fields are still
 * PLAIN TEXT (the old editor's path), which strips every tag, so a rich-text
 * value never goes through `normalizeBlockData`, here or in Publish; step 7
 * changes those schemas with the renderer. Image-holding fields (found by field
 * kind) must pass `ctx.isAllowedBlockImageUrl` for every URL.
 */
function checkBlockDataValue(
  kind: string,
  field: string,
  value: unknown,
  budget: BatchBudget,
  ctx: Pick<PageDraftOpsContext, "isAllowedBlockImageUrl">,
): OpCheck {
  const config = getBlockConfig(kind);
  const fieldConfig = config?.fields.find(
    (candidate) => candidate.name === field,
  );
  if (
    !fieldConfig ||
    fieldConfig.kind === "readonly" ||
    !hasBlockDataSchema(kind)
  ) {
    return refuse("block_field_unknown", { kind });
  }
  if (value === null) return { ok: true, value: null };
  if (fieldConfig.kind === "richText") {
    if (typeof value !== "string") {
      return refuse("value_invalid", { issues: ["expected_string"] });
    }
    // Sanitising cost is per character (and worse with nesting), so a batch
    // gets one rich-text budget, not one per op.
    budget.richTextChars += value.length;
    if (budget.richTextChars > PAGE_RICH_TEXT_MAX_INPUT_LENGTH) {
      return refuse("rich_text_too_long", {
        max: PAGE_RICH_TEXT_MAX_INPUT_LENGTH,
      });
    }
    const rich = parsePageRichText(value);
    if (!rich.ok) return refuse("rich_text_too_long", { max: rich.max });
    return { ok: true, value: rich.html };
  }
  const normalized = normalizeBlockData(kind, { [field]: value });
  if (!normalized.ok)
    return refuse("value_invalid", { issues: [...normalized.issues] });
  const next = normalized.data[field];
  const imageUrls =
    BLOCK_FIELD_KIND_IMAGE_URLS[fieldConfig.kind]?.(next) ?? [];
  if (imageUrls.some((url) => !ctx.isAllowedBlockImageUrl(url))) {
    return refuse("image_url_not_allowed", { kind });
  }
  return { ok: true, value: next === undefined ? null : next };
}

/**
 * One block-data leaf value, validated exactly as savePageDraft validates it
 * (the kind's data schema, rich-text sanitising, the image-URL rule), outside
 * a batch: publishPageDraft re-checks every leaf it writes with this. Rich
 * text is capped per value here (`parsePageRichText`'s caps), not by a
 * batch's shared budget. `null` (field unset) is valid.
 */
export function checkBlockFieldValue(
  kind: string,
  field: string,
  value: unknown,
  isAllowedBlockImageUrl: (url: string) => boolean,
):
  | { ok: true; value: unknown }
  | { ok: false; code: PageDraftOpErrorCode; meta?: PageDraftOpError["meta"] } {
  const check = checkBlockDataValue(
    kind,
    field,
    value,
    { richTextChars: 0 },
    { isAllowedBlockImageUrl },
  );
  return check.ok
    ? { ok: true, value: check.value }
    : { ok: false, ...check.error };
}

function checkOrder(
  value: unknown,
  state: WorkingState,
  liveMain: ReadonlyMap<string, string>,
  ctx: PageDraftOpsContext,
): OpCheck {
  if (
    !Array.isArray(value) ||
    value.length > PAGE_DRAFT_MAX_ORDER_LENGTH ||
    value.some((id) => typeof id !== "string") ||
    new Set(value).size !== value.length
  ) {
    return refuse("order_invalid");
  }
  const added = newBlockKinds(state.data);
  // A `new:` id the draft no longer has (another editor removed that new
  // block meanwhile) is dropped, not refused: refusing would reject this
  // editor's whole reorder over a block that is gone anyway. An unknown LIVE
  // id is still refused.
  const ids = (value as string[]).filter(
    (id) => !id.startsWith(PAGE_DRAFT_NEW_BLOCK_PREFIX) || added.has(id),
  );
  const kinds: string[] = [];
  for (const id of ids) {
    const kind = added.get(id) ?? liveMain.get(id);
    if (kind === undefined) return refuse("block_not_found", { blockId: id });
    if (!added.has(id) && isRemoved(state.data, id)) continue;
    kinds.push(kind);
  }
  const check = canPlace(kinds, ctx.layout);
  if (!check.ok) {
    return refuse(check.reason, {
      kind: check.kind,
      ...(check.after !== undefined && { after: check.after }),
      ...(check.lock !== undefined && { lock: check.lock }),
    });
  }
  return { ok: true, value: [...ids] };
}

function checkSet(
  target: PageDraftTarget,
  value: unknown,
  state: WorkingState,
  liveMain: ReadonlyMap<string, string>,
  ctx: PageDraftOpsContext,
  budget: BatchBudget,
): OpCheck {
  switch (target.area) {
    case "page":
      return checkFieldValue(
        target.field,
        PAGE_DRAFT_PAGE_FIELDS[target.field],
        value,
        ctx,
      );
    case "theme":
      return checkFieldValue(
        target.field,
        PAGE_DRAFT_THEME_FIELDS[target.field],
        value,
        ctx,
      );
    case "place":
      return checkFieldValue(
        target.field,
        PAGE_DRAFT_PLACE_FIELDS[target.field],
        value,
        ctx,
      );
    case "order":
      return checkOrder(value, state, liveMain, ctx);
    case "blockData": {
      const block = findBlock(target.blockId, target.isNew, state, liveMain);
      if (!block) return refuse("block_not_found", { blockId: target.blockId });
      return checkBlockDataValue(
        block.kind,
        target.field,
        value,
        budget,
        ctx,
      );
    }
    case "block": {
      if (target.prop === "kind") {
        if (!target.isNew)
          return refuse("block_kind_immutable", { blockId: target.blockId });
        if (typeof value !== "string") {
          return refuse("value_invalid", { issues: ["expected_string"] });
        }
        const existing = state.data[newBlockKindPath(target.blockId)];
        if (existing !== undefined) {
          return existing === value
            ? { ok: true, value }
            : refuse("block_kind_immutable", {
                blockId: target.blockId,
                kind: value,
              });
        }
        if (!isValidBlockKind(ctx.ownerType, value)) {
          return refuse("block_kind_invalid", { kind: value });
        }
        if (zoneOf(value, ctx.layout).where === "none") {
          return refuse("not_on_layout", { kind: value });
        }
        if (isPinnedBlockKind(value)) {
          // Pinned: one per page, added only as the recovery path when the
          // page has none (managePageBlocks "add").
          if (presentKinds(state, liveMain).includes(value)) {
            return refuse("block_pinned", {
              kind: value,
              attempted: "add_duplicate",
            });
          }
          return { ok: true, value };
        }
        if (
          !getPaletteBlockConfigs(ctx.ownerType).some(
            (config) => config.kind === value,
          )
        ) {
          return refuse("block_kind_not_addable", { kind: value });
        }
        return { ok: true, value };
      }

      const block = findBlock(target.blockId, target.isNew, state, liveMain);
      if (!block) return refuse("block_not_found", { blockId: target.blockId });
      if (target.prop === "visible") {
        if (typeof value !== "boolean") {
          return refuse("value_invalid", { issues: ["expected_boolean"] });
        }
        if (value === false && isPinnedBlockKind(block.kind)) {
          return refuse("block_pinned", {
            kind: block.kind,
            attempted: block.isNew ? "add_hidden" : "hide",
          });
        }
        return { ok: true, value };
      }
      // removed
      if (value !== true)
        return refuse("value_invalid", { issues: ["expected_true"] });
      // A pinned block added only in the draft was never live: dropping it
      // undoes the add, which removes nothing visitors have.
      if (isPinnedBlockKind(block.kind) && !block.isNew) {
        return refuse("block_pinned", {
          kind: block.kind,
          attempted: "delete",
        });
      }
      return { ok: true, value: true };
    }
  }
}

/**
 * Validate and normalise a raw op batch against the draft it will apply to.
 * Ops are checked in order against the state the earlier ops leave (an add
 * followed by edits of the new block and an `order.main` that places it is
 * one valid batch). All-or-nothing: any error refuses the batch; every
 * error is reported, with its op index and a code.
 *
 * Call `isBatchApplied` first: a retry of an applied batch must be answered
 * as deduped, never re-validated (see there).
 */
export function parseOps(
  rawOps: unknown,
  ctx: PageDraftOpsContext,
): ParsePageDraftOpsResult {
  if (!Array.isArray(rawOps)) {
    return {
      ok: false,
      errors: [{ index: -1, path: null, code: "ops_not_array" }],
    };
  }
  if (rawOps.length === 0) {
    return {
      ok: false,
      errors: [{ index: -1, path: null, code: "ops_empty" }],
    };
  }
  if (rawOps.length > PAGE_DRAFT_MAX_OPS) {
    return {
      ok: false,
      errors: [{ index: -1, path: null, code: "ops_too_many" }],
    };
  }
  const storedData = ctx.draft?.data ?? {};
  if (draftFormatVersion(storedData) !== PAGE_DRAFT_FORMAT_VERSION) {
    return {
      ok: false,
      errors: [{ index: -1, path: null, code: "draft_version_unsupported" }],
    };
  }

  const liveMain = new Map<string, string>();
  for (const block of ctx.liveBlocks) {
    if (normalizeBlockSection(block.section) === "main")
      liveMain.set(block.id, block.kind);
  }

  const state: WorkingState = { data: { ...storedData }, placePatch: {} };
  const ops: ParsedPageDraftOp[] = [];
  const errors: PageDraftOpError[] = [];
  const budget: BatchBudget = { richTextChars: 0 };

  rawOps.forEach((raw, index) => {
    const shape = parseRawOp(raw);
    if (!shape) {
      const path =
        raw &&
        typeof raw === "object" &&
        typeof (raw as { path?: unknown }).path === "string"
          ? (raw as { path: string }).path
          : null;
      errors.push({ index, path, code: "op_malformed" });
      return;
    }
    const { path } = shape;
    const parsedPath = parsePageDraftPath(path);
    if (!parsedPath.ok) {
      errors.push({ index, path, code: parsedPath.code });
      return;
    }
    const { target } = parsedPath;
    if (target.area === "place" && ctx.ownerType !== "PLACE") {
      errors.push({ index, path, code: "path_not_for_owner" });
      return;
    }
    const storedPaths = [
      ...Object.keys(state.data),
      ...Object.keys(state.placePatch).map((field) => `place.${field}`),
    ];
    const conflict = findPrefixConflict(path, storedPaths);
    if (conflict !== null) {
      errors.push({
        index,
        path,
        code: "path_prefix_conflict",
        meta: { conflictsWith: conflict },
      });
      return;
    }

    let parsed: ParsedPageDraftOp;
    if (shape.revert) {
      // A new block's kind is undone by removing the block; a new block's
      // removal cannot be undone by a revert (its leaves are gone): re-add it.
      if (
        target.area === "block" &&
        (target.prop === "kind" || (target.prop === "removed" && target.isNew))
      ) {
        errors.push({ index, path, code: "revert_not_allowed" });
        return;
      }
      parsed = { op: "revert", path, target };
    } else {
      const check = checkSet(target, shape.value, state, liveMain, ctx, budget);
      if (!check.ok) {
        errors.push({ index, path, ...check.error });
        return;
      }
      parsed = { op: "set", path, target, value: check.value };
    }
    applyOp(state, parsed);
    ops.push(parsed);
  });

  if (errors.length > 0) return { ok: false, errors };

  // A batch is refused only when it takes the draft over a cap AND grows it:
  // a draft already over (e.g. a cap lowered later) still accepts edits that
  // keep or shrink it, so its editors can work their way back down.
  const before = draftSize(storedData);
  const after = draftSize(state.data);
  const growsPastLeaves =
    after.leaves > PAGE_DRAFT_MAX_LEAVES && after.leaves > before.leaves;
  const growsPastJson =
    after.jsonLength > PAGE_DRAFT_MAX_DATA_JSON_LENGTH &&
    after.jsonLength > before.jsonLength;
  if (growsPastLeaves || growsPastJson) {
    return {
      ok: false,
      errors: [
        {
          index: -1,
          path: null,
          code: "draft_too_large",
          meta: {
            maxLeaves: PAGE_DRAFT_MAX_LEAVES,
            maxJsonLength: PAGE_DRAFT_MAX_DATA_JSON_LENGTH,
          },
        },
      ],
    };
  }
  return { ok: true, ops };
}

function draftSize(data: Record<string, unknown>): {
  leaves: number;
  jsonLength: number;
} {
  return {
    leaves: Object.keys(data).filter((path) => path !== PAGE_DRAFT_VERSION_KEY)
      .length,
    jsonLength: JSON.stringify(data).length,
  };
}

// ── mergeOps ───────────────────────────────────────────────────────────────

/** Who last wrote a path, and in which revision. */
export type PageDraftFieldEditor = { humanId: string; at: string; rev: number };

/** Live Place values in the draft's field shape (see placeDraftFactsFromRecord). */
export type PlaceDraftFacts = Record<PageDraftPlaceField, unknown>;

export type MergePageDraftMeta = {
  /** The batch's idempotency key (UUID). */
  batchId: string;
  actorHumanId: string;
  now: Date;
  /**
   * Live Place facts, used as placeBase for each `place.*` field this batch
   * sets for the first time. Required when the batch sets a `place.*` path;
   * null for pages without a Place. savePageDraft reads them WITHOUT a Place
   * lock (under the draft row lock only): a Settings edit can land between
   * that read and the commit, which is safe because placeBase only feeds
   * Publish's conflict check, and Publish re-reads Place under the
   * place-location lock and compares (a stale base shows as a conflict, never
   * as a silent overwrite).
   */
  placeLive: PlaceDraftFacts | null;
};

export type MergePageDraftResult =
  | { deduped: true }
  | {
      deduped: false;
      /** The full next row state for `writeDraft`. */
      next: WritePageDraftInput;
      /** Every path this batch changed (for "your changes saved" echoes). */
      touchedPaths: string[];
    };

/**
 * Was this batch already applied to the locked draft? The idempotency check,
 * and it comes FIRST. savePageDraft calls it right after lockDraftForUpdate
 * and BEFORE parseOps, and answers a retry from it without validating: a
 * retried batch is validated against the state it already produced, where
 * it can fail (a retried "remove new block" finds the block gone, and the
 * client would be told its applied removal failed). appliedBatchIds survive
 * a Publish / Discard clear, so a retry after a clear is recognised too.
 * Throws `invalid_input` for a batch id that is not a UUID.
 */
export function isBatchApplied(
  locked: Pick<PageDraftRecord, "appliedBatchIds"> | null,
  batchId: string,
): boolean {
  const id = parseInput(pageDraftBatchIdSchema, batchId);
  return locked !== null && locked.appliedBatchIds.includes(id);
}

/**
 * Merge a parsed batch into the locked draft: last write wins per path;
 * fieldEditors[path] = { humanId, at, rev }; placeBase[field] taken from
 * placeLive on the field's first set since the last clear or since its last
 * revert, never overwritten while the field stays patched (a revert drops
 * both patch and base, so the next set starts from the live value then);
 * batch id appended and the list trimmed to the newest
 * PAGE_DRAFT_APPLIED_BATCH_IDS_MAX; revision + 1. A batch id already applied
 * returns `{ deduped: true }` and changes nothing (a backstop: callers check
 * `isBatchApplied` before parseOps, see there).
 *
 * `ops` must come from `parseOps` run against this same `locked` record.
 * Throws `invalid_input` for a batch id that is not a UUID, and INTERNAL for
 * a caller bug (unsupported draft version, place op without placeLive).
 */
export function mergeOps(
  locked: PageDraftRecord,
  ops: readonly ParsedPageDraftOp[],
  meta: MergePageDraftMeta,
): MergePageDraftResult {
  const batchId = parseInput(pageDraftBatchIdSchema, meta.batchId);
  if (isBatchApplied(locked, batchId)) return { deduped: true };
  assertSupportedVersion(locked.data);

  const revision = locked.revision + 1;
  const state: WorkingState = {
    data: { ...locked.data },
    placePatch: { ...locked.placePatch },
  };
  const placeBase: Record<string, unknown> = { ...locked.placeBase };
  const fieldEditors: Record<string, unknown> = { ...locked.fieldEditors };
  if (!(PAGE_DRAFT_EDITORS_BASE_KEY in fieldEditors)) {
    // First write since the last clear (or ever): the overlay starts here.
    fieldEditors[PAGE_DRAFT_EDITORS_BASE_KEY] = { rev: locked.revision };
  }
  const stamp: PageDraftFieldEditor = {
    humanId: meta.actorHumanId,
    at: meta.now.toISOString(),
    rev: revision,
  };

  const touched = new Set<string>();
  for (const op of ops) {
    if (op.op === "set" && op.target.area === "place") {
      const field = op.target.field;
      if (!(field in placeBase)) {
        if (meta.placeLive === null || !(field in meta.placeLive)) {
          fail("INTERNAL", {
            message: `mergeOps: place.${field} set without its live value (placeLive)`,
          });
        }
        placeBase[field] = meta.placeLive[field] ?? null;
      }
    } else if (op.op === "revert" && op.target.area === "place") {
      // Back to live: the next set takes a fresh base, so a Settings edit
      // made while the field was not patched is not a conflict.
      delete placeBase[op.target.field];
    }
    for (const path of applyOp(state, op)) {
      touched.add(path);
      fieldEditors[path] = stamp;
    }
  }
  pruneFieldEditors(fieldEditors, state);

  return {
    deduped: false,
    next: {
      data: state.data,
      placePatch: state.placePatch,
      placeBase,
      fieldEditors,
      appliedBatchIds: [...locked.appliedBatchIds, batchId].slice(
        -PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
      ),
      revision,
      updatedByHumanId: meta.actorHumanId,
    },
    touchedPaths: [...touched],
  };
}

/**
 * Keep fieldEditors bounded. Entries for paths still in the overlay always
 * stay (at most PAGE_DRAFT_MAX_LEAVES + the place fields). Entries for paths
 * gone from it (a revert, or the leaves of a removed new block) only tell
 * other clients "this changed back"; above the cap the oldest go first, and
 * `$pruned` records the newest pruned revision. A client older than that is
 * told `resync` by changedSince and takes the server's whole overlay, so a
 * pruned signal is never silently lost.
 */
function pruneFieldEditors(
  fieldEditors: Record<string, unknown>,
  state: WorkingState,
): void {
  const paths = Object.keys(fieldEditors).filter(
    (path) => !path.startsWith("$"),
  );
  let excess = paths.length - PAGE_DRAFT_MAX_EDITOR_ENTRIES;
  if (excess <= 0) return;
  const present = (path: string) =>
    path in state.data ||
    (path.startsWith("place.") && path.slice(6) in state.placePatch);
  const stale = paths
    .filter((path) => !present(path))
    .map((path) => ({ path, rev: readEditor(fieldEditors[path]).rev ?? 0 }))
    .sort((a, b) => a.rev - b.rev);
  let pruned = readEditor(fieldEditors[PAGE_DRAFT_EDITORS_PRUNED_KEY]).rev ?? 0;
  for (const entry of stale) {
    if (excess <= 0) break;
    delete fieldEditors[entry.path];
    pruned = Math.max(pruned, entry.rev);
    excess--;
  }
  fieldEditors[PAGE_DRAFT_EDITORS_PRUNED_KEY] = { rev: pruned };
}

// ── Reading the draft ──────────────────────────────────────────────────────

type DraftOverlays = Pick<PageDraftRecord, "data" | "placePatch">;

/** Leaf paths pending across the overlays, ignoring `data.v`. */
export function changeCount(draft: DraftOverlays | null): number {
  if (draft === null) return 0;
  const dataLeaves = Object.keys(draft.data).filter(
    (path) => path !== PAGE_DRAFT_VERSION_KEY,
  ).length;
  return dataLeaves + Object.keys(draft.placePatch).length;
}

/**
 * Nothing pending. A missing row, a bare-lock revision-0 row and a cleared
 * row all answer true, and nothing here tells them apart.
 */
export function isEmptyDraft(draft: DraftOverlays | null): boolean {
  return changeCount(draft) === 0;
}

export type PageDraftChange = {
  path: string;
  humanId: string | null;
  at: string | null;
  rev: number | null;
};

export type PageDraftChangesSince = {
  /** The draft's revision now (0 without a row). */
  revision: number;
  /**
   * The draft was cleared (Publish or Discard) after `clientRevision`: the
   * client drops its whole local overlay and takes the server's.
   */
  cleared: boolean;
  /**
   * The client cannot be brought up to date path by path: the draft was
   * cleared, or editor entries newer than `clientRevision` were pruned. It
   * takes the server's whole overlay (keeping only ops it has not sent).
   * `cleared` implies `resync`; only `cleared` means Publish or Discard
   * happened.
   */
  resync: boolean;
  /** Paths written after `clientRevision` (by anyone), with their editor. */
  changes: PageDraftChange[];
};

function readEditor(raw: unknown): {
  humanId: string | null;
  at: string | null;
  rev: number | null;
} {
  if (raw === null || typeof raw !== "object")
    return { humanId: null, at: null, rev: null };
  const entry = raw as Record<string, unknown>;
  return {
    humanId: typeof entry.humanId === "string" ? entry.humanId : null,
    at: typeof entry.at === "string" ? entry.at : null,
    rev: typeof entry.rev === "number" ? entry.rev : null,
  };
}

/**
 * What changed since the client's revision. A path whose editor entry has no
 * readable `rev` is reported as changed (better a redundant refetch than a
 * missed edit). Human ids may no longer resolve; callers show those edits
 * without a name.
 */
export function changedSince(
  draft: Pick<PageDraftRecord, "revision" | "fieldEditors"> | null,
  clientRevision: number,
): PageDraftChangesSince {
  if (draft === null) {
    return { revision: 0, cleared: false, resync: false, changes: [] };
  }
  const base = readEditor(draft.fieldEditors[PAGE_DRAFT_EDITORS_BASE_KEY]).rev;
  const overlayStart = base ?? draft.revision;
  const pruned =
    readEditor(draft.fieldEditors[PAGE_DRAFT_EDITORS_PRUNED_KEY]).rev ?? 0;
  const cleared = overlayStart > clientRevision;
  const changes: PageDraftChange[] = [];
  for (const [path, raw] of Object.entries(draft.fieldEditors)) {
    if (path.startsWith("$")) continue;
    const editor = readEditor(raw);
    if (editor.rev === null || editor.rev > clientRevision) {
      changes.push({ path, ...editor });
    }
  }
  changes.sort(
    (a, b) =>
      (a.rev ?? Infinity) - (b.rev ?? Infinity) || a.path.localeCompare(b.path),
  );
  return {
    revision: draft.revision,
    cleared,
    resync: cleared || pruned > clientRevision,
    changes,
  };
}

// ── Overlay ────────────────────────────────────────────────────────────────

export type PageDraftLiveView<P extends { id: string }, T extends object> = {
  page: P;
  theme: T | null;
  /** Every live block of the page, any section. */
  blocks: readonly PageBlockRecord[];
  /** Live Place facts (placeDraftFactsFromRecord); null for non-PLACE pages. */
  place: PlaceDraftFacts | null;
};

export type PageDraftViewBlock = PageBlockRecord & {
  /** Added in the draft (`new:<uuid>` id); not live yet. */
  isNew: boolean;
  /**
   * A new block with no content yet: shown in the editor as "Not on your page
   * until it has content"; Publish does not create it (FR-011).
   */
  emptyNewBlock: boolean;
};

export type PageDraftView<P extends { id: string }, T extends object> = {
  page: P;
  theme: T | null;
  place: PlaceDraftFacts | null;
  /** Main-section blocks in effective order, then other sections unchanged. */
  blocks: PageDraftViewBlock[];
  /** Live block ids the draft removes. */
  removedBlockIds: string[];
};

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object")
    return Object.values(value).some(hasMeaningfulValue);
  return false;
}

/**
 * Kinds that fill themselves or are a call to action, so a new one is never
 * "empty" although it has optional fields: automatic sections whose content
 * the server builds (`upcoming_events` lists the venue's shows; its `events`
 * field is not owner content) and calls to action whose button IS the
 * content (`request_to_play`, `rate_venue`; their intro is optional). Kinds
 * whose only editable field is the heading are automatic without being
 * listed here. Data, not a branch (R19): a new kind like this is one entry.
 */
export const PAGE_BLOCK_KINDS_AUTOMATIC_OR_CALL_TO_ACTION: ReadonlySet<string> =
  new Set(["upcoming_events", "request_to_play", "rate_venue"]);

/**
 * Whether a block has content a visitor would see (FR-011: Publish does not
 * create a new block without it). A kind whose only editable field is its
 * heading is an automatic section (content computed server-side), so it
 * always has content, as do the kinds in
 * PAGE_BLOCK_KINDS_AUTOMATIC_OR_CALL_TO_ACTION. Otherwise some editable field
 * other than the heading must hold a value; rich text counts only with
 * visible text, a list only with a non-blank entry.
 */
export function blockHasContent(
  kind: string,
  data: Record<string, unknown>,
): boolean {
  const config = getBlockConfig(kind);
  if (!config) return false;
  if (PAGE_BLOCK_KINDS_AUTOMATIC_OR_CALL_TO_ACTION.has(kind)) return true;
  const editable = config.fields.filter(
    (field) => field.kind !== "readonly" && field.name !== "heading",
  );
  if (editable.length === 0) return true;
  return editable.some((field) => {
    const value = data[field.name];
    return field.kind === "richText"
      ? typeof value === "string" && !isRichTextEmpty(value)
      : hasMeaningfulValue(value);
  });
}

function richTextFieldNames(kind: string): string[] {
  return (getBlockConfig(kind)?.fields ?? [])
    .filter((field) => field.kind === "richText")
    .map((field) => field.name);
}

/** Block data with the draft's leaves for `blockId` applied (null = unset). */
function overlayBlockData(
  base: Record<string, unknown>,
  data: Record<string, unknown>,
  blockId: string,
  kind: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  const prefix = `blocks.${blockId}.data.`;
  for (const [path, value] of Object.entries(data)) {
    if (!path.startsWith(prefix)) continue;
    const field = path.slice(prefix.length);
    if (value === null) delete next[field];
    else next[field] = value;
  }
  // FR-022: legacy plain text in a rich-text field reaches the editor as
  // paragraph HTML.
  for (const field of richTextFieldNames(kind)) {
    const value = next[field];
    if (typeof value === "string") next[field] = toRichTextHtml(value);
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The effective main-column order of the page with the draft applied, as
 * block ids (live ids and `new:<uuid>`), removed blocks left out. Starts
 * from `order.main` when the draft has one, else the live stored order;
 * blocks missing from it (added since, or added live elsewhere) land at the
 * end of their zone; the result is zone-sorted, so it is always an order
 * `canPlace` accepts. Publish writes this order.
 */
export function resolveMainOrder(
  liveBlocks: readonly Pick<
    PageBlockRecord,
    "id" | "kind" | "section" | "orderIndex"
  >[],
  draft: Pick<PageDraftRecord, "data" | "fieldEditors"> | null,
  layout: PageZoneLayout,
): string[] {
  const data = draft?.data ?? {};
  const liveMain = [...liveBlocks]
    .filter((block) => normalizeBlockSection(block.section) === "main")
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .filter((block) => !isRemoved(data, block.id));
  const added = newBlockKinds(data);
  const kindOf = new Map<string, string>([
    ...liveMain.map((block): [string, string] => [block.id, block.kind]),
    ...added,
  ]);

  // New blocks not placed by order.main land in the order they were added
  // (the revision that wrote their kind; jsonb does not keep key order).
  const addedOrder = [...added.keys()].sort((a, b) => {
    const ra = readEditor(draft?.fieldEditors[newBlockKindPath(a)]).rev ?? 0;
    const rb = readEditor(draft?.fieldEditors[newBlockKindPath(b)]).rev ?? 0;
    return ra - rb || a.localeCompare(b);
  });

  const stored = data["order.main"];
  const base = Array.isArray(stored)
    ? stored.filter(
        (id): id is string => typeof id === "string" && kindOf.has(id),
      )
    : liveMain.map((block) => block.id);
  const placed = new Set(base);
  let ordered = sortByZone(
    base.map((id) => ({ id, kind: kindOf.get(id)! })),
    layout,
  );
  const missing = [
    ...liveMain.map((block) => block.id).filter((id) => !placed.has(id)),
    ...addedOrder.filter((id) => !placed.has(id)),
  ];
  for (const id of missing) {
    const block = { id, kind: kindOf.get(id)! };
    const at = insertionIndexFor(block.kind, ordered, layout) ?? ordered.length;
    ordered = [...ordered.slice(0, at), block, ...ordered.slice(at)];
  }
  return sortByZone(ordered, layout).map((block) => block.id);
}

/**
 * The page as editors see it: live values with the draft's leaves applied.
 * Page and theme fields are merged over the live records (theme stays an
 * open object), Place facts take the patch, blocks take data / visible /
 * removed overlays, new blocks appear with their kind's default data, and
 * the main column follows `resolveMainOrder`. Rich-text fields come back as
 * sanitised HTML even when the live value is legacy plain text (FR-022).
 */
export function applyOverlay<P extends { id: string }, T extends object>(
  live: PageDraftLiveView<P, T>,
  draft: Pick<PageDraftRecord, "data" | "placePatch" | "fieldEditors"> | null,
  layout: PageZoneLayout,
): PageDraftView<P, T> {
  const data = draft?.data ?? {};
  if (draft !== null) assertSupportedVersion(data);

  const page: Record<string, unknown> = { ...live.page };
  const themeOverlay: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(data)) {
    if (path.startsWith("page.")) page[path.slice(5)] = value;
    else if (path.startsWith("theme.")) themeOverlay[path.slice(6)] = value;
  }
  const theme =
    live.theme === null && Object.keys(themeOverlay).length === 0
      ? null
      : ({ ...(live.theme ?? {}), ...themeOverlay } as T);
  const place =
    live.place === null
      ? null
      : { ...live.place, ...(draft?.placePatch ?? {}) };

  const order = resolveMainOrder(live.blocks, draft, layout);
  const liveById = new Map(live.blocks.map((block) => [block.id, block]));
  const added = newBlockKinds(data);
  const pageId = live.page.id;

  const mainBlocks: PageDraftViewBlock[] = order.map((id, orderIndex) => {
    const visibleLeaf = data[`blocks.${id}.visible`];
    const existing = liveById.get(id);
    if (existing) {
      const blockData = overlayBlockData(
        asRecord(existing.data),
        data,
        id,
        existing.kind,
      );
      return {
        ...existing,
        orderIndex,
        data: blockData,
        visible:
          typeof visibleLeaf === "boolean" ? visibleLeaf : existing.visible,
        isNew: false,
        emptyNewBlock: false,
      };
    }
    const kind = added.get(id)!;
    const blockData = overlayBlockData(
      getDefaultBlockData(kind),
      data,
      id,
      kind,
    );
    return {
      id,
      pageId,
      kind,
      orderIndex,
      data: blockData,
      visible: typeof visibleLeaf === "boolean" ? visibleLeaf : true,
      section: "main",
      isNew: true,
      emptyNewBlock: !blockHasContent(kind, blockData),
    };
  });
  const otherBlocks: PageDraftViewBlock[] = live.blocks
    .filter((block) => normalizeBlockSection(block.section) !== "main")
    .map((block) => ({ ...block, isNew: false, emptyNewBlock: false }));
  const removedBlockIds = live.blocks
    .filter(
      (block) =>
        normalizeBlockSection(block.section) === "main" &&
        isRemoved(data, block.id),
    )
    .map((block) => block.id);

  return {
    page: page as P,
    theme,
    place,
    blocks: [...mainBlocks, ...otherBlocks],
    removedBlockIds,
  };
}

// ── Place facts ────────────────────────────────────────────────────────────

/**
 * A Place row in the draft's field shape: the shape `place.*` op values have
 * after validation, so `placeBase` (recorded from this) and a later read of
 * the same field compare like for like. Address parts that are null are
 * left out, as an upsertPlace address leaves out absent optional parts.
 */
export function placeDraftFactsFromRecord(
  place: Pick<
    PlaceRecord,
    | "name"
    | "capacity"
    | "phone"
    | "website"
    | "formattedAddress"
    | "addressLine1"
    | "addressLine2"
    | "city"
    | "region"
    | "postalCode"
    | "countryCode"
    | "lat"
    | "lng"
    | "locationMode"
    | "locationRadiusMeters"
    | "locationLabel"
  >,
): PlaceDraftFacts {
  const address: Record<string, unknown> = {};
  const parts: [string, unknown][] = [
    ["formatted", place.formattedAddress],
    ["line1", place.addressLine1],
    ["line2", place.addressLine2],
    ["city", place.city],
    ["region", place.region],
    ["postalCode", place.postalCode],
    ["countryCode", place.countryCode],
    ["lat", place.lat],
    ["lng", place.lng],
  ];
  for (const [key, value] of parts) {
    if (value !== null && value !== undefined) address[key] = value;
  }
  return {
    name: place.name,
    capacity: place.capacity,
    phone: place.phone,
    website: place.website,
    address,
    locationMode: place.locationMode,
    locationRadiusMeters: place.locationRadiusMeters,
    locationLabel: place.locationLabel,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Deep equality for draft values, independent of object key order (jsonb
 * reorders keys) and treating undefined as null. Publish uses it to compare
 * `placeBase[field]` with the field's live value now (R9 conflicts).
 */
export function draftValuesEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
