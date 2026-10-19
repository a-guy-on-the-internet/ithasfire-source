/**
 * publishPageDraft: write the page's shared draft live and clear it (page
 * editor spec docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml,
 * R2, R9, R13, FR-011, FR-016, FR-017, FR-022; storage and the PUBLISH RULE:
 * `model PageDraft` in packages/db/prisma/entity-page.prisma).
 *
 * Same authz as updatePage (R13: canManagePlace for PLACE pages; no new
 * role; entity-page-access.ts). A Place patch is written under upsertPlace's
 * own write check too (`assertPlaceWriteAccess`: the same verified owners
 * and ORG_EDIT_ROLES).
 *
 * A community moderator on a PLACE nobody owns (moderator place page spec,
 * owner ruling 2026-10-15) publishes under the place's claim lock, taken
 * FIRST in the transaction (before the draft row) and re-checked there, so a
 * claim that landed since the advisory check refuses the publish and
 * nothing is written; a publish logs `entity_page.community_updated` in the
 * same transaction. ONE rule for moderators across save, discard and
 * publish: a moderator may not change an owner's pending Place patch in any
 * way, and never sees it. Here a draft whose STORED Place patch is non-empty
 * is `refused` for a moderator (`place_fact_not_for_moderator`), before the
 * conflict step and whatever the resolutions say; Place facts go through
 * `updateCommunityPlace` and its rules (D3), never writePlaceInTx.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 * Lock order PageDraft, then EntityPage, then Place (the order every draft
 * caller uses; see EntityPagesRepo). A community moderator takes the
 * place's claim advisory lock (`lockPlaceForClaim`) FIRST, before PageDraft
 * (the order claim submit and review use), and re-runs the access rules:
 *   0. (moderator only) lockPlaceForClaim and the re-check.
 *   1. lockDraftForUpdate, then the three-branch rule, EQUALITY ONLY:
 *      (b) lastPublishedRevision == draftRevision + 1: this caller's own
 *          Publish already happened (a lost-response retry). Answered as
 *          `published` with `replayed: true`; nothing written; edits saved
 *          since stay in the draft.
 *      (a) revision == draftRevision and the draft is non-empty: publish.
 *      (c) anything else: `discarded` (with who) ONLY when revision ==
 *          draftRevision + 1 and the overlays are empty (a Discard won the
 *          race); every other case is a neutral `stale` and the client
 *          refetches. A non-empty draft newer than draftRevision is NEVER
 *          published.
 *   2. Validate EVERYTHING the draft says before any lock or write, so a
 *      refusal writes nothing: the Place patch through upsertPlace's
 *      schema, page and theme leaves through the draft field tables, every
 *      written block field through the save-time check
 *      (`checkBlockFieldValue`: data schemas, rich-text sanitising, the
 *      image-URL rule), new block kinds, zones, pinned rules. Refusals come
 *      back as `refused` (draft validation) or throw the live path's typed
 *      error (BLOCK_PINNED).
 *   3. Place conflicts (R9). With a Place patch, the place-location lock
 *      (`events.lockLocationsAtPlace` exclusive, the lock every upsertPlace
 *      takes before reading Place) and a read of Place under it, then the
 *      owner re-check on that row. For every field in placePatch (never
 *      placeBase): a resolution counts only when its `live` equals the
 *      live value now (it was chosen against this value); a stale one, or
 *      no resolution where live != placeBase[field] and live != the draft's
 *      value, => `conflicts` with the current live value, nothing written.
 *      "theirs" drops the field from the patch; "mine" keeps it.
 *      The lock is an advisory lock, not the Place row: taking it before the
 *      EntityPage write keeps the row order PageDraft → EntityPage → Place,
 *      and no path holds an EntityPage or PageDraft row while waiting on it.
 *      Then slug availability (SLUG_TAKEN, as updatePage).
 *   4. Writes: EntityPage (slug history first), PageTheme, PageBlocks
 *      (delete, update, create, then the whole order: resolveMainOrder for
 *      the main column, other sections after it in their stored order),
 *      then Place through `writePlaceInTx`, upsertPlace's own write path
 *      (cascade, tax rate, timezone, privacy scrub). A new block with no
 *      content is not created (FR-011). Rich-text fields are stored as
 *      sanitised HTML, and EVERY live main-section block's rich-text field
 *      is converted on publish, edited or not: legacy plain text becomes
 *      paragraphs (FR-022). Publish is unreachable until the transport
 *      (step 9), and the public HTML renderer (step 7) lands first.
 *   5. cancelPending over the WHOLE draft's image keys (the generous scan):
 *      an image a Discard queued for deletion and that this Publish makes
 *      live must never be deleted.
 *   6. The search reindex mark (the page's owner document) and an audit row.
 *   7. clearDraft in ONE UPDATE: revision and lastPublishedRevision both
 *      become draftRevision + 1. The row is never deleted.
 * After commit: the best-effort reindex (and, when Place was written, the
 * re-projected events'), exactly as upsertPlace / updatePage do.
 *
 * There is no catch in this use case. A 40P01 deadlock against a concurrent
 * page deletion (see EntityPagesRepo), a P2002 mapped to BLOCK_PINNED by the
 * adapter, or any other failure rolls the whole transaction back and
 * SURFACES; the draft is untouched.
 *
 * R19: the overlay is applied generically. Page and theme leaves go through
 * the draft field tables (one row per field), block fields through
 * BlockConfig, image fields by field kind, the order through the zone table.
 * A new draftable page/theme/block field or a looser zone table needs no
 * change here. A new draftable PLACE field does: `PLACE_WRITE_FIELDS` maps
 * each one onto the Place write and is exhaustive over the field table, so
 * a missing entry fails typecheck instead of being dropped silently.
 *
 * SERVER-ONLY (imports page-draft-ops and upsert-place). Import by subpath:
 * `@th/core/use-cases/entity-pages/publish-page-draft`.
 */

import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PlaceRecord, Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import type {
  EntityPageRecord,
  PageBlockRecord,
  PageDraftRecord,
  PageOwnerType,
  PageThemeRecord,
  UpsertEntityPageInput,
  UpsertPageThemeInput,
} from "@th/types/repos/entity-pages";

