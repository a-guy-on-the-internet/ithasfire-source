import { z } from "zod";

import {
  PLACE_MERGE_ID_SAMPLE_CAP,
  type PlaceMergeCounts,
  type PlaceMergeFillPatch,
  type PlaceMergeIntentCounts,
  type PlaceMergeRow,
  type PlaceMergeSide,
  type PlaceMergeStandardDrop,
  type PlaceMergeStandardsOwners,
} from "@th/ports/repos/place-merge";
import type { TxRepos } from "@th/ports/repos";
import type { ArrivalAreaRow } from "@th/ports/repos/arrival-areas";

import { fail } from "@th/errors";

import type { ArrivalAreaPin } from "../../../lib/arrival-areas/geometry";
import { MAX_ARRIVAL_AREAS_PER_PLACE } from "../../../lib/arrival-areas/limits";
import { anonymousPlacePageAreaIds } from "../../arrival-areas/list-arrival-areas-for-viewer";
import { eventAreasOutsideSurvivorPin } from "../../arrival-areas/place-merge-arrival-areas";

// ─────────────────────────────────────────────────────────────────────────────
// The decisions behind merging two duplicate places (merge-duplicate-places
// spec, docs/specs/2026-10-13/merge-duplicate-places.spec.yaml). Pure where
// possible; `readPlaceMergePlan` is the one read both `previewPlaceMerge` and
// `mergePlaces` run, so the preview shows exactly what the merge would refuse.
// ─────────────────────────────────────────────────────────────────────────────

export const placeMergeInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** The row that stays (spec D1: the admin picks it). */
    survivorId: z.string().uuid(),
    /** The row whose references move to the survivor, then is deleted. */
    mergedId: z.string().uuid(),
  })
  .strict();

export type PlaceMergeInput = z.infer<typeof placeMergeInputSchema>;

/**
 * Why a merge is refused (spec FR-006, D6). Booking and operations rows move
 * (owner ruling 2026-10-15, D4); what is left is a conflict a person has to
 * settle first. `count` is the number of rows involved; 1 for a yes/no
 * condition. `ids` names up to 20 of the rows when the blocker can.
 */
export const PLACE_MERGE_BLOCKER_CODES = [
  "HAS_ACTIVE_VERIFICATION_REQUEST",
  "VERIFICATION_ABOVE_SURVIVOR",
  "OWNER_CONFLICT",
  "EMBED_COLLISION",
  "LOCATION_PRIVACY_DIFFERS",
  "COMMUNITY_LISTINGS_CONSENT_DIFFERS",
  "SURVIVOR_NOT_ACTIVE",
  /** Both places name a different default deal of the same kind (money). */
  "DEFAULT_PAYOUT_TERMS_CONFLICT",
  /** Both default calendars hold the same night the same way (see FR-006). */
  "BOOKING_HOLDS_OVERLAP",
  /** An open request on both places from the same performer / email. */
  "BOOKING_REQUESTS_OPEN_DUPLICATE",
  /**
   * arrival-areas FR-012: the merged place's arrival areas move to the
   * survivor, and together they would pass the per-place limit. Names every
   * area (`arrivalAreas`) so a moderator can remove some first.
   */
  "ARRIVAL_AREA_LIMIT",
] as const;

export type PlaceMergeBlockerCode = (typeof PLACE_MERGE_BLOCKER_CODES)[number];

/**
 * One arrival area an ARRIVAL_AREA_LIMIT blocker names: which place it is
 * on and what it is called. No geometry (the preview is a list, not a map).
 */
export const placeMergeArrivalAreaSchema = z
  .object({
    id: z.string(),
    placeId: z.string(),
    /** `survivor`: the place that stays; `merged`: the one being removed. */
    side: z.enum(["survivor", "merged"]),
    kind: z.enum(["PARKING", "ACCESSIBLE_DROP_OFF", "LOAD_IN"]),
    label: z.string(),
  })
  .strict();

export type PlaceMergeArrivalArea = z.infer<typeof placeMergeArrivalAreaSchema>;

export const placeMergeBlockerSchema = z
  .object({
    code: z.enum(PLACE_MERGE_BLOCKER_CODES),
    count: z.number().int().min(1),
    /** Up to 20 of the rows behind the count, when the blocker can name them. */
    ids: z.array(z.string()).max(PLACE_MERGE_ID_SAMPLE_CAP).optional(),
    /** ARRIVAL_AREA_LIMIT only: the areas on both sides, survivor's first. */
    arrivalAreas: z
      .array(placeMergeArrivalAreaSchema)
      .max(PLACE_MERGE_ID_SAMPLE_CAP)
      .optional(),
    /** ARRIVAL_AREA_LIMIT only: the per-place limit the total passes. */
    limit: z.number().int().min(1).optional(),
  })
  .strict();

export type PlaceMergeBlocker = z.infer<typeof placeMergeBlockerSchema>;

/**
 * What the merge will do that an admin should see before confirming. None of
 * these stop it (spec FR-002).
 */
