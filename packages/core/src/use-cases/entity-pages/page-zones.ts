/**
 * Where page sections may sit, as DATA (page editor spec
 * docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml, R3, FR-009,
 * FR-010, R19).
 *
 * A layout's main column is an ordered list of ZONES. Each zone claims block
 * kinds (or "rest": every main-column kind no other zone claims) and is
 * either movable (its blocks reorder freely among themselves) or fixed (its
 * kinds keep the order listed, and the zone says why it is locked). A block
 * always sits in its kind's zone; a new block lands at the end of its zone.
 * Kinds the layout renders OUTSIDE the main column (hero, sidebar, the
 * events section) are listed in `elsewhere`; their position in the stored
 * order does not matter and the rules skip them.
 *
 * R19 (owner: "The goal is geo cities/tumblr creativity when applied"):
 * nothing below branches on a kind. Loosening the zones, or a freeform
 * layout where anything goes anywhere, is one more entry in
 * `PAGE_ZONE_LAYOUTS` (e.g. `{ zones: [{ id: "canvas", kinds: "rest",
 * movable: true }], elsewhere: {} }`); the functions stay as they are.
 *
 * This table replaces `BLOCK_PRIORITY` in apps/web PlaceEntityLayout.tsx
 * (about 10, photos 20, default 500, booking_info 1000; location_map,
 * upcoming_events and links suppressed into the sidebar / events section;
 * request_to_play into the hero button). `sortByZone` reproduces that sort
 * exactly, so web can switch to it without a visible change.
 *
 * Pinned kinds (`track_record`, `BlockConfig.pinned`) are ordinary members
 * of their zone here: pinned means "reorderable, never removed, hidden or
 * duplicated", and those three rules live with the block ops
 * (manage-page-blocks.ts, page-draft-ops.ts), not with placement.
 *
 * Pure: no I/O. Safe to import from web.
 */

import type { PageOwnerType } from "@th/types/repos/entity-pages";

// ── Table types ────────────────────────────────────────────────────────────

/**
 * Why a fixed zone is fixed: the reason code the editor shows on a locked
 * section ("Locked sections show why", FR-009). Copy lives in web.
 */
export const PAGE_ZONE_LOCKS = ["leads", "fixed_first", "fixed_last"] as const;
export type PageZoneLock = (typeof PAGE_ZONE_LOCKS)[number];

/** Parts of a layout outside the main column that render some kinds. */
export const PAGE_REGIONS = ["hero", "sidebar", "events"] as const;
export type PageRegion = (typeof PAGE_REGIONS)[number];

export type PageZone = {
  /** Stable id (the editor keys drop lines and labels on it). */
  id: string;
  /**
   * Kinds this zone holds, or "rest": every main-column kind that no other
   * zone claims and that is not placed `elsewhere`. A zone with `[]` holds
   * no blocks; it marks a non-block section (`section`).
   */
  kinds: readonly string[] | "rest";
  /**
   * true: blocks in the zone reorder freely. false: the zone's kinds keep
   * the order listed in `kinds`, and `lock` says why.
   */
  movable: boolean;
  /** Reason code for a fixed zone. */
  lock?: PageZoneLock;
  /**
   * A section the layout renders here that is NOT a PageBlock (the venue's
   * upcoming events, PlaceEventsSection). Shown locked, never stored in the
   * block order.
   */
  section?: string;
};

export type PageZoneLayout = {
  /** `${ownerType}.${layoutKey}`, for logs and tests. */
  key: string;
  /** Main-column zones, top to bottom. */
  zones: readonly PageZone[];
  /** Kinds rendered outside the main column, and where. */
  elsewhere: Readonly<Partial<Record<string, PageRegion>>>;
};

// ── The table ──────────────────────────────────────────────────────────────

/**
 * Venue standard layout (R3): upcoming events lead; About then Photos are
 * fixed first; Booking info is fixed last; every other main-column kind
 * moves freely between Photos and Booking info.
 */
const PLACE_STANDARD: PageZoneLayout = {
  key: "PLACE.standard",
  zones: [
    {
      id: "upcoming",
      kinds: [],
      movable: false,
      lock: "leads",
      section: "upcoming_events",
    },
    {
      id: "lead",
      kinds: ["about", "photos"],
      movable: false,
      lock: "fixed_first",
    },
    { id: "free", kinds: "rest", movable: true },
    {
      id: "tail",
      kinds: ["booking_info"],
      movable: false,
      lock: "fixed_last",
    },
  ],
  elsewhere: {
    // PlaceEventsSection owns events; the block's data is never rendered.
    upcoming_events: "events",
    // The logistics card owns the map and absorbs every links block.
    location_map: "sidebar",
    links: "sidebar",
    // The hero's "Booking request" button replaces the in-column block.
    request_to_play: "hero",
  },
};