import { parseInput } from "../../lib/io";
import { parsePageRichText } from "../../lib/page-rich-text";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  afterPlaceWriteCommitted,
  assertPlaceWriteAccess,
  ensureOwnerMatches,
  normalizeAddress,
  preparePlaceTaxRate,
  upsertPlaceInputSchema,
  writePlaceInTx,
  type NormalizedPlaceAddress,
  type PlaceWriteInput,
  type PlaceWriteResult,
  type PreparedPlaceTaxRate,
  type UpsertPlaceInput,
} from "../places/upsert-place";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import {
  markForSearchReindex,
  type SearchReindexSelector,
} from "../search/search-reindex-marks";
import {
  blockImageUrlsIn,
  getBlockConfig,
  getDefaultBlockData,
  getPaletteBlockConfigs,
  isPinnedBlockKind,
  isValidBlockKind,
} from "./block-config";
import { normalizeBlockSection } from "./block-sections";
import type { PinnedRefusal } from "./manage-page-blocks";
import {
  PAGE_DRAFT_FORMAT_VERSION,
  PAGE_DRAFT_PAGE_FIELDS,
  PAGE_DRAFT_PLACE_FIELDS,
  PAGE_DRAFT_THEME_FIELDS,
  PAGE_DRAFT_VERSION_KEY,
  applyOverlay,
  blockHasContent,
  changeCount,
  checkBlockFieldValue,
  draftFormatVersion,
  draftValuesEqual,
  isEmptyDraft,
  parsePageDraftPath,
  placeDraftFactsFromRecord,
  type PageDraftOpError,
  type PageDraftOpErrorCode,
  type PageDraftPlaceField,
} from "./page-draft-ops";
import {
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  type EntityPageEditor,
} from "./entity-page-access";
import {
  PAGE_DRAFT_DISCARD_DELETION_SOURCE,
  loadPageForDraft,
  pageDraftOwnerInputShape,
  pageImageScope,
  requireDraftLayout,
} from "./page-draft-shared";
import type { PageDraftEditorInfo } from "./get-page-draft";
import {
  chunkPageImageKeys,
  ownedStrippedPageImageKeyFromUrl,
  pageImageKeysMentionedIn,
  type PageImageUrlScope,
} from "./page-image-urls";
import { canPlace, zoneOf, type PageZoneLayout } from "./page-zones";

// ── Input ──────────────────────────────────────────────────────────────────

const PLACE_FIELD_NAMES = Object.keys(
  PAGE_DRAFT_PLACE_FIELDS,
) as PageDraftPlaceField[];

const placeConflictChoiceSchema = z.enum(["mine", "theirs"]);
export type PlaceConflictChoice = z.infer<typeof placeConflictChoiceSchema>;

/**
 * The editor's pick for one conflicting Place field, BOUND to the live value
 * the picker showed (`PlaceFieldConflict.live`). It counts only while Place
 * still holds that value: a Settings edit after the picker opened, or a
 * resolution sent before any conflict was shown, is a conflict again.
 */
const placeConflictResolutionSchema = z
  .object({
    choice: placeConflictChoiceSchema,
    live: z.unknown(),
  })
  .strict()
  .refine((value) => Object.prototype.hasOwnProperty.call(value, "live"), {
    message: "live is required",
    path: ["live"],
  });
export type PlaceConflictResolution = {
  choice: PlaceConflictChoice;
  live: unknown;
};

/** One optional resolution per draftable Place field (the field table). */
const resolutionsSchema = z
  .object(
    Object.fromEntries(
      PLACE_FIELD_NAMES.map((field) => [
        field,
        placeConflictResolutionSchema.optional(),
      ]),
    ) as Record<
      PageDraftPlaceField,
      z.ZodOptional<typeof placeConflictResolutionSchema>
    >,
  )
  .strict();

export const publishPageDraftInputSchema = z
  .object({
    ...pageDraftOwnerInputShape,
    /** The draft revision the editor is publishing (its idempotency key). */
    draftRevision: z.number().int().min(0),
    /**
     * Per Place field: keep the draft's value ("mine") or live ("theirs"),
     * with the live value the choice was made against.
     */
    resolutions: resolutionsSchema.optional(),
  })
  .strict();

export type PublishPageDraftInput = z.infer<typeof publishPageDraftInputSchema>;

// ── Output ─────────────────────────────────────────────────────────────────

/** A Place field Settings changed since the draft first touched it (R9). */
export type PlaceFieldConflict = {
  field: PageDraftPlaceField;
  /** The live value when the draft first set the field. */
  base: unknown;
  /** The live value now. */
  live: unknown;
  /** The draft's value. */
  mine: unknown;
};

export type PublishPageDraftOutput =
  | {
      outcome: "published";
      /** false: this call published. */
      replayed: false;
      /** The revision the draft was cleared to (draftRevision + 1). */
      publishedRevision: number;
      /** The draft revision after this call (= publishedRevision). */
      revision: number;
      /** `new:<uuid>` draft id → the created block's id. */
      createdBlockIds: Record<string, string>;
      /** New blocks without content, not created (FR-011). */
      skippedEmptyBlockIds: string[];
      /** Whether the venue's Place row was written. */
      placeWritten: boolean;
    }
  | {
      outcome: "published";
      /** true: an earlier call with this draftRevision published; nothing written now. */
      replayed: true;
      publishedRevision: number;
      /** The draft revision now (edits saved since the publish stay pending). */
      revision: number;
    }
  | {
      /** Place fields changed live since the draft took them; nothing written. */
      outcome: "conflicts";
      revision: number;
      conflicts: PlaceFieldConflict[];
    }
  | {
      /** The draft holds something this code will not write; nothing written. */
      outcome: "refused";
      revision: number;
      errors: PageDraftOpError[];
    }
  | {
      /** Another editor discarded the draft this call meant to publish. */
      outcome: "discarded";
      revision: number;
      /** Who discarded it; null when the account no longer resolves. */
      discardedBy: PageDraftEditorInfo | null;
    }
  | {
      /** The draft is not at draftRevision (or is empty): refetch. */
      outcome: "stale";
      revision: number;
    };

// ── Deps ───────────────────────────────────────────────────────────────────

export type PublishPageDraftDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  clock: ClockPort;
  /**
   * The file storage's public base URL (S3_PUBLIC_BASE_URL): which image
   * URLs are this page's own uploads. Null = none are, so only image URLs
   * already live are accepted (fail closed).
   */
  storagePublicBaseUrl: string | null;
  logger?: LoggerPort;
  /** Forwarded to the Place write's privacy scrub and the post-commit reindex. */
  search?: MultiSearchPort;
  /** The Place write's admission tax-rate lookup (upsertPlace's dep). */
  taxRateLookup?: TaxRateLookupPort | null;
  /** The Place write's timezone lookup (upsertPlace's dep). */
  timezoneLookup?: TimezoneLookupPort | null;
  /**
   * Forwarded to the swallow-and-report branches of the Place write (tax
   * rate, timezone) and of the post-commit reindex. This use case has no
   * swallow of its own.
   */
  reportError?: ReporterPort;
};