export const PLACE_MERGE_WARNING_CODES = [
  /** Merged availability shares a weekday or date with the survivor's. */
  "AVAILABILITY_OVERLAP",
  /** Merged place-wide availability now applies to every survivor calendar. */
  "PLACE_WIDE_AVAILABILITY_MOVED",
  /** A confirmed night on one side, live holds on the other, same date. */
  "HOLDS_SAME_NIGHT",
  /** The survivor's own booking standards win; the merged list is dropped. */
  "BOOKING_STANDARDS_REPLACED",
  /** A moved calendar, space or seat map was renamed (a name was taken). */
  "NAMES_SUFFIXED",
  /** The merged active waiver becomes the survivor's (it had none). */
  "WAIVER_BECOMES_ACTIVE",
  /** The survivor's active waiver stays; the merged waivers move inactive. */
  "WAIVERS_DEACTIVATED",
  /** Owners differ: the merged default deals are not carried (audit keeps the ids). */
  "PAYOUT_DEFAULTS_NOT_CARRIED",
  /**
   * Merged grants are ended: every active one when the owners differ, or the
   * whole-place ones when the merged place brought no calendar to split onto.
   */
  "GRANTS_ENDED",
  /** Whole-place grants narrowed to one grant per calendar the merged place brought. */
  "GRANTS_SPLIT",
  /**
   * The survivor has no active owner and the merged place does: its owners
   * move onto the survivor (FR-006) and take over its open booking requests
   * and live agreements. Carries the owner keys and those counts.
   */
  "OWNERSHIP_TRANSFERS",
  /**
   * arrival-areas FR-012 / FR-014: event-only areas on the events that move
   * are outside 3 km of the survivor's pin (or it has none) and will be
   * switched off. `ids` names up to 20 of them.
   */
  "EVENT_ARRIVAL_AREAS_SWITCH_OFF",
  /**
   * arrival-areas FR-012: the merged place is SUSPENDED or ARCHIVED, so its
   * place page showed none of its areas; on the survivor's page anyone will
   * see them. Counts exactly what a signed-out visitor will see there once
   * the merge has run (`anonymousPlacePageAreaIds` on the survivor after the
   * fill): switched-on parking and drop-off, never load-in, and only when the
   * survivor's page publishes its exact address. `ids` names up to 20.
   */
  "MERGED_PLACE_AREAS_BECOME_PUBLIC",
] as const;

export type PlaceMergeWarningCode = (typeof PLACE_MERGE_WARNING_CODES)[number];

export const placeMergeWarningSchema = z
  .object({
    code: z.enum(PLACE_MERGE_WARNING_CODES),
    count: z.number().int().min(1),
    ids: z.array(z.string()).max(PLACE_MERGE_ID_SAMPLE_CAP).optional(),
    /** OWNERSHIP_TRANSFERS only: who becomes the survivor's owner. */
    owners: z
      .array(z.object({ ownerType: z.string(), ownerId: z.string() }).strict())
      .max(PLACE_MERGE_ID_SAMPLE_CAP)
      .optional(),
    /** OWNERSHIP_TRANSFERS only: what of the survivor's they take over. */
    survivorOpenBookingRequests: z.number().int().min(0).optional(),
    survivorLiveAgreements: z.number().int().min(0).optional(),
    /**
     * EVENT_ARRIVAL_AREAS_SWITCH_OFF only: whether the survivor has a map pin
     * after the fill. False means every event area is counted (nothing to
     * measure against), not that each is far away.
     */
    survivorHasPin: z.boolean().optional(),
  })
  .strict();

export type PlaceMergeWarning = z.infer<typeof placeMergeWarningSchema>;

/** The non-address columns that fill when the survivor's is empty (D2). */
const SINGLE_FILL_FIELDS = [
  "capacity",
  "phone",
  "locationLabel",
] as const satisfies readonly (keyof PlaceMergeFillPatch)[];

/**
 * The address group (D2): these move together, and only when the survivor
 * has no coordinates and the merged row has both. The timezone and the
 * admission-tax cache are derived from the address, so they ride with it.
 */
export const ADDRESS_GROUP_FIELDS = [
  "address",
  "addrLine1",
  "addrLine2",
  "city",
  "region",
  "postcode",
  "country",
  "addressHash",
  "lat",
  "lng",
  "timezone",
  "admissionTaxRateBps",
  "taxRateSource",
  "taxRateFetchedAt",
] as const satisfies readonly (keyof PlaceMergeFillPatch)[];

/**
 * The place's default deals (money). A survivor with none takes the merged
 * row's; two different ones refuse the merge (DEFAULT_PAYOUT_TERMS_CONFLICT).
 * The PayoutTerms rows themselves are never touched: Place only points at
 * them, so deleting the merged place deletes no deal.
 */
export const PAYOUT_DEFAULT_FIELDS = [
  "defaultPrimaryPayoutTermsId",
  "defaultResalePayoutTermsId",
] as const satisfies readonly (keyof PlaceMergeFillPatch)[];