/**
 * Zone tables by owner type, then theme `layoutKey`. Only the venue standard
 * layout has one in this phase; org and human standard layouts and the
 * freeform `stack` / `grid` layouts get an entry when the editor reaches
 * them (R6, R7).
 */
export const PAGE_ZONE_LAYOUTS: Readonly<
  Partial<Record<PageOwnerType, Readonly<Record<string, PageZoneLayout>>>>
> = {
  PLACE: { standard: PLACE_STANDARD },
};

/** The zone table for a page, or null when this layout has none yet. */
export function resolvePageZoneLayout(
  ownerType: PageOwnerType,
  layoutKey: string,
): PageZoneLayout | null {
  return PAGE_ZONE_LAYOUTS[ownerType]?.[layoutKey] ?? null;
}

// ── Lookups ────────────────────────────────────────────────────────────────

export type PagePlacement =
  | {
      where: "zone";
      zone: PageZone;
      /** Index of the zone in `layout.zones`. */
      zoneIndex: number;
      /**
       * Position of the kind inside a FIXED zone's `kinds` (its required
       * order); 0 in a movable zone, where order is free.
       */
      kindIndex: number;
    }
  | { where: "elsewhere"; region: PageRegion }
  | { where: "none" };

/**
 * Where a kind goes on this layout: an explicit zone first, then
 * `elsewhere`, then the first "rest" zone; "none" when the layout has no
 * place for it.
 */
export function zoneOf(kind: string, layout: PageZoneLayout): PagePlacement {
  for (let zoneIndex = 0; zoneIndex < layout.zones.length; zoneIndex++) {
    const zone = layout.zones[zoneIndex]!;
    if (zone.kinds === "rest") continue;
    const kindIndex = zone.kinds.indexOf(kind);
    if (kindIndex !== -1) {
      return {
        where: "zone",
        zone,
        zoneIndex,
        kindIndex: zone.movable ? 0 : kindIndex,
      };
    }
  }
  const region = layout.elsewhere[kind];
  if (region !== undefined) return { where: "elsewhere", region };
  const restIndex = layout.zones.findIndex((zone) => zone.kinds === "rest");
  if (restIndex !== -1) {
    return {
      where: "zone",
      zone: layout.zones[restIndex]!,
      zoneIndex: restIndex,
      kindIndex: 0,
    };
  }
  return { where: "none" };
}

/** The lock reason the editor shows for a kind, or null when it moves. */
export function lockOf(
  kind: string,
  layout: PageZoneLayout,
): PageZoneLock | null {
  const placement = zoneOf(kind, layout);
  if (placement.where !== "zone" || placement.zone.movable) return null;
  return placement.zone.lock ?? null;
}

/** The palette groups of FR-010. */
export type PagePaletteGroup =
  | "moves_freely"
  | "fixed_spot"
  | "elsewhere"
  | "not_on_layout";

/** Which FR-010 palette group a kind belongs to on this layout. */
export function paletteGroupOf(
  kind: string,
  layout: PageZoneLayout,
): PagePaletteGroup {
  const placement = zoneOf(kind, layout);
  if (placement.where === "elsewhere") return "elsewhere";
  if (placement.where === "none") return "not_on_layout";
  return placement.zone.movable ? "moves_freely" : "fixed_spot";
}

// ── Rules ──────────────────────────────────────────────────────────────────

/**
 * Refusal codes for a placement:
 *   zone_order     a block sits outside its zone (or out of a fixed zone's
 *                  kind order); `lock` names the fixed zone involved
 *   not_on_layout  the layout has no place for the kind
 */
export const PAGE_ZONE_REFUSALS = ["zone_order", "not_on_layout"] as const;
export type PageZoneRefusalReason = (typeof PAGE_ZONE_REFUSALS)[number];

export type PageZoneRefusal = {
  ok: false;
  reason: PageZoneRefusalReason;
  /** Position of the offending kind in the list that was checked. */
  index: number;
  kind: string;
  /** The kind it may not follow (zone_order only). */
  after?: string;
  /** The lock of the fixed zone that makes this order invalid, if any. */
  lock?: PageZoneLock;
};

export type PageZoneCheck = { ok: true } | PageZoneRefusal;

type ZoneKey = { zoneIndex: number; kindIndex: number };