// ── Place patch ────────────────────────────────────────────────────────────

/** upsertPlace's schema, narrowed to the draftable Place fields (the table). */
const placePatchSchema = upsertPlaceInputSchema
  .pick(
    Object.fromEntries(PLACE_FIELD_NAMES.map((field) => [field, true])) as {
      [K in PageDraftPlaceField]: true;
    },
  )
  .partial()
  .strict();

type ValidatedPlacePatch = z.infer<typeof placePatchSchema>;

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * The draft's Place patch with every "theirs" pick dropped. Before the
 * transaction (the tax prepare) and for validation; whether each pick still
 * holds is decided under the place-location lock, and a stale one stops the
 * publish there, so this never decides what is written on its own.
 */
function effectivePlacePatch(
  placePatch: Record<string, unknown>,
  resolutions: Partial<Record<string, PlaceConflictResolution>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(placePatch)) {
    if (resolutions[field]?.choice !== "theirs") patch[field] = value;
  }
  return patch;
}

/**
 * The stored address as the Place write takes it, when the patch does not
 * touch the address: every column is rewritten with the value it holds.
 * `line1` is left OUT when the stored line is NULL (omitted = the adapter
 * leaves the column alone). Callers refuse a row with no country or no
 * formatted address first (`storedAddressIncomplete`): the port has no
 * "leave the address alone" form, and `""` there would read as a
 * jurisdiction change and clear the cached tax rate.
 */
function storedNormalizedAddress(place: PlaceRecord): NormalizedPlaceAddress {
  return {
    formatted: place.formattedAddress ?? "",
    ...(place.addressLine1 !== null && { line1: place.addressLine1 }),
    line2: place.addressLine2,
    city: place.city,
    region: place.region,
    postalCode: place.postalCode,
    countryCode: place.countryCode ?? "",
    lat: place.lat ?? undefined,
    lng: place.lng ?? undefined,
  };
}

/** A stored address the Place write cannot re-send unchanged. */
function storedAddressIncomplete(place: PlaceRecord): boolean {
  return !place.countryCode || place.formattedAddress === null;
}

/**
 * `PlaceWriteInput.address` for an unpatched address. INERT: writePlaceInTx
 * writes `ctx.normalizedAddress` (the stored address above); this only
 * satisfies the input type.
 */
function inertAddressInput(
  stored: NormalizedPlaceAddress,
): UpsertPlaceInput["address"] {
  return {
    formatted: stored.formatted,
    ...(stored.line1 !== undefined && { line1: stored.line1 }),
    ...(stored.line2 && { line2: stored.line2 }),
    ...(stored.city && { city: stored.city }),
    ...(stored.region && { region: stored.region }),
    ...(stored.postalCode && { postalCode: stored.postalCode }),
    countryCode: stored.countryCode,
    ...(stored.lat !== undefined &&
      stored.lng !== undefined && { lat: stored.lat, lng: stored.lng }),
  };
}

type PlaceWriteFields = Omit<
  PlaceWriteInput,
  "placeId" | "actorHumanId" | "owner"
>;

/**
 * How each draftable Place field reaches the Place write, given the
 * validated patch and the live row. EXHAUSTIVE over the field table
 * (`satisfies Record<PageDraftPlaceField, …>`): a new draftable field must
 * say how it is written, or typecheck fails. Name, capacity, phone and
 * website are rewritten on every Place write, so an unpatched one carries
 * its live value; the location-privacy fields are omitted unless patched
 * (upsertPlace: omitted = keep). The address goes in as `normalizedAddress`
 * (see `placeWriteContextAddress`); its `input.address` is inert.
 */
const PLACE_WRITE_FIELDS = {
  name: (patch, place) => ({ name: patch.name ?? place.name }),
  address: () => ({}),
  capacity: (patch, place) => ({
    capacity: hasOwn(patch, "capacity")
      ? patch.capacity
      : (place.capacity ?? undefined),
  }),
  phone: (patch, place) => ({
    phone: hasOwn(patch, "phone") ? patch.phone : place.phone,
  }),
  website: (patch, place) => ({
    website: hasOwn(patch, "website") ? patch.website : place.website,
  }),
  locationMode: (patch) =>
    hasOwn(patch, "locationMode") ? { locationMode: patch.locationMode } : {},
  locationRadiusMeters: (patch) =>
    hasOwn(patch, "locationRadiusMeters")
      ? { locationRadiusMeters: patch.locationRadiusMeters }
      : {},
  locationLabel: (patch) =>
    hasOwn(patch, "locationLabel")
      ? { locationLabel: patch.locationLabel }
      : {},
} satisfies Record<
  PageDraftPlaceField,
  (patch: ValidatedPlacePatch, place: PlaceRecord) => Partial<PlaceWriteFields>
>;

/** The address the Place write stores: the patch's, else the stored one. */
function placeWriteContextAddress(
  place: PlaceRecord,
  patch: ValidatedPlacePatch,
): NormalizedPlaceAddress {
  return patch.address !== undefined
    ? normalizeAddress(patch.address)
    : storedNormalizedAddress(place);
}

/**
 * The full upsertPlace write input: the live row, with the validated patch
 * over it, field by field through `PLACE_WRITE_FIELDS`.
 */
function placeWriteInput(
  place: PlaceRecord,
  patch: ValidatedPlacePatch,
  owner: UpsertPlaceInput["owner"],
  actorHumanId: string,
  normalizedAddress: NormalizedPlaceAddress,
): PlaceWriteInput {
  let fields: Partial<PlaceWriteFields> = {};
  for (const field of PLACE_FIELD_NAMES) {
    fields = { ...fields, ...PLACE_WRITE_FIELDS[field](patch, place) };
  }
  return {
    ...fields,
    placeId: place.id,
    actorHumanId,
    owner,
    name: fields.name ?? place.name,
    address: patch.address ?? inertAddressInput(normalizedAddress),
  };
}