export type PlaceMergeFillField =
  | (typeof SINGLE_FILL_FIELDS)[number]
  | (typeof ADDRESS_GROUP_FIELDS)[number]
  | (typeof PAYOUT_DEFAULT_FIELDS)[number]
  | "website"
  | "websiteSource";

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const hasPoint = (row: PlaceMergeRow): boolean =>
  typeof row.lat === "number" && typeof row.lng === "number";

/**
 * D2: the survivor's values win; a field it leaves empty is filled from the
 * merged row. The address moves as ONE group, only when the survivor has no
 * coordinates (never mix two addresses). `website` carries its provenance
 * (`websiteSource`) with it, since only a TRUSTED_IMPORT source unlocks the
 * claim fast-track.
 */
export function computePlaceMergeFill(
  survivor: PlaceMergeRow,
  merged: PlaceMergeRow,
  /**
   * Carry the merged row's default deals into empty survivor slots. False
   * when the owners are not compatible (`ownersCompatible`): a former
   * owner's deal must not become another owner's place default.
   */
  options: { carryPayoutDefaults: boolean } = { carryPayoutDefaults: true },
): { patch: PlaceMergeFillPatch; filledFields: PlaceMergeFillField[] } {
  const patch: Record<string, unknown> = {};
  const filledFields: PlaceMergeFillField[] = [];

  if (!hasPoint(survivor) && hasPoint(merged)) {
    for (const field of ADDRESS_GROUP_FIELDS) {
      patch[field] = merged[field];
      filledFields.push(field);
    }
  }

  for (const field of SINGLE_FILL_FIELDS) {
    if (isEmpty(survivor[field]) && !isEmpty(merged[field])) {
      patch[field] = merged[field];
      filledFields.push(field);
    }
  }

  if (isEmpty(survivor.website) && !isEmpty(merged.website)) {
    patch.website = merged.website;
    patch.websiteSource = merged.websiteSource;
    filledFields.push("website", "websiteSource");
  }

  for (const field of PAYOUT_DEFAULT_FIELDS) {
    if (!options.carryPayoutDefaults) break;
    if (survivor[field] === null && merged[field] !== null) {
      patch[field] = merged[field];
      filledFields.push(field);
    }
  }

  return { patch: patch as PlaceMergeFillPatch, filledFields };
}

/** VERIFIED > PENDING > UNVERIFIED = REJECTED. */
function verificationRank(v: PlaceMergeRow["verification"]): number {
  switch (v) {
    case "VERIFIED":
      return 2;
    case "PENDING":
      return 1;
    default:
      return 0;
  }
}

const ownerKey = (o: { ownerType: string; ownerId: string }) =>
  `${o.ownerType}:${o.ownerId}`;

/**
 * FR-006 ownership: the merged row's active owners move when the survivor
 * has no active owner, or when every one of them already owns the survivor.
 * Otherwise it is an ownership dispute, which a merge does not settle.
 */
export function hasOwnerConflict(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): boolean {
  const survivorActive = new Set(
    survivor.ownerships.filter((o) => !o.revoked).map(ownerKey),
  );
  const mergedActive = merged.ownerships.filter((o) => !o.revoked);
  if (survivorActive.size === 0 || mergedActive.length === 0) return false;
  return mergedActive.some((o) => !survivorActive.has(ownerKey(o)));
}

/**
 * Whether the merged row's owner-written settings (default deals, an active
 * waiver, booking grants) may carry to the survivor (coordinator ruling,
 * 2026-10-15):
 * - the survivor has no active owner → compatible (the merged PlaceOwnership
 *   rows move to it under FR-006, so whoever wrote the settings comes too;
 *   this includes both sides ownerless);
 * - every active merged owner is an active survivor owner → compatible;
 * - otherwise (an owned survivor and an unowned merged row, or a merged
 *   owner the survivor lacks) → not compatible: the settings move inert,
 *   deals not carried, waivers inactive, grants ended.
 */
export function ownersCompatible(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): boolean {
  const survivorActive = new Set(
    survivor.ownerships.filter((o) => !o.revoked).map(ownerKey),
  );
  const mergedActive = merged.ownerships.filter((o) => !o.revoked).map(ownerKey);
  if (survivorActive.size === 0) return true;
  return mergedActive.length > 0 && mergedActive.every((k) => survivorActive.has(k));
}

/**
 * PlaceOwnership is unique on (placeId, ownerType, ownerId). For each owner
 * present on both sides, keep the better row (active over revoked, then
 * verified over provisional, then the survivor's) and drop the other.
 */
export function planOwnershipDrops(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): string[] {
  return planOwnershipPairs(survivor, merged).map((p) => p.drop);
}

/** Each dropped ownership id paired with the kept row of the same owner. */
export function planOwnershipRepoints(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): { from: string; to: string }[] {
  return planOwnershipPairs(survivor, merged).map((p) => ({
    from: p.drop,
    to: p.keep,
  }));
}