function compareKeys(a: ZoneKey, b: ZoneKey): number {
  return a.zoneIndex - b.zoneIndex || a.kindIndex - b.kindIndex;
}

/**
 * Validate a whole main-column order (block kinds, top to bottom). Kinds
 * placed `elsewhere` are skipped: they do not render in the column, so
 * their stored position is free.
 */
export function canPlace(
  orderedKinds: readonly string[],
  layout: PageZoneLayout,
): PageZoneCheck {
  let previous: { key: ZoneKey; kind: string; zone: PageZone } | null = null;
  for (let index = 0; index < orderedKinds.length; index++) {
    const kind = orderedKinds[index]!;
    const placement = zoneOf(kind, layout);
    if (placement.where === "elsewhere") continue;
    if (placement.where === "none") {
      return { ok: false, reason: "not_on_layout", index, kind };
    }
    const key = {
      zoneIndex: placement.zoneIndex,
      kindIndex: placement.kindIndex,
    };
    if (previous !== null && compareKeys(key, previous.key) < 0) {
      const lock =
        (!placement.zone.movable ? placement.zone.lock : undefined) ??
        (!previous.zone.movable ? previous.zone.lock : undefined);
      return {
        ok: false,
        reason: "zone_order",
        index,
        kind,
        after: previous.kind,
        ...(lock !== undefined && { lock }),
      };
    }
    previous = { key, kind, zone: placement.zone };
  }
  return { ok: true };
}

/**
 * Where a NEW block of `kind` lands in `orderedBlocks` (main column, top to
 * bottom; must already pass `canPlace`): right after the last block that
 * may precede it, i.e. at the end of its zone. A kind placed `elsewhere`
 * lands at the end of the list (its position does not render). null when
 * the layout has no place for the kind.
 */
export function insertionIndexFor(
  kind: string,
  orderedBlocks: readonly { kind: string }[],
  layout: PageZoneLayout,
): number | null {
  const placement = zoneOf(kind, layout);
  if (placement.where === "none") return null;
  if (placement.where === "elsewhere") return orderedBlocks.length;
  const key = {
    zoneIndex: placement.zoneIndex,
    kindIndex: placement.kindIndex,
  };
  let insertAt = 0;
  orderedBlocks.forEach((block, index) => {
    const other = zoneOf(block.kind, layout);
    if (other.where !== "zone") return;
    if (compareKeys(other, key) <= 0) insertAt = index + 1;
  });
  return insertAt;
}

/**
 * The range of positions (inclusive, as indexes into `orderedKinds`) the
 * block at `index` can be moved to with every other block keeping its
 * relative order, for the editor's drag targets and Move up / Move down.
 * `min === max === index` means the block cannot move; `lock` then says why
 * when its zone is fixed. Elsewhere kinds get the whole list.
 */
export function moveRange(
  orderedKinds: readonly string[],
  index: number,
  layout: PageZoneLayout,
): { min: number; max: number; lock: PageZoneLock | null } {
  const kind = orderedKinds[index];
  if (kind === undefined) {
    throw new RangeError(`moveRange: no block at index ${index}`);
  }
  const lock = lockOf(kind, layout);
  const placement = zoneOf(kind, layout);
  if (placement.where !== "zone") {
    return { min: 0, max: orderedKinds.length - 1, lock };
  }
  const rest = orderedKinds.filter((_, i) => i !== index);
  let min = rest.length;
  let max = 0;
  for (let position = 0; position <= rest.length; position++) {
    const candidate = [
      ...rest.slice(0, position),
      kind,
      ...rest.slice(position),
    ];
    if (canPlace(candidate, layout).ok) {
      min = Math.min(min, position);
      max = Math.max(max, position);
    }
  }
  if (min > max) return { min: index, max: index, lock };
  return { min, max, lock };
}

/**
 * Stable sort of blocks into zone order: the zone order the public layout
 * renders (the `BLOCK_PRIORITY` sort in PlaceEntityLayout). Blocks within a
 * movable zone keep their relative order; a fixed zone orders by its listed
 * kinds; kinds placed elsewhere, or with no place, go last in their
 * relative order.
 */
export function sortByZone<T extends { kind: string }>(
  blocks: readonly T[],
  layout: PageZoneLayout,
): T[] {
  const last = { zoneIndex: layout.zones.length, kindIndex: 0 };
  return blocks
    .map((block, position) => {
      const placement = zoneOf(block.kind, layout);
      const key = placement.where === "zone" ? placement : last;
      return { block, position, key };
    })
    .sort((a, b) => compareKeys(a.key, b.key) || a.position - b.position)
    .map(({ block }) => block);
}