/**
 * Who the Place write runs as (upsertPlace's `owner`): the actor as a
 * verified human owner, else the first owning org where the actor holds an
 * ORG_EDIT_ROLES role. The same two routes canManagePlace allows (R13).
 */
async function placeWriteOwner(
  repos: Pick<Repos, "authz">,
  place: PlaceRecord,
  actorHumanId: string,
): Promise<UpsertPlaceInput["owner"]> {
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return { kind: "human", humanId: actorHumanId };
  }
  for (const orgId of place.orgIdsWithAccess) {
    const membership = await repos.authz.getOrgMembership({
      orgId,
      humanId: actorHumanId,
    });
    if (membership && ORG_EDIT_ROLES.includes(membership.role)) {
      return { kind: "org", orgId };
    }
  }
  fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
}

/** What the Place write needs from BEFORE the transaction. */
type PreparedPlaceWrite = {
  /** The draft revision this was prepared from. */
  revision: number;
  owner: UpsertPlaceInput["owner"];
  /** The tax-rate PREPARE half; null when the patch keeps the address. */
  tax: PreparedPlaceTaxRate | null;
};

/**
 * Outside the transaction, as upsertPlace does: authorise the Place write
 * and, when the patch changes the address, run the admission tax-rate
 * lookup (a live HTTP call that must not hold the locks). Prepared from the
 * draft at `draftRevision`; revisions never repeat, so the locked draft in
 * branch (a) holds exactly this patch. Returns null when there is nothing to
 * write to Place (or the draft is not at draftRevision, which the
 * transaction answers without publishing).
 */
async function preparePlaceWrite(
  deps: PublishPageDraftDeps,
  logger: LoggerPort | undefined,
  input: PublishPageDraftInput,
  pageId: string,
  editor: EntityPageEditor,
): Promise<PreparedPlaceWrite | null> {
  if (input.ownerType !== "PLACE") return null;
  // A moderator's Place patch is refused in the transaction (D3).
  if (editor.kind === "community_moderator") return null;
  const draft = await deps.repos.entityPages.getDraft(pageId);
  if (!draft || draft.revision !== input.draftRevision) return null;
  const patch = effectivePlacePatch(draft.placePatch, input.resolutions ?? {});
  if (Object.keys(patch).length === 0) return null;

  const place = await deps.repos.places.getById(input.ownerId);
  if (!place) fail("OWNER_NOT_FOUND", { meta: { entity: "place" } });
  const owner = await placeWriteOwner(deps.repos, place, input.actorHumanId);
  await assertPlaceWriteAccess(deps.repos, input.actorHumanId, owner, place);

  let tax: PreparedPlaceTaxRate | null = null;
  if (hasOwn(patch, "address")) {
    // An invalid address is refused inside the transaction; no lookup.
    const address = placePatchSchema.shape.address.safeParse(patch.address);
    if (address.success && address.data !== undefined) {
      tax = await preparePlaceTaxRate(
        deps,
        logger,
        place,
        normalizeAddress(address.data),
      );
    }
  }
  return { revision: draft.revision, owner, tax };
}

// ── The publish plan (pure; computed before any write) ─────────────────────

type BlockUpdate = {
  id: string;
  data?: Record<string, unknown>;
  visible?: boolean;
};
type BlockCreate = {
  draftId: string;
  kind: string;
  data: Record<string, unknown>;
  visible: boolean;
};

type PublishPlan = {
  page: Partial<UpsertEntityPageInput>;
  theme: Omit<UpsertPageThemeInput, "pageId"> | null;
  deletes: string[];
  updates: BlockUpdate[];
  creates: BlockCreate[];
  skippedEmptyBlockIds: string[];
  /** Main column, top to bottom: live ids and `new:<uuid>` (created only). */
  mainOrder: string[];
};

type Refusal = PageDraftOpError;

function refusal(
  path: string | null,
  code: PageDraftOpErrorCode,
  meta?: PageDraftOpError["meta"],
): Refusal {
  return { index: -1, path, code, ...(meta && { meta }) };
}