function planOwnershipPairs(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): { drop: string; keep: string }[] {
  const rank = (o: { revoked: boolean; verified: boolean }) =>
    (o.revoked ? 0 : 2) + (o.verified ? 1 : 0);
  const survivorByKey = new Map(survivor.ownerships.map((o) => [ownerKey(o), o]));
  const drops: { drop: string; keep: string }[] = [];
  for (const m of merged.ownerships) {
    const s = survivorByKey.get(ownerKey(m));
    if (!s) continue;
    drops.push(rank(m) > rank(s) ? { drop: s.id, keep: m.id } : { drop: m.id, keep: s.id });
  }
  return drops;
}

/** Every reason the pair cannot merge (empty = it can). */
export function computePlaceMergeBlockers(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
  counts: PlaceMergeCounts,
): PlaceMergeBlocker[] {
  const blockers: PlaceMergeBlocker[] = [];
  const add = (code: PlaceMergeBlockerCode, count: number, ids?: string[]) => {
    if (count > 0) {
      blockers.push(
        ids && ids.length > 0
          ? { code, count, ids: ids.slice(0, PLACE_MERGE_ID_SAMPLE_CAP) }
          : { code, count },
      );
    }
  };
  const ops = counts.operations;

  add("HAS_ACTIVE_VERIFICATION_REQUEST", ops.activeVerificationRequests);
  add(
    "VERIFICATION_ABOVE_SURVIVOR",
    verificationRank(merged.place.verification) >
      verificationRank(survivor.place.verification)
      ? 1
      : 0,
  );
  add(
    "OWNER_CONFLICT",
    hasOwnerConflict(survivor, merged)
      ? merged.ownerships.filter((o) => !o.revoked).length
      : 0,
  );
  add("EMBED_COLLISION", ops.collidingEmbeds);
  // A community listing at the merged place is confirmed by that place's
  // standing consent. Moving it to a survivor without that consent would
  // void the confirmation silently; the flag is never ORed across (it is the
  // survivor owner's decision).
  add(
    "COMMUNITY_LISTINGS_CONSENT_DIFFERS",
    merged.place.acceptsCommunityListings &&
      !survivor.place.acceptsCommunityListings
      ? ops.communityEvents
      : 0,
  );
  add("SURVIVOR_NOT_ACTIVE", survivor.place.status !== "ACTIVE" ? 1 : 0);
  // D6: a merge must not publish a hidden address by inheriting a public
  // row's mode, nor change a withheld circle's size.
  add(
    "LOCATION_PRIVACY_DIFFERS",
    survivor.place.locationMode !== merged.place.locationMode ||
      (survivor.place.locationRadiusMeters ?? null) !==
        (merged.place.locationRadiusMeters ?? null)
      ? 1
      : 0,
  );
  // Money: the place holds ONE default deal per kind. Two different deals
  // are two agreements with two parties' money; a merge does not pick one.
  add(
    "DEFAULT_PAYOUT_TERMS_CONFLICT",
    !ownersCompatible(survivor, merged)
      ? 0
      : PAYOUT_DEFAULT_FIELDS.filter(
      (f) =>
        survivor.place[f] !== null &&
        merged.place[f] !== null &&
        survivor.place[f] !== merged.place[f],
    ).length,
  );
  // Two acts first in line for the same night in the same room, or two
  // confirmed bookings of it (the second is also a unique index). Never
  // renumbered or released by a merge: a person decides who keeps the night.
  add(
    "BOOKING_HOLDS_OVERLAP",
    ops.holdLineConflicts.count,
    ops.holdLineConflicts.ids,
  );
  // Two live conversations with the same party; a unique index allows one.
  add(
    "BOOKING_REQUESTS_OPEN_DUPLICATE",
    ops.openRequestConflicts.count,
    ops.openRequestConflicts.ids,
  );
  return blockers;
}

/**
 * arrival-areas FR-012: the merged place's areas move to the survivor (ids
 * kept), so the two sets together must fit the per-place limit (FR-005,
 * {@link MAX_ARRIVAL_AREAS_PER_PLACE}; disabled rows count, as they do on
 * create). Over it, the blocker names every area on both sides, the
 * survivor's first, so a moderator can remove some before merging. Null when
 * they fit.
 */
export function arrivalAreaLimitBlocker(
  survivorId: string,
  mergedId: string,
  areas: { survivor: readonly ArrivalAreaRow[]; merged: readonly ArrivalAreaRow[] },
): PlaceMergeBlocker | null {
  const total = areas.survivor.length + areas.merged.length;
  if (total <= MAX_ARRIVAL_AREAS_PER_PLACE) return null;
  const name = (
    row: ArrivalAreaRow,
    side: PlaceMergeArrivalArea["side"],
    placeId: string,
  ): PlaceMergeArrivalArea => ({
    id: row.id,
    placeId,
    side,
    kind: row.kind,
    label: row.label,
  });
  const named = [
    ...areas.survivor.map((row) => name(row, "survivor", survivorId)),
    ...areas.merged.map((row) => name(row, "merged", mergedId)),
  ].slice(0, PLACE_MERGE_ID_SAMPLE_CAP);
  return {
    code: "ARRIVAL_AREA_LIMIT",
    count: total,
    ids: named.map((a) => a.id),
    arrivalAreas: named,
    limit: MAX_ARRIVAL_AREAS_PER_PLACE,
  };
}