function pinnedFailure(kind: string, attempted: PinnedRefusal): never {
  // The same typed error managePageBlocks raises (and the adapter maps a
  // pinned-index P2002 to).
  fail("BLOCK_PINNED", {
    message: `'${kind}' is pinned: it can be reordered but not removed, hidden, re-kinded, added twice, or filed outside the main section (attempted: ${attempted})`,
    meta: { kind, attempted },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type PlanContext = {
  ownerType: PageOwnerType;
  layout: PageZoneLayout;
  livePage: EntityPageRecord;
  liveTheme: PageThemeRecord | null;
  liveBlocks: readonly PageBlockRecord[];
  draft: PageDraftRecord;
  imageScope: PageImageUrlScope;
};

/** Every `blocks.<id>.data.<field>` leaf, grouped by block id. */
function blockDataLeaves(
  data: Record<string, unknown>,
): Map<string, Map<string, unknown>> {
  const result = new Map<string, Map<string, unknown>>();
  for (const [path, value] of Object.entries(data)) {
    const parsed = parsePageDraftPath(path);
    if (!parsed.ok || parsed.target.area !== "blockData") continue;
    const fields = result.get(parsed.target.blockId) ?? new Map();
    fields.set(parsed.target.field, value);
    result.set(parsed.target.blockId, fields);
  }
  return result;
}

/**
 * A block's next data: `base` with the draft's leaves (each re-validated as
 * save validates it, rich text sanitised there; null unsets the field), then
 * every rich-text field the leaves did NOT set (the live or default value)
 * stored as sanitised HTML, legacy plain text converted (FR-022). A leaf's
 * value is never sanitised twice.
 */
function nextBlockData(
  kind: string,
  blockId: string,
  base: Record<string, unknown>,
  leaves: ReadonlyMap<string, unknown> | undefined,
  isAllowedBlockImageUrl: (url: string) => boolean,
  refusals: Refusal[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  const fromLeaves = new Set<string>();
  for (const [field, value] of leaves ?? []) {
    fromLeaves.add(field);
    const path = `blocks.${blockId}.data.${field}`;
    const check = checkBlockFieldValue(
      kind,
      field,
      value,
      isAllowedBlockImageUrl,
    );
    if (!check.ok) {
      refusals.push(refusal(path, check.code, check.meta));
      continue;
    }
    if (check.value === null) delete next[field];
    else next[field] = check.value;
  }
  for (const field of getBlockConfig(kind)?.fields ?? []) {
    if (field.kind !== "richText" || fromLeaves.has(field.name)) continue;
    const value = next[field.name];
    if (typeof value !== "string") continue;
    const rich = parsePageRichText(value);
    if (!rich.ok) {
      refusals.push(
        refusal(`blocks.${blockId}.data.${field.name}`, rich.code, {
          max: rich.max,
        }),
      );
      continue;
    }
    next[field.name] = rich.html;
  }
  return next;
}

/**
 * Everything Publish will write, validated, from the locked draft over the
 * live rows. Refusals are collected (nothing is written when there are
 * any); pinned violations throw BLOCK_PINNED as the live path does.
 */
function planPublish(ctx: PlanContext): {
  plan: PublishPlan;
  refusals: Refusal[];
} {
  const { draft, livePage, layout } = ctx;
  const refusals: Refusal[] = [];
  const plan: PublishPlan = {
    page: {},
    theme: null,
    deletes: [],
    updates: [],
    creates: [],
    skippedEmptyBlockIds: [],
    mainOrder: [],
  };

  if (draftFormatVersion(draft.data) !== PAGE_DRAFT_FORMAT_VERSION) {
    refusals.push(refusal(null, "draft_version_unsupported"));
    return { plan, refusals };
  }

  // A NEW image must be this page's metadata-STRIPPED upload; a URL the
  // live page already shows keeps passing (checked per field below).
  const isAllowedImageUrl = (url: string) =>
    ownedStrippedPageImageKeyFromUrl(url, ctx.imageScope) !== null;
  const liveImageUrls = blockImageUrlsIn(ctx.liveBlocks);
  const isAllowedBlockImageUrl = (url: string) =>
    isAllowedImageUrl(url) || liveImageUrls.has(url);

  // Page and theme leaves, generically through the draft field tables.
  const theme: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(draft.data)) {
    if (path === PAGE_DRAFT_VERSION_KEY) continue;
    const parsed = parsePageDraftPath(path);
    if (!parsed.ok) {
      refusals.push(refusal(path, parsed.code));
      continue;
    }
    const { target } = parsed;
    if (target.area !== "page" && target.area !== "theme") continue;
    const spec =
      target.area === "page"
        ? PAGE_DRAFT_PAGE_FIELDS[target.field]
        : PAGE_DRAFT_THEME_FIELDS[target.field];
    const result = spec.schema.safeParse(value);
    if (!result.success || result.data === undefined) {
      refusals.push(
        refusal(path, "value_invalid", {
          issues: result.success
            ? ["required"]
            : result.error.issues.map((issue) => issue.message),
        }),
      );
      continue;
    }
    if (target.area === "page") {
      // An image field takes this page's own upload, or keeps its live URL.
      if (
        "imageUrl" in spec &&
        spec.imageUrl &&
        typeof result.data === "string" &&
        result.data !== livePage[target.field as keyof EntityPageRecord] &&
        !isAllowedImageUrl(result.data)
      ) {
        refusals.push(refusal(path, "image_url_not_allowed"));
        continue;
      }
      (plan.page as Record<string, unknown>)[target.field] = result.data;
    } else {
      theme[target.field] = result.data;
    }
  }
  if (Object.keys(theme).length > 0) {
    plan.theme = theme as Omit<UpsertPageThemeInput, "pageId">;
  }

  // Blocks: the overlay gives the effective main column (order, removals,
  // new blocks); every written field is re-checked from the raw leaves.
  const view = applyOverlay(
    {
      page: livePage,
      theme: ctx.liveTheme,
      blocks: ctx.liveBlocks,
      place: null,
    },
    draft,
    layout,
  );
  const leaves = blockDataLeaves(draft.data);
  const liveById = new Map(ctx.liveBlocks.map((block) => [block.id, block]));

  for (const removedId of view.removedBlockIds) {
    const live = liveById.get(removedId)!;
    if (isPinnedBlockKind(live.kind)) pinnedFailure(live.kind, "delete");
    plan.deletes.push(removedId);
  }

  const presentKinds = view.blocks
    .filter(
      (block) =>
        !block.isNew && normalizeBlockSection(block.section) === "main",
    )
    .map((block) => block.kind);
  const mainKinds: string[] = [];

  for (const block of view.blocks) {
    if (normalizeBlockSection(block.section) !== "main") continue;
    const visibleLeaf = draft.data[`blocks.${block.id}.visible`];
    if (visibleLeaf !== undefined && typeof visibleLeaf !== "boolean") {
      refusals.push(
        refusal(`blocks.${block.id}.visible`, "value_invalid", {
          issues: ["expected_boolean"],
        }),
      );
      continue;
    }

    if (!block.isNew) {
      const live = liveById.get(block.id)!;
      const liveData = asRecord(live.data);
      const data = nextBlockData(
        live.kind,
        block.id,
        liveData,
        leaves.get(block.id),
        isAllowedBlockImageUrl,
        refusals,
      );
      const update: BlockUpdate = { id: block.id };
      if (!draftValuesEqual(data, liveData)) update.data = data;
      if (typeof visibleLeaf === "boolean" && visibleLeaf !== live.visible) {
        if (!visibleLeaf && isPinnedBlockKind(live.kind)) {
          pinnedFailure(live.kind, "hide");
        }
        update.visible = visibleLeaf;
      }
      if (update.data !== undefined || update.visible !== undefined) {
        plan.updates.push(update);
      }
      plan.mainOrder.push(block.id);
      mainKinds.push(live.kind);
      continue;
    }

    // A block added in the draft.
    const kindPath = `blocks.${block.id}.kind`;
    if (!isValidBlockKind(ctx.ownerType, block.kind)) {
      refusals.push(
        refusal(kindPath, "block_kind_invalid", { kind: block.kind }),
      );
      continue;
    }
    if (zoneOf(block.kind, layout).where === "none") {
      refusals.push(refusal(kindPath, "not_on_layout", { kind: block.kind }));
      continue;
    }
    const pinned = isPinnedBlockKind(block.kind);
    if (pinned) {
      if (presentKinds.includes(block.kind)) {
        pinnedFailure(block.kind, "add_duplicate");
      }
    } else if (
      !getPaletteBlockConfigs(ctx.ownerType).some(
        (config) => config.kind === block.kind,
      )
    ) {
      refusals.push(
        refusal(kindPath, "block_kind_not_addable", { kind: block.kind }),
      );
      continue;
    }
    // From the kind's defaults (not the view's data, which holds the leaves
    // unchecked): nextBlockData applies each leaf checked.
    const data = nextBlockData(
      block.kind,
      block.id,
      getDefaultBlockData(block.kind),
      leaves.get(block.id),
      isAllowedBlockImageUrl,
      refusals,
    );
    if (!blockHasContent(block.kind, data)) {
      plan.skippedEmptyBlockIds.push(block.id);
      continue;
    }
    const visible = typeof visibleLeaf === "boolean" ? visibleLeaf : true;
    if (!visible && pinned) pinnedFailure(block.kind, "add_hidden");
    plan.creates.push({ draftId: block.id, kind: block.kind, data, visible });
    plan.mainOrder.push(block.id);
    mainKinds.push(block.kind);
  }

  const zones = canPlace(mainKinds, layout);
  if (!zones.ok) {
    refusals.push(
      refusal("order.main", zones.reason, {
        kind: zones.kind,
        ...(zones.after !== undefined && { after: zones.after }),
        ...(zones.lock !== undefined && { lock: zones.lock }),
      }),
    );
  }
  return { plan, refusals };
}

// ── Use case ───────────────────────────────────────────────────────────────

function searchSelectorFor(
  ownerType: PageOwnerType,
  ownerId: string,
): SearchReindexSelector {
  // The page's owner document shows its name, bio, slug and visibility
  // (the same selector updatePage marks).
  return {
    kind:
      ownerType === "HUMAN"
        ? "human"
        : ownerType === "ORGANIZATION"
          ? "organization"
          : "place",
    id: ownerId,
  };
}

/** What the transaction hands back: the answer, and the post-commit work. */
type TxOutcome = {
  output: PublishPageDraftOutput;
  /** Set when this call published (post-commit reindex). */
  committed: { placeWrite: PlaceWriteResult | null } | null;
};

/** A block as a moderator publish's audit row records it. */
function blockAuditSnapshot(block: PageBlockRecord) {
  return {
    blockId: block.id,
    kind: block.kind,
    visible: block.visible,
    data: block.data,
  };
}

/**
 * A moderator publish's audit `fields` / `from` / `to` (decision D5; values
 * bounded by logCommunityPageUpdate): the live values
 * the plan replaced and what it wrote. Page and theme keys are the plan's
 * own; blocks are the deleted and updated rows as they were, and the
 * created ones with their new ids; the order only when it changed.
 */
function publishChanges(args: {
  livePage: EntityPageRecord;
  liveTheme: PageThemeRecord | null;
  liveBlocks: readonly PageBlockRecord[];
  plan: PublishPlan;
  createdBlockIds: Record<string, string>;
  order: { from: string[]; to: string[] } | null;
}): { fields: string[]; from: unknown; to: unknown } {
  const { livePage, liveTheme, liveBlocks, plan, createdBlockIds } = args;
  const pick = (record: object | null, keys: string[]) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        record ? ((record as Record<string, unknown>)[key] ?? null) : null,
      ]),
    );
  const pageKeys = Object.keys(plan.page);
  const themeKeys = plan.theme ? Object.keys(plan.theme) : [];
  const touched = new Set([
    ...plan.deletes,
    ...plan.updates.map((update) => update.id),
  ]);
  return {
    fields: [
      ...pageKeys,
      ...themeKeys.map((key) => `theme.${key}`),
      ...[...touched].map((id) => `blocks.${id}`),
      ...plan.creates.map(
        (create) => `blocks.${createdBlockIds[create.draftId] ?? create.draftId}`,
      ),
      ...(args.order ? ["blocks.order"] : []),
    ],
    from: {
      page: pick(livePage, pageKeys),
      theme: plan.theme ? pick(liveTheme, themeKeys) : null,
      blocks: liveBlocks
        .filter((block) => touched.has(block.id))
        .map(blockAuditSnapshot),
      order: args.order?.from ?? null,
    },
    to: {
      page: plan.page,
      theme: plan.theme,
      deletedBlockIds: plan.deletes,
      updatedBlocks: plan.updates,
      createdBlocks: plan.creates.map((create) => ({
        blockId: createdBlockIds[create.draftId] ?? null,
        kind: create.kind,
        visible: create.visible,
        data: create.data,
      })),
      order: args.order?.to ?? null,
    },
  };
}

async function discarderOf(
  tx: TxRepos,
  draft: PageDraftRecord,
): Promise<PageDraftEditorInfo | null> {
  if (!draft.updatedByHumanId) return null;
  // A plain id, no FK: a deleted account shows without a name.
  const [human] = await tx.humans.getByIds([draft.updatedByHumanId]);
  return { humanId: draft.updatedByHumanId, name: human?.name ?? null };
}

async function publishInTx(
  deps: PublishPageDraftDeps,
  logger: LoggerPort | undefined,
  tx: TxRepos,
  input: PublishPageDraftInput,
  page: EntityPageRecord,
  imageScope: PageImageUrlScope,
  prepared: PreparedPlaceWrite | null,
  editor: EntityPageEditor,
): Promise<TxOutcome> {
  const { draftRevision } = input;
  const publishedRevision = draftRevision + 1;
  // A community moderator: the claim lock FIRST (before the draft row),
  // then the rules again. No-op for an owner.
  await recheckCommunityPageEditor(tx, editor, deps.clock.now());
  const locked = await tx.entityPages.lockDraftForUpdate(page.id);

  // ── 1. The three branches (equality only) ────────────────────────────────
  // (b) Our own Publish already happened. Revisions never repeat, so this
  // alone proves it, even after newer edits were saved.
  if (locked.lastPublishedRevision === publishedRevision) {
    return {
      output: {
        outcome: "published",
        replayed: true,
        publishedRevision,
        revision: locked.revision,
      },
      committed: null,
    };
  }
  // (c) Not the draft the editor is publishing.
  if (locked.revision !== draftRevision || isEmptyDraft(locked)) {
    if (locked.revision === publishedRevision && isEmptyDraft(locked)) {
      return {
        output: {
          outcome: "discarded",
          revision: locked.revision,
          discardedBy: await discarderOf(tx, locked),
        },
        committed: null,
      };
    }
    return {
      output: { outcome: "stale", revision: locked.revision },
      committed: null,
    };
  }

  // (a) Publish. Live rows, read under the draft lock.
  // RISK, recorded until step 12: the EntityPage row and its blocks are read
  // here WITHOUT a row lock (the port has no EntityPage lock method). The
  // old editor (updatePage / managePageBlocks) does not take the draft
  // lock, so a write from it that commits between this read and the writes
  // below can be overwritten (page fields) or make a block write fail
  // (P2025 on a block it deleted, which rolls this publish back). Step 12
  // removes the old editor for venues; until then the window is the length
  // of this transaction.
  const livePage = await tx.entityPages.getById(page.id);
  if (!livePage) fail("PAGE_NOT_FOUND");
  const liveTheme = await tx.entityPages.getTheme(page.id);
  const layout = requireDraftLayout(input.ownerType, liveTheme);
  const liveBlocks = await tx.entityPages.listBlocks(page.id);

  // ── 2. Validate everything the draft says, before any lock or write ─────
  const { plan, refusals } = planPublish({
    ownerType: input.ownerType,
    layout,
    livePage,
    liveTheme,
    liveBlocks,
    draft: locked,
    imageScope,
  });

  const resolutions = input.resolutions ?? {};
  const patchFields = Object.keys(locked.placePatch);
  if (patchFields.length > 0 && input.ownerType !== "PLACE") {
    // parseOps refuses place.* off PLACE pages; a row holding one is a bug.
    fail("INTERNAL", {
      message: "page draft holds a Place patch on a non-PLACE page",
    });
  }
  const patch = effectivePlacePatch(locked.placePatch, resolutions);
  let placePatch: ValidatedPlacePatch | null = null;
  // A moderator is judged on the STORED patch, never on the effective one:
  // resolutions are ignored for this decision, so "theirs" picks cannot empty
  // the patch, skip this refusal and reach the conflict step below (whose
  // answer carries live Place facts and the owner's pending values).
  if (editor.kind === "community_moderator" && patchFields.length > 0) {
    for (const field of patchFields) {
      refusals.push(refusal(`place.${field}`, "place_fact_not_for_moderator"));
    }
  } else if (Object.keys(patch).length > 0) {
    const parsed = placePatchSchema.safeParse(patch);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.code === "unrecognized_keys") {
          for (const key of issue.keys) {
            refusals.push(refusal(`place.${key}`, "path_unknown"));
          }
          continue;
        }
        const field = issue.path[0];
        refusals.push(
          refusal(
            typeof field === "string" ? `place.${field}` : null,
            "value_invalid",
            { issues: [issue.message] },
          ),
        );
      }
    } else {
      placePatch = parsed.data;
    }
  }
  if (refusals.length > 0) {
    return {
      output: {
        outcome: "refused",
        revision: locked.revision,
        errors: refusals,
      },
      committed: null,
    };
  }

  // ── 3. Place conflicts (R9), under the place-location lock ──────────────
  let livePlace: PlaceRecord | null = null;
  if (patchFields.length > 0) {
    // The lock upsertPlace takes before reading Place: Settings' writes
    // queue behind it, so the values compared here are the ones written.
    await tx.events.lockLocationsAtPlace({
      placeId: input.ownerId,
      mode: "exclusive",
    });
    livePlace = await tx.places.getById(input.ownerId);
    if (!livePlace) fail("OWNER_NOT_FOUND", { meta: { entity: "place" } });
    const liveFacts = placeDraftFactsFromRecord(livePlace);
    const conflicts: PlaceFieldConflict[] = [];
    for (const field of patchFields) {
      if (!hasOwn(PAGE_DRAFT_PLACE_FIELDS, field)) continue; // refused above
      const placeField = field as PageDraftPlaceField;
      const base = locked.placeBase[field] ?? null;
      const live = liveFacts[placeField] ?? null;
      const mine = locked.placePatch[field];
      const resolution = resolutions[placeField];
      const conflicted = resolution
        ? // A pick counts only against the live value it was made for.
          !draftValuesEqual(resolution.live, live)
        : !draftValuesEqual(base, live) && !draftValuesEqual(live, mine);
      if (conflicted) {
        conflicts.push({ field: placeField, base, live, mine });
      }
    }
    if (conflicts.length > 0) {
      return {
        output: { outcome: "conflicts", revision: locked.revision, conflicts },
        committed: null,
      };
    }
  }

  if (placePatch !== null && livePlace !== null) {
    // The Place write's pre-transaction half must match this draft. It
    // always does in branch (a) (same revision, same patch); if not,
    // refetch.
    if (
      prepared === null ||
      prepared.revision !== locked.revision ||
      (hasOwn(placePatch, "address") && prepared.tax === null)
    ) {
      return {
        output: { outcome: "stale", revision: locked.revision },
        committed: null,
      };
    }
    // The ownership was checked before the transaction; re-checked on the
    // row read under the lock, so an ownership removed in between is never
    // written through (writePlaceInTx would re-create it).
    ensureOwnerMatches(livePlace, prepared.owner);
    if (
      placePatch.address === undefined &&
      storedAddressIncomplete(livePlace)
    ) {
      // The stored address cannot be re-sent unchanged (no country or no
      // formatted text): writing it would change the address or the tax
      // jurisdiction. The editor sets the address in the draft first.
      return {
        output: {
          outcome: "refused",
          revision: locked.revision,
          errors: [
            refusal("place.address", "value_invalid", {
              issues: ["stored_address_incomplete"],
            }),
          ],
        },
        committed: null,
      };
    }
  }

  const newSlug = plan.page.slug ?? livePage.slug;
  if (newSlug !== livePage.slug) {
    // The live path's check and error (updatePage).
    if (!(await tx.entityPages.isSlugAvailable(newSlug, livePage.id))) {
      fail("SLUG_TAKEN");
    }
  }

  // ── 4. Writes: EntityPage, theme, blocks, then Place ─────────────────────
  if (Object.keys(plan.page).length > 0) {
    if (newSlug !== livePage.slug) {
      // Old URLs keep redirecting (updatePage does the same).
      await tx.entityPages.recordSlugHistory(livePage.id, livePage.slug);
    }
    await tx.entityPages.upsert({
      ...plan.page,
      ownerType: livePage.ownerType,
      ownerId: livePage.ownerId,
      slug: newSlug,
      // Never draftable: a venue has ONE name, Place.name.
      displayName: livePage.displayName,
    });
  }
  if (plan.theme !== null) {
    await tx.entityPages.upsertTheme({ ...plan.theme, pageId: livePage.id });
  }

  for (const blockId of plan.deletes) {
    await tx.entityPages.deleteBlock(blockId);
  }
  for (const update of plan.updates) {
    await tx.entityPages.updateBlock(update);
  }
  const createdBlockIds: Record<string, string> = {};
  for (const create of plan.creates) {
    // A pinned kind that slipped in concurrently hits the partial unique
    // index; the adapter maps that P2002 to BLOCK_PINNED and the whole
    // publish rolls back.
    const created = await tx.entityPages.createBlock({
      pageId: livePage.id,
      kind: create.kind,
      data: create.data,
      visible: create.visible,
      section: "main",
    });
    createdBlockIds[create.draftId] = created.id;
  }
  // The full order: the main column as the draft resolves it, then the
  // other sections (memberships) in their stored order, so their indexes
  // never collide with the main column's.
  const deleted = new Set(plan.deletes);
  const otherSections = [...liveBlocks]
    .filter(
      (block) =>
        normalizeBlockSection(block.section) !== "main" &&
        !deleted.has(block.id),
    )
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((block) => block.id);
  const orderedIds = [
    ...plan.mainOrder.map((id) => createdBlockIds[id] ?? id),
    ...otherSections,
  ];
  const storedOrder = [...liveBlocks]
    .filter((block) => !deleted.has(block.id))
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((block) => block.id);
  if (plan.creates.length > 0 || !draftValuesEqual(orderedIds, storedOrder)) {
    await tx.entityPages.reorderBlocks(livePage.id, orderedIds);
  }

  const now = deps.clock.now();
  let placeWrite: PlaceWriteResult | null = null;
  if (placePatch !== null && prepared !== null && livePlace !== null) {
    const normalizedAddress = placeWriteContextAddress(livePlace, placePatch);
    const placeInput = placeWriteInput(
      livePlace,
      placePatch,
      prepared.owner,
      input.actorHumanId,
      normalizedAddress,
    );
    placeWrite = await writePlaceInTx(
      { ...deps, useCase: "publishPageDraft" },
      logger,
      tx,
      {
        input: placeInput,
        existingPlace: livePlace,
        normalizedAddress,
        ...(prepared.tax ?? {
          // The address is unchanged: nothing to look up (upsertPlace skips
          // the lookup for an unchanged address too).
          taxLookupAddress: {
            postalCode: normalizedAddress.postalCode,
            countryCode: normalizedAddress.countryCode,
          },
          preparedTaxRate: null,
        }),
        auditTime: now,
      },
    );
  }

  // ── 5. Images this Publish makes live are never deleted ──────────────────
  // Over the WHOLE draft, generous about WHERE (any mention, in any string,
  // of a key shape the server mints under this page's prefix; bounded): a
  // key a Discard queued and this Publish now uses.
  const keys = pageImageKeysMentionedIn(
    [locked.data, locked.placePatch],
    imageScope.keyPrefix,
  );
  // Every key, in bounded chunks (the scan is never capped).
  for (const targetKeys of chunkPageImageKeys(keys)) {
    await tx.pendingObjectDeletions.cancelPending({
      source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
      targetKeys,
    });
  }

  // ── 6. Search mark and audit ─────────────────────────────────────────────
  await markForSearchReindex(
    tx,
    [searchSelectorFor(input.ownerType, input.ownerId)],
    now,
  );
  await tx.audit.log({
    entity: "entity_page",
    entityId: livePage.id,
    action: "entity_page.draft_published",
    data: {
      actorHumanId: input.actorHumanId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      draftRevision,
      changeCount: changeCount(locked),
      placeFields: placePatch === null ? [] : Object.keys(placePatch),
      blocksCreated: plan.creates.length,
      blocksUpdated: plan.updates.length,
      blocksDeleted: plan.deletes.length,
      emptyBlocksSkipped: plan.skippedEmptyBlockIds.length,
    },
    at: now,
  });
  await logCommunityPageUpdate(
    tx,
    editor,
    {
      actorHumanId: input.actorHumanId,
      pageId: livePage.id,
      op: "publishPageDraft",
      ...publishChanges({
        livePage,
        liveTheme,
        liveBlocks,
        plan,
        createdBlockIds,
        order:
          plan.creates.length > 0 || !draftValuesEqual(orderedIds, storedOrder)
            ? { from: storedOrder, to: orderedIds }
            : null,
      }),
    },
    now,
  );

  // ── 7. Clear the draft (one UPDATE; the row stays) ───────────────────────
  const cleared = await tx.entityPages.clearDraft(livePage.id, {
    revision: publishedRevision,
    lastPublishedRevision: publishedRevision,
    updatedByHumanId: input.actorHumanId,
  });

  return {
    output: {
      outcome: "published",
      replayed: false,
      publishedRevision,
      revision: cleared.revision,
      createdBlockIds,
      skippedEmptyBlockIds: plan.skippedEmptyBlockIds,
      placeWritten: placeWrite !== null,
    },
    committed: { placeWrite },
  };
}