/**
 * Waivers (owner ruling relayed 2026-10-15): the survivor's active waiver
 * stays the one people sign, so when it has one the merged waivers move
 * inactive. A survivor with none keeps the merged active waiver active, so
 * the merge does not leave the place with no waiver at all (spec FR-003b).
 * Nothing references a PlaceWaiver by id (acceptances key on the template).
 */
export function deactivatesMergedWaivers(
  counts: PlaceMergeCounts,
  compatible: boolean,
): boolean {
  if (counts.operations.activeWaivers.merged === 0) return false;
  return !compatible || counts.operations.activeWaivers.survivor > 0;
}

/**
 * Where a merged whole-place grant (calendarId null) lands: one grant per
 * calendar the merged place brought — the survivor's default calendar when
 * the default folds (else the merged default, which moves whole), then each
 * calendar that moves whole. Never the survivor's other calendars: a grant
 * the merged place gave must not widen to rooms the survivor never offered.
 */
export function wholePlaceGrantTargets(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
  reparent: PlaceMergeReparentPlan,
): string[] {
  const targets: string[] = [];
  if (reparent.fold && survivor.defaultCalendarId) {
    targets.push(survivor.defaultCalendarId);
  }
  for (const c of reparent.calendars) targets.push(c.id);
  // The merged default first when it moves whole (it stays default).
  const mergedDefault = merged.defaultCalendarId;
  if (!reparent.fold && mergedDefault && targets.includes(mergedDefault)) {
    return [mergedDefault, ...targets.filter((t) => t !== mergedDefault)];
  }
  return targets;
}

/** True when the merged default calendar folds into the survivor's (FR-003b). */
export function foldsDefaultCalendar(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): boolean {
  return merged.defaultCalendarId !== null && survivor.defaultCalendarId !== null;
}

const NAME_MAX = 140;
const CALENDAR_SLUG_MAX = 64;

const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * `<name> (from <merged place>)`, trimmed to fit, then ` 2`, ` 3`… until it
 * is free. Names are compared case-insensitively.
 */
function suffixedName(name: string, mergedPlaceName: string, taken: Set<string>): string {
  const suffix = ` (from ${mergedPlaceName.trim()})`;
  const base =
    suffix.length >= NAME_MAX
      ? name.slice(0, NAME_MAX)
      : `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
  let candidate = base.slice(0, NAME_MAX);
  for (let n = 2; taken.has(nameKey(candidate)); n += 1) {
    const tail = ` ${n}`;
    candidate = `${base.slice(0, NAME_MAX - tail.length).trimEnd()}${tail}`;
  }
  return candidate;
}

/** `<slug>-2`, `-3`… within the 64-char slug limit (manage-calendars rule). */
function suffixedSlug(slug: string, taken: Set<string>): string {
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n += 1) {
    const trimmed = slug
      .slice(0, CALENDAR_SLUG_MAX - (String(n).length + 1))
      .replace(/-+$/, "");
    candidate = `${trimmed}-${n}`;
  }
  return candidate;
}

export interface PlaceMergeRename {
  id: string;
  kind: "calendar" | "space" | "layout";
  from: { name: string; slug?: string };
  to: { name: string; slug?: string };
}

export interface PlaceMergeReparentPlan {
  /** Fold the merged default calendar / Main Space into the survivor's. */
  fold: boolean;
  calendars: { id: string; name: string; slug: string }[];
  spaces: { id: string; name: string }[];
  layouts: { id: string; name: string }[];
  renames: PlaceMergeRename[];
}

/**
 * Which merged calendars, spaces and seat maps move whole, and their final
 * names (spec FR-003b). A survivor with no default calendar takes the merged
 * one (and its Main Space) whole, still default; otherwise the merged default
 * calendar and its Main Space fold into the survivor's and are deleted.
 * Every other calendar and space is a separate room and moves whole. A taken
 * calendar slug ("Calendar_placeId_slug_key") gets `-2`; a taken name gets
 * " (from <merged place>)" (PlaceLayout names are unique per place; calendar
 * and space names are not, but two "Patio" rooms on one place read as one).
 */
export function planPlaceMergeReparent(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): PlaceMergeReparentPlan {
  const fold = foldsDefaultCalendar(survivor, merged);
  const renames: PlaceMergeRename[] = [];
  const mergedName = merged.place.name;

  const calendarNames = new Set(survivor.calendars.map((c) => nameKey(c.name)));
  const calendarSlugs = new Set(survivor.calendars.map((c) => c.slug));
  const calendars = merged.calendars
    .filter((c) => !(fold && c.isDefault))
    .map((c) => {
      const name = calendarNames.has(nameKey(c.name))
        ? suffixedName(c.name, mergedName, calendarNames)
        : c.name;
      const slug = suffixedSlug(c.slug, calendarSlugs);
      calendarNames.add(nameKey(name));
      calendarSlugs.add(slug);
      if (name !== c.name || slug !== c.slug) {
        renames.push({
          id: c.id,
          kind: "calendar",
          from: { name: c.name, slug: c.slug },
          to: { name, slug },
        });
      }
      return { id: c.id, name, slug };
    });

  const spaceNames = new Set(survivor.spaces.map((x) => nameKey(x.name)));
  const spaces = merged.spaces
    .filter((x) => !(fold && x.id === merged.mainSpaceId))
    .map((x) => {
      const name = spaceNames.has(nameKey(x.name))
        ? suffixedName(x.name, mergedName, spaceNames)
        : x.name;
      spaceNames.add(nameKey(name));
      if (name !== x.name) {
        renames.push({ id: x.id, kind: "space", from: { name: x.name }, to: { name } });
      }
      return { id: x.id, name };
    });

  const layoutNames = new Set(survivor.layouts.map((l) => nameKey(l.name)));
  const layouts = merged.layouts.map((l) => {
    const name = layoutNames.has(nameKey(l.name))
      ? suffixedName(l.name, mergedName, layoutNames)
      : l.name;
    layoutNames.add(nameKey(name));
    if (name !== l.name) {
      renames.push({ id: l.id, kind: "layout", from: { name: l.name }, to: { name } });
    }
    return { id: l.id, name };
  });

  return { fold, calendars, spaces, layouts, renames };
}

export interface PlaceMergeStandardsPlan {
  dropItems: PlaceMergeStandardDrop[];
  dropExamples: PlaceMergeStandardDrop[];
  itemsMoved: number;
  itemsDropped: number;
  examplesMoved: number;
  examplesDropped: number;
}

/**
 * Booking standards are replace-all lists per (owner, intent), capped at 12
 * items / 3 examples. Concatenating two venues' lists would break the cap and
 * mix two checklists. Per intent:
 * - a merged PLACE list is dropped when the survivor's place has a list for
 *   that intent, otherwise it moves to the survivor's place;
 * - when the default calendars fold, the merged default CALENDAR list is
 *   dropped when the survivor's default calendar OR its place has a list for
 *   that intent (calendar rows override place rows on resolution), otherwise
 *   it moves to the survivor's default calendar;
 * - lists on a calendar that moves whole (including the merged default when
 *   the survivor has none) are not touched here and stay on it.
 * Dropped rows are kept in full in the audit row. Nothing references them.
 */
export function planPlaceMergeStandards(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
  counts: PlaceMergeCounts,
): PlaceMergeStandardsPlan {
  const fold = foldsDefaultCalendar(survivor, merged);
  const plan = (owners: PlaceMergeStandardsOwners) => {
    const drops: PlaceMergeStandardDrop[] = [];
    let moved = 0;
    let dropped = 0;
    const has = (list: PlaceMergeIntentCounts, intent: string) =>
      list.some((r) => r.intent === intent && r.count > 0);
    for (const r of owners.mergedPlace) {
      if (has(owners.survivorPlace, r.intent)) {
        drops.push({ ownerType: "PLACE", ownerId: merged.place.id, intent: r.intent });
        dropped += r.count;
      } else {
        moved += r.count;
      }
    }
    if (fold && merged.defaultCalendarId) {
      for (const r of owners.mergedDefaultCalendar) {
        // Calendar rows beat place rows on resolution, so the survivor "has
        // a list" for the folded calendar when its default calendar OR its
        // place has one; otherwise the merged calendar list would override
        // the survivor's place list.
        if (
          has(owners.survivorDefaultCalendar, r.intent) ||
          has(owners.survivorPlace, r.intent)
        ) {
          drops.push({
            ownerType: "CALENDAR",
            ownerId: merged.defaultCalendarId,
            intent: r.intent,
          });
          dropped += r.count;
        } else {
          moved += r.count;
        }
      }
    }
    return { drops, moved, dropped };
  };
  const items = plan(counts.operations.standards.items);
  const examples = plan(counts.operations.standards.examples);
  return {
    dropItems: items.drops,
    dropExamples: examples.drops,
    itemsMoved: items.moved,
    itemsDropped: items.dropped,
    examplesMoved: examples.moved,
    examplesDropped: examples.dropped,
  };
}

/** What the admin should know before confirming (none of it blocks). */
export function computePlaceMergeWarnings(
  counts: PlaceMergeCounts,
  reparent: PlaceMergeReparentPlan,
  standards: PlaceMergeStandardsPlan,
  owners: {
    compatible: boolean;
    merged: PlaceMergeRow;
    /** Merged active owners landing on an ownerless survivor; [] otherwise. */
    transferring?: { ownerType: string; ownerId: string }[];
  },
  grants: PlaceMergeGrantsPlan,
): PlaceMergeWarning[] {
  const warnings: PlaceMergeWarning[] = [];
  const add = (code: PlaceMergeWarningCode, count: number, ids?: string[]) => {
    if (count > 0) {
      warnings.push(
        ids && ids.length > 0
          ? { code, count, ids: ids.slice(0, PLACE_MERGE_ID_SAMPLE_CAP) }
          : { code, count },
      );
    }
  };
  const ops = counts.operations;
  add("AVAILABILITY_OVERLAP", ops.availabilityOverlaps.count, ops.availabilityOverlaps.ids);
  add("PLACE_WIDE_AVAILABILITY_MOVED", ops.placeWideAvailability);
  add("HOLDS_SAME_NIGHT", ops.holdSameNight.count, ops.holdSameNight.ids);
  add(
    "BOOKING_STANDARDS_REPLACED",
    standards.itemsDropped + standards.examplesDropped,
  );
  add(
    "NAMES_SUFFIXED",
    reparent.renames.length,
    reparent.renames.map((r) => r.id),
  );
  const deactivate = deactivatesMergedWaivers(counts, owners.compatible);
  add(
    "WAIVER_BECOMES_ACTIVE",
    !deactivate && ops.activeWaivers.survivor === 0 ? ops.activeWaivers.merged : 0,
  );
  add("WAIVERS_DEACTIVATED", deactivate ? ops.activeWaivers.merged : 0);
  add(
    "PAYOUT_DEFAULTS_NOT_CARRIED",
    owners.compatible
      ? 0
      : PAYOUT_DEFAULT_FIELDS.filter((f) => owners.merged[f] !== null).length,
  );
  if (grants.revoke) {
    add("GRANTS_ENDED", ops.activeGrants.count, ops.activeGrants.ids);
  } else if (grants.revokeWholePlace) {
    add("GRANTS_ENDED", ops.wholePlaceGrants.count, ops.wholePlaceGrants.ids);
  }
  add(
    "GRANTS_SPLIT",
    !grants.revoke && grants.splitOnto.length > 0 ? ops.wholePlaceGrants.count : 0,
    ops.wholePlaceGrants.ids,
  );
  const transferring = owners.transferring ?? [];
  if (transferring.length > 0) {
    warnings.push({
      code: "OWNERSHIP_TRANSFERS",
      count: transferring.length,
      owners: transferring.slice(0, PLACE_MERGE_ID_SAMPLE_CAP),
      survivorOpenBookingRequests: ops.survivorControl.openBookingRequests,
      survivorLiveAgreements: ops.survivorControl.liveAgreements,
    });
  }
  return warnings;
}

/** What happens to the two EntityPages (spec FR-004). */
export type PlaceMergePageAction =
  /** Follows, notices and slug history move; the merged page is deleted. */
  | "MOVE_TO_SURVIVOR_PAGE"
  /** The survivor has no page: the merged page becomes the survivor's. */
  | "TRANSFER_PAGE"
  /** The merged row has no page: nothing to do. */
  | "NONE";

export function placeMergePageAction(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): PlaceMergePageAction {
  if (!merged.page) return "NONE";
  return survivor.page ? "MOVE_TO_SURVIVOR_PAGE" : "TRANSFER_PAGE";
}

export interface PlaceMergeGrantsPlan {
  /** End every merged grant not yet revoked (owners not compatible). */
  revoke: boolean;
  /** Calendars a whole-place merged grant is split onto. */
  splitOnto: string[];
  /**
   * End the merged whole-place grants instead of splitting them: the owners
   * are compatible but the merged place brought no calendar, so moved as is
   * a calendarId-null grant would cover every survivor room.
   */
  revokeWholePlace: boolean;
}

/**
 * The merged active owners that become the survivor's owners: non-empty only
 * when the survivor has no active owner (FR-006 moves the merged rows).
 */
export function transferringOwners(
  survivor: PlaceMergeSide,
  merged: PlaceMergeSide,
): { ownerType: string; ownerId: string }[] {
  if (survivor.ownerships.some((o) => !o.revoked)) return [];
  return merged.ownerships
    .filter((o) => !o.revoked)
    .map((o) => ({ ownerType: o.ownerType, ownerId: o.ownerId }));
}

export type PlaceMergePlan = {
  /** `ownersCompatible`: owner-written settings may carry. */
  ownersCompatible: boolean;
  grants: PlaceMergeGrantsPlan;
  survivor: PlaceMergeSide;
  merged: PlaceMergeSide;
  counts: PlaceMergeCounts;
  blockers: PlaceMergeBlocker[];
  warnings: PlaceMergeWarning[];
  fill: ReturnType<typeof computePlaceMergeFill>;
  pageAction: PlaceMergePageAction;
  reparent: PlaceMergeReparentPlan;
  standards: PlaceMergeStandardsPlan;
  /** arrival-areas FR-012: each side's areas, as read (disabled included). */
  arrivalAreas: { survivor: ArrivalAreaRow[]; merged: ArrivalAreaRow[] };
  /**
   * arrival-areas FR-014: the ids of the event-only areas, on events at the
   * merged place, that the merge would switch off
   * (`eventAreasOutsideSurvivorPin` against `survivorPinAfterFill`).
   */
  eventArrivalAreasSwitchingOff: string[];
};

/**
 * The survivor's pin once the merge's fill has run: the merged row's point
 * when the address group fills (D2: only when the survivor has none), else
 * the survivor's own; null when neither has one. The merge reads the same
 * pin back from the filled row.
 */
export function survivorPinAfterFill(
  survivor: PlaceMergeRow,
  fill: ReturnType<typeof computePlaceMergeFill>,
): ArrivalAreaPin | null {
  const lat = "lat" in fill.patch ? fill.patch.lat : survivor.lat;
  const lng = "lng" in fill.patch ? fill.patch.lng : survivor.lng;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

/**
 * Read both sides and everything the decision needs. Throws PLACE_NOT_FOUND
 * when either row is missing. Inside `mergePlaces` this runs after the lock,
 * in the same transaction as the writes (no gap between check and act).
 */
export async function readPlaceMergePlan(
  repos: Pick<TxRepos, "placeMerge" | "arrivalAreas">,
  input: { survivorId: string; mergedId: string },
): Promise<PlaceMergePlan> {
  const [survivor, merged] = await Promise.all([
    repos.placeMerge.getSide(input.survivorId),
    repos.placeMerge.getSide(input.mergedId),
  ]);
  if (!survivor || !merged) {
    throw fail("PLACE_NOT_FOUND", {
      meta: {
        missing: [
          ...(survivor ? [] : [input.survivorId]),
          ...(merged ? [] : [input.mergedId]),
        ],
      },
    });
  }
  const counts = await repos.placeMerge.count({
    survivorId: survivor.place.id,
    mergedId: merged.place.id,
    survivorPageId: survivor.page?.id ?? null,
    mergedPageId: merged.page?.id ?? null,
    mergedDefaultCalendarId: merged.defaultCalendarId,
    mergedMainSpaceId: merged.mainSpaceId,
    survivorDefaultCalendarId: survivor.defaultCalendarId,
  });
  // arrival-areas FR-012. Inside `mergePlaces` this read runs under the
  // Place row locks (`lockForMerge`, FOR UPDATE), which conflict with the
  // FOR NO KEY UPDATE an area create takes on its place (`lockParent`), so
  // the count cannot move between this check and the move.
  const areaRows = await repos.arrivalAreas.listForPlaces([
    survivor.place.id,
    merged.place.id,
  ]);
  const arrivalAreas = {
    survivor: areaRows.filter((row) => row.placeId === survivor.place.id),
    merged: areaRows.filter((row) => row.placeId === merged.place.id),
  };
  const areaBlocker = arrivalAreaLimitBlocker(
    survivor.place.id,
    merged.place.id,
    arrivalAreas,
  );
  const reparent = planPlaceMergeReparent(survivor, merged);
  const standards = planPlaceMergeStandards(survivor, merged, counts);
  const compatible = ownersCompatible(survivor, merged);
  const fill = computePlaceMergeFill(survivor.place, merged.place, {
    carryPayoutDefaults: compatible,
  });
  // FR-014: the events at the merged place are the ones the merge repoints.
  const pinAfterFill = survivorPinAfterFill(survivor.place, fill);
  const switchingOff = eventAreasOutsideSurvivorPin(
    await repos.arrivalAreas.listEventAreasAtPlace(merged.place.id),
    pinAfterFill,
  ).map((row) => row.id);
  // FR-012: a non-active merged place's page showed none of its areas. The
  // ones the survivor's page will show a signed-out visitor after the merge
  // (the place-page read's own rule, on the survivor as filled) become
  // public. A non-active survivor is a blocker and shows nothing anyway.
  const becomingPublic =
    merged.place.status !== "ACTIVE"
      ? anonymousPlacePageAreaIds(
          { ...survivor.place, ...fill.patch },
          arrivalAreas.merged,
        )
      : [];
  const splitOnto = wholePlaceGrantTargets(survivor, merged, reparent);
  const grants: PlaceMergeGrantsPlan = {
    revoke: !compatible,
    splitOnto,
    revokeWholePlace:
      compatible &&
      splitOnto.length === 0 &&
      counts.operations.wholePlaceGrants.count > 0,
  };
  return {
    ownersCompatible: compatible,
    grants,
    survivor,
    merged,
    counts,
    blockers: [
      ...computePlaceMergeBlockers(survivor, merged, counts),
      ...(areaBlocker ? [areaBlocker] : []),
    ],
    warnings: [
      ...computePlaceMergeWarnings(
        counts,
        reparent,
        standards,
        {
          compatible,
          merged: merged.place,
          transferring: transferringOwners(survivor, merged),
        },
        grants,
      ),
      ...(switchingOff.length > 0
        ? [
            {
              code: "EVENT_ARRIVAL_AREAS_SWITCH_OFF" as const,
              count: switchingOff.length,
              ids: switchingOff.slice(0, PLACE_MERGE_ID_SAMPLE_CAP),
              survivorHasPin: pinAfterFill !== null,
            },
          ]
        : []),
      ...(becomingPublic.length > 0
        ? [
            {
              code: "MERGED_PLACE_AREAS_BECOME_PUBLIC" as const,
              count: becomingPublic.length,
              ids: becomingPublic.slice(0, PLACE_MERGE_ID_SAMPLE_CAP),
            },
          ]
        : []),
    ],
    fill,
    pageAction: placeMergePageAction(survivor, merged),
    reparent,
    standards,
    arrivalAreas,
    eventArrivalAreasSwitchingOff: switchingOff,
  };
}