export async function publishPageDraft(
  deps: PublishPageDraftDeps,
  rawInput: unknown,
): Promise<PublishPageDraftOutput> {
  const logger = deps.logger?.child({ useCase: "publishPageDraft" });

  const execute = async (): Promise<PublishPageDraftOutput> => {
    const input = parseInput(publishPageDraftInputSchema, rawInput);
    const { page, editor } = await loadPageForDraft(deps, input);
    const imageScope = pageImageScope(
      input.ownerType,
      input.ownerId,
      deps.storagePublicBaseUrl,
    );
    const prepared = await preparePlaceWrite(
      deps,
      logger,
      input,
      page.id,
      editor,
    );

    const result = await deps.repos.tx((tx) =>
      publishInTx(deps, logger, tx, input, page, imageScope, prepared, editor),
    );

    // After commit, best-effort (never throws), as the live paths do.
    if (result.committed) {
      const { placeWrite } = result.committed;
      if (placeWrite) {
        // Reindexes the venue (the page's owner document) and every event
        // the location cascade re-projected.
        afterPlaceWriteCommitted(
          deps,
          placeWrite.record.id,
          placeWrite.reprojectedEventIds,
        );
      } else {
        reindexAfterMutation(
          {
            repos: deps.repos,
            search: deps.search,
            clock: deps.clock,
            logger: deps.logger,
            reportError: deps.reportError,
          },
          "publishPageDraft",
          searchSelectorFor(input.ownerType, input.ownerId),
        );
      }
    }
    return result.output;
  };

  if (logger) return logger.withTime("publishPageDraft", execute);
  return execute();
}
