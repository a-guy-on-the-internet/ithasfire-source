import { createHash } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PlaceRecord,
  PlaceStatus,
  PlaceVerificationStatus,
  Repos,
  TxRepos,
} from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { describeError, parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  reindexAfterMutation,
  runReindexAfterMutation,
} from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  eventSearchDocId,
  placeLocationScrubNeeded,
  placeSearchDocId,
  scrubSearchDocumentsOrThrow,
} from "../search/privacy-scrub";
import { searchForTx } from "../search/tx-bound-search";
import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  placeEventProjectionChanged,
  placeExactAddressChanged,
  projectPlaceLocationForEvents,
} from "../../lib/location/place-event-location";
import {
  MAX_OBFUSCATION_RADIUS_METERS,
  MIN_OBFUSCATION_RADIUS_METERS,
  snapValidatedObfuscationRadius,
} from "../../lib/location/obfuscation-radius-ladder";
import { lookupAdmissionTaxRate } from "../events/_shared/lookup-admission-tax-rate";
import { buildPageSlug } from "./_shared/page-slug";
import { assertOwnerlessWriteAllowed } from "./_shared/ownerless-write-guard";
import { followPlaceAddressOntoEvents } from "./_shared/follow-place-address";
import { fail } from "@th/errors";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";

const PLACE_STATUS_VALUES: readonly PlaceStatus[] = [
  "ACTIVE",
  "SUSPENDED",
  "ARCHIVED",
];
const PLACE_VERIFICATION_STATUS_VALUES: readonly PlaceVerificationStatus[] = [
  "UNVERIFIED",
  "VERIFIED",
  "PENDING",
  "REJECTED",
];

/**
 * WHAT A BRAND-NEW PLACE GETS WHEN NOBODY SAYS: EXACT (ruled 2026-09-17).
 *
 * A venue publishes its address unless it asks not to. The protection for a
 * house is an explicit "hide this address" choice made AT CREATION, not this
 * default — see the `locationMode` note below for why the withheld default
 * this constant first shipped with was reversed.
 *
 * NO "is this a residence?" SIGNAL EXISTS at creation today: `upsertPlace`
 * takes a name, an address and a country code, and nothing in that payload
 * distinguishes a house from a club. If one is ever added (a venue-type
 * field, an address-classification provider), wire the default off it here —
 * this constant is the single point that would have to change.
 *
 * EXISTING ROWS ARE NOT TOUCHED. The column default is EXACT and the migration
 * does no backfill, so every venue that predates this stays exactly as it was.
 * This constant applies ONLY to rows created through this use case. The bulk
 * importer (`bulkCreate`) is deliberately NOT routed through it: scraped
 * directory venues are public businesses by construction.
 */
export const NEW_PLACE_DEFAULT_LOCATION_PRIVACY = {
  /**
   * EXACT — a venue shows its address unless it asks not to.
   *
   * RULED 2026-09-17, reversing the withheld default this constant shipped
   * with. The reasoning that produced "withheld" was sound in isolation — a
   * privacy control inherits whatever the default is, and someone listing
   * their home is the least likely to open a settings page — but it optimised
   * for the rare case at the cost of every ordinary one. Nearly every venue
   * IS a public business whose address is the single most useful thing about
   * it, and defaulting those to hidden means the directory ships broken and
   * every real venue has to be repaired by hand.
   *
   * The protection for the house moves to where it belongs: an explicit
   * "hide this address" choice AT CREATION, so the person listing a home is
   * asked rather than relied upon to go looking. That choice, not this
   * default, is what has to be hard to miss.
   */
  locationMode: "EXACT",
  locationRadiusMeters: null,
} as const satisfies { locationMode: "EXACT"; locationRadiusMeters: null };

/**
 * WHAT A BRAND-NEW PLACE'S PERFORMER-REVIEW SWITCH GETS WHEN NOBODY SAYS.
 *
 * RULED 2026-09-24 (venue-track-record-and-review-switch R3): a place created
 * with `locationMode != EXACT` starts with `communityReviewsEnabled = false`;
 * everyone else starts `true`. The person withholding their address is the
 * person listing a home, and an anonymous, unverified inbound channel pointed
 * at a home is the thing the switch exists to close — so the choice they
 * already made at creation ("hide this address") sets it, rather than relying
 * on a second settings-page visit. A public business is unaffected.
 *
 * Applies ONLY to CREATE through this use case, and only when the input does
 * not carry the flag explicitly. Existing rows are never touched (the column
 * default is true and the migration did no backfill).
 */
export function newPlaceCommunityReviewsDefault(
  locationMode: "EXACT" | "OBSCURED",
): boolean {
  return locationMode === "EXACT";
}

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.string().uuid() }),
  z.object({ kind: z.literal("human"), humanId: z.string().uuid() }),
]);

const addressSchema = z
  .object({
    formatted: z.string().trim().min(1).max(280),
    /**
     * OPTIONAL — a place can genuinely have no street address.
     *
     * The domain has always allowed it and every other layer already does:
     * `Place.addrLine1` is `String?` (place.prisma), the repo-level upsert is
     * called with `line1: ""` by the review-flow stub-place path
     * (`submit-place-review.ts`) and by the ~8 core use cases that round-trip
     * `place.addressLine1 ?? ""` to flip one unrelated field, and 10 of the 11
     * places in the seeded dev database have a null/empty `addrLine1`
     * (parks, DIY spaces, house shows, city-only stubs).
     *
     * THIS SCHEMA was the only thing requiring it — which is exactly why the
     * admin place editor papered over the rejection with a literal `"TBD"`
     * sentinel that then persisted to `Place.addrLine1`, rendered on public
     * venue pages, and fed `formatted`/`addressHash`. `formatted` stays
     * required, so an address still has to say *something*; it just no longer
     * has to be a street.
     */
    line1: z.string().trim().max(160).optional(),
    line2: z.string().trim().max(160).optional(),
    city: z.string().trim().max(120).optional(),
    region: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().max(32).optional(),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase()),
    lat: z.number().gte(-90).lte(90).optional(),
    lng: z.number().gte(-180).lte(180).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.lat === undefined) !== (value.lng === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "lat and lng must be provided together",
      });
    }
  });

/**
 * E.164 phone format: leading `+`, country code (no leading 0), 1–15 digits.
 * The `apps/*` UI already formats user input via the PhoneNumberInput
 * component, so by the time it lands here it should already be canonical.
 */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

export const upsertPlaceInputSchema = z
  .object({
    placeId: z.string().uuid().optional(),
    actorHumanId: z.string().uuid(),
    owner: ownerSchema,
    name: plainTextRequired(140).pipe(z.string().min(2)),
    address: addressSchema,
    capacity: z.number().int().positive().max(200_000).optional(),
    phone: z
      .string()
      .trim()
      .max(40)
      .regex(E164_REGEX, "PHONE_FORMAT_INVALID")
      .optional()
      .nullable(),
    website: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((v) => /^https?:\/\//i.test(v), "website_must_be_http_url")
      .optional()
      .nullable(),
    /** Optional bio / description — stored on the Place's EntityPage. */
    bio: plainTextMultilineOptional(1000).optional(),
    /**
     * ADDRESS PRIVACY. OMITTED on UPDATE preserves the stored value; omitted
     * on CREATE picks {@link NEW_PLACE_DEFAULT_LOCATION_PRIVACY} — EXACT.
     */
    locationMode: z.enum(["EXACT", "OBSCURED"]).optional(),
    /**
     * Obfuscation radius in metres, or `null` = FULLY HIDDEN (no public map).
     * Bounds mirror `baseSaveEventInputSchema` and the DB CHECK constraint.
     * SNAPPED UP to the radius ladder before it is stored
     * (`obfuscation-radius-ladder.ts`): a circle is only ever drawn at a
     * rung, and every off-ladder radius would be one more sample of the
     * house.
     */
    locationRadiusMeters: z
      .number()
      .int()
      .min(MIN_OBFUSCATION_RADIUS_METERS)
      .max(MAX_OBFUSCATION_RADIUS_METERS)
      .transform(snapValidatedObfuscationRadius)
      .nullable()
      .optional(),
    /** Coarse public area label for a withheld venue (e.g. "East Nashville"). */
    locationLabel: plainTextRequired(200).nullable().optional(),
    /**
     * PERFORMER-REVIEW SWITCH (venue-track-record-and-review-switch FR-006).
     * CREATE ONLY. Omitted on CREATE picks {@link newPlaceCommunityReviewsDefault}
     * off the resolved location mode. On UPDATE the field is REJECTED, not
     * preserved-if-omitted: this use case is open to EDITOR (`ORG_EDIT_ROLES`)
     * and the switch sits at the OWNER/ADMIN bar, so the only writer for an
     * existing place is `setPlaceCommunityReviewsEnabled` (FR-005). None of
     * the other three place switches is accepted here either.
     */
    communityReviewsEnabled: z.boolean().optional(),
    clientKey: z.string().min(8),
  })
  .strict();

export const upsertPlaceOutputSchema = z.object({
  placeId: z.string().uuid(),
  status: z.enum([
    "ACTIVE",
    "SUSPENDED",
    "ARCHIVED",
  ] satisfies readonly PlaceStatus[]),
  verificationStatus: z.enum([
    "UNVERIFIED",
    "VERIFIED",
    "PENDING",
    "REJECTED",
  ] satisfies readonly PlaceVerificationStatus[]),
  access: z.object({
    orgIds: z.array(z.string().uuid()),
    humanIds: z.array(z.string().uuid()),
  }),
});

export type UpsertPlaceInput = z.infer<typeof upsertPlaceInputSchema>;
export type UpsertPlaceOutput = z.infer<typeof upsertPlaceOutputSchema>;

export type UpsertPlaceDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * When provided, reindexes the place (best-effort, after commit). A save
   * that leaves the venue's address withheld also DELETES its search
   * documents before commit and fails if that delete fails (fail-closed, see
   * `search/privacy-scrub.ts`).
   */
  search?: MultiSearchPort;
  /**
   * Optional tax-rate provider. When provided, the place's admission tax rate
   * is looked up and cached on create or when its address changes. Non-fatal:
   * a missing provider or failed lookup leaves the cache null (checkout falls
   * back to zero tax, same as today).
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Optional lat/lng → IANA timezone resolver (venue-hierarchy FR-004). When
   * provided, `Place.timezone` is derived on create and re-derived when the
   * address changes — the same lookup-and-cache lifecycle as `taxRateLookup`
   * above. Non-fatal in every failure mode: a missing port, missing
   * coordinates, or a `null`/throwing lookup leaves the existing value
   * untouched (a place save must never fail because tz lookup broke).
   */
  timezoneLookup?: TimezoneLookupPort | null;
  /**
   * Error tracker for the deliberate swallow branch in this use case (a
   * throwing `timezoneLookup`). See the repo's Sentry convention: swallowed
   * failures MUST be reported, not just logged.
   */
  reportError?: ReporterPort;
};

type StoredUpsertPlaceRecord = {
  payloadHash: string;
  response: UpsertPlaceOutput;
};

export async function upsertPlace(
  deps: UpsertPlaceDeps,
  rawInput: unknown,
): Promise<UpsertPlaceOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "upsertPlace" });

  const execute = async () => {
    const input = parseInput(upsertPlaceInputSchema, rawInput);
    return handleUpsert(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("upsertPlace", execute);
  }

  return execute();
}

async function handleUpsert(
  deps: UpsertPlaceDeps,
  logger: LoggerPort | undefined,
  input: UpsertPlaceInput,
): Promise<UpsertPlaceOutput> {
  const owner = input.owner;

  // The performer-review switch is CREATE-only here. An EDITOR may edit a
  // place but may not flip its switches; on an existing place the ONLY writer
  // is `setPlaceCommunityReviewsEnabled`, which enforces the OWNER/ADMIN bar
  // and writes the `place.community_reviews_*` audit row. Refused before any
  // read or write — including through `bulkUpsertPlaces`, which delegates
  // every item here.
  if (input.placeId !== undefined && input.communityReviewsEnabled !== undefined) {
    throw fail("INVALID_INPUT", {
      message:
        "communityReviewsEnabled cannot be set through upsertPlace on an existing place; use setPlaceCommunityReviewsEnabled",
      meta: {
        field: "communityReviewsEnabled",
        useCase: "setPlaceCommunityReviewsEnabled",
      },
    });
  }

  await ensureOwnerAccess(deps.repos, input.actorHumanId, owner);

  const existingPlace = input.placeId
    ? await deps.repos.places.getById(input.placeId)
    : null;
  if (input.placeId && !existingPlace) {
    throw fail("PLACE_NOT_FOUND");
  }

  if (existingPlace) {
    ensureOwnerMatches(existingPlace, owner);
  }

  const normalizedAddress = normalizeAddress(input.address);

  const payloadHash = buildPayloadHash({
    placeId: input.placeId ?? null,
    owner,
    name: input.name.trim(),
    address: normalizedAddress,
    capacity: input.capacity ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    // Part of the hash so replaying the same clientKey with DIFFERENT privacy
    // is an IDEMPOTENCY_KEY_CONFLICT, not a silently-ignored change.
    locationMode: input.locationMode ?? null,
    locationRadiusMeters:
      input.locationRadiusMeters !== undefined
        ? input.locationRadiusMeters
        : "unset",
    locationLabel: input.locationLabel ?? null,
    // Folded in the same way `locationRadiusMeters` was: a clientKey stored
    // BEFORE this segment existed and replayed within its TTL now conflicts
    // (its stored hash lacks the "unset" segment). Accepted at review
    // 2026-09-24 — the window is the idempotency TTL, once.
    communityReviewsEnabled: input.communityReviewsEnabled ?? "unset",
  });

  const idemKey = buildIdempotencyKey(
    owner,
    input.placeId ?? null,
    input.clientKey,
  );

  const replay = await deps.idempotency.get<StoredUpsertPlaceRecord>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const ownerToken = crypto.randomUUID();
  const claimed = await deps.idempotency.begin(idemKey, 300, ownerToken);
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredUpsertPlaceRecord>(idemKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let txResult: PlaceWriteResult;
  try {
    const auditTime = deps.clock.now();

    const { taxLookupAddress, preparedTaxRate } = await preparePlaceTaxRate(
      deps,
      logger,
      existingPlace,
      normalizedAddress,
    );

    // The write itself: `writePlaceInTx` (shared with publishPageDraft,
    // which writes a venue's Place facts inside its own transaction).
    const result = await deps.repos.tx((tx) =>
      writePlaceInTx(deps, logger, tx, {
        input,
        existingPlace,
        normalizedAddress,
        taxLookupAddress,
        preparedTaxRate,
        auditTime,
      }),
    );

    txResult = result;
  } catch (error) {
    // Transient failure: release so the owner's same-key retry proceeds at
    // once (see lib/idempotency-claim.ts). Commit is OUTSIDE this catch: if
    // the upsert committed and only the store write throws, releasing would
    // let a retry redo committed work.
    await abandonClaim(deps.idempotency, idemKey, ownerToken, error, {
      useCase: "upsertPlace",
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw asKnownError("upsert_place", error);
  }

  let response: UpsertPlaceOutput;
  try {
    response = upsertPlaceOutputSchema.parse({
      placeId: txResult.record.id,
      status: txResult.record.status,
      verificationStatus: txResult.record.verificationStatus,
      access: {
        orgIds: txResult.record.orgIdsWithAccess,
        humanIds: txResult.record.humanIdsWithAccess,
      },
    });
    await deps.idempotency.commit<StoredUpsertPlaceRecord>(idemKey, {
      payloadHash,
      response,
    });
  } catch (error) {
    // Work is committed: keep the claim (no release) and surface the error.
    throw asKnownError("upsert_place", error);
  }

  afterPlaceWriteCommitted(
    deps,
    response.placeId,
    txResult.reprojectedEventIds,
  );

  return response;
}

/** The values a Place write needs from the tax-rate PREPARE half. */
export type PreparedPlaceTaxRate = {
  taxLookupAddress: {
    postalCode: NormalizedPlaceAddress["postalCode"];
    countryCode: NormalizedPlaceAddress["countryCode"];
  };
  preparedTaxRate: Awaited<ReturnType<typeof lookupAdmissionTaxRate>> | null;
};

/**
 * The admission tax-rate lookup that a Place write needs BEFORE its
 * transaction opens (see the comment inside). Exported for
 * publishPageDraft, which writes Place facts in its own transaction and
 * must run this first, outside it, exactly as upsertPlace does.
 */
export async function preparePlaceTaxRate(
  deps: Pick<UpsertPlaceDeps, "taxRateLookup" | "clock" | "reportError">,
  logger: LoggerPort | undefined,
  existingPlace: PlaceRecord | null,
  normalizedAddress: NormalizedPlaceAddress,
): Promise<PreparedPlaceTaxRate> {
  // ── Admission tax-rate lookup, PREPARE half (create OR address changed) ──
  // Cache the venue's sales-tax rate so checkout (and the publish-time
  // resolver) can compute admission tax with zero API calls. We refresh
  // exactly when the address is new or has changed.
  //
  // The provider is a live HTTP call in production (ZipTax, 5s timeout).
  // CALLER CONTRACT: call this after the idempotency claim and every cheap
  // rejection, and BEFORE the transaction opens. Inside the tx it would hold the
  // EXCLUSIVE place-location advisory lock, the Place row lock and a pooled
  // connection across a third-party round trip. Same prepare-then-tx split
  // as `prepareCheckoutTax` / `prepareEventTaxRate`; the write stays in the
  // tx below.
  //
  // The values the tx is about to write are fully determined here: the
  // adapter stores `postcode = address.postalCode`, `country =
  // address.countryCode` and `addressHash = formatted.trim().toLowerCase()`
  // (or null when blank) — see `buildPlaceData` in the Prisma places
  // adapter. `normalizedAddress` is exactly what the tx passes it.
  //
  // Non-fatal: a missing provider, a miss, or a throwing provider (swallowed
  // and reported inside `lookupAdmissionTaxRate`) caches no rate. On a
  // JURISDICTION change (postcode/country) the old rate is then cleared in
  // the tx below.
  //
  // Looked up when the address text changed OR the postcode/country did: a
  // postcode correction under identical `formatted` text still moves the
  // venue to another jurisdiction.
  const expectedAddressHash = normalizedAddress.formatted.trim()
    ? normalizedAddress.formatted.trim().toLowerCase()
    : null;
  const taxLookupAddress = {
    postalCode: normalizedAddress.postalCode,
    countryCode: normalizedAddress.countryCode,
  };
  const preparedTaxRate =
    !existingPlace ||
    existingPlace.addressHash !== expectedAddressHash ||
    !sameTaxJurisdiction(existingPlace, taxLookupAddress)
      ? await lookupAdmissionTaxRate({
          taxRateLookup: deps.taxRateLookup,
          postalCode: taxLookupAddress.postalCode,
          countryCode: taxLookupAddress.countryCode,
          clock: deps.clock,
          logger,
          logContext: { placeId: existingPlace?.id ?? null },
          // The lookup swallows a throwing provider; this is what makes that
          // swallow visible (repo Sentry convention).
          reportError: deps.reportError,
        })
      : null;
  return { taxLookupAddress, preparedTaxRate };
}

/** The dependencies the in-transaction Place write uses. */
export type PlaceWriteDeps = Pick<
  UpsertPlaceDeps,
  "search" | "timezoneLookup" | "reportError"
> & {
  /** The Sentry `useCase` tag on this write's reports. Default "upsertPlace". */
  useCase?: string;
};

/**
 * upsertPlace's validated input, minus its idempotency key. `owner` is
 * nullable HERE ONLY (upsertPlace's own schema still requires one): `null`
 * is an OWNERLESS CREATE — `createCommunityPlace`, a community moderator
 * adding a place nobody has claimed. No PlaceOwnership row is written, and
 * the `created` audit row says so. `null` on an UPDATE is refused below
 * unless the caller sets `ownerlessStaffWrite` on the context.
 */
export type PlaceWriteInput = Omit<UpsertPlaceInput, "clientKey" | "owner"> & {
  owner: UpsertPlaceInput["owner"] | null;
};

export type PlaceWriteContext = PreparedPlaceTaxRate & {
  input: PlaceWriteInput;
  /** The row before this write, read before the transaction; null = create. */
  existingPlace: PlaceRecord | null;
  normalizedAddress: NormalizedPlaceAddress;
  auditTime: Date;
  /**
   * Set ONLY by `updateCommunityPlace`, after it has checked, inside this
   * transaction, that the actor is a community moderator or ADMIN and
   * `assertOwnerlessWriteAllowed` passes (no owner, no claim in review, no
   * organiser's live event at the place). It lets `owner: null` UPDATE a
   * place, and keeps the stored `websiteSource` (that edit never touches
   * the website, so an imported place keeps its claim fast-track).
   */
  ownerlessStaffWrite?: true;
  /**
   * Set ONLY by `createCommunityPlace`: the place a community moderator or
   * ADMIN creates is listed in the directory at birth (owner ruling
   * 2026-10-14). Honoured on CREATE only; an update never touches the flag
   * here (the staff toggles own it). Every other caller leaves it unset, so
   * their places keep the column default (unlisted).
   */
  listInDirectoryOnCreate?: true;
};

export type PlaceWriteResult = {
  record: PlaceRecord;
  reprojectedEventIds: string[];
};

/**
 * UNAUTHORISED WRITE: the caller MUST authorise first
 * (`assertPlaceWriteAccess` / `ensureOwnerAccess` for an owned write;
 * `requirePlatformStaff(COMMUNITY_MODERATION_ROLES)` for `owner: null`) and
 * validate every free-text field with the `plainText*` helpers. Never call
 * from a transport (a guard test fails if `packages/transport` imports it).
 *
 * The Place write, INSIDE the caller's transaction: the place-location
 * lock and re-read, the row write and audit, the event-location cascade,
 * default space and calendar on create, the tax-rate write / clear, the
 * timezone, the search marks and the privacy scrub. The ONE Place write
 * path: upsertPlace runs it in its own `repos.tx`, publishPageDraft in the
 * page publish transaction (spec entity-page-wysiwyg-editor R9 / FR-016),
 * and the community-place use cases (`createCommunityPlace`,
 * `updateCommunityPlace`) for a place nobody owns.
 *
 * Caller contracts: `existingPlace` is the row being updated (null =
 * create) and `input.placeId` must be its id (refused otherwise); run
 * `preparePlaceTaxRate` BEFORE the transaction, and
 * `afterPlaceWriteCommitted` after it commits.
 */
export async function writePlaceInTx(
  deps: PlaceWriteDeps,
  logger: LoggerPort | undefined,
  tx: TxRepos,
  ctx: PlaceWriteContext,
): Promise<PlaceWriteResult> {
  const {
    input,
    existingPlace,
    normalizedAddress,
    taxLookupAddress,
    preparedTaxRate,
    auditTime,
  } = ctx;
  // The row written is `input.placeId`; the lock, the audit and the
  // create-vs-update branch all key on `existingPlace`. They must be the
  // same place, or a caller could overwrite one place under another's
  // checks (or mint a second page and calendar for an existing row).
  if ((input.placeId ?? null) !== (existingPlace?.id ?? null)) {
    throw fail("INTERNAL", {
      message: "writePlaceInTx: input.placeId must be existingPlace.id",
      meta: {
        inputPlaceId: input.placeId ?? null,
        existingPlaceId: existingPlace?.id ?? null,
      },
    });
  }
  const owner = input.owner;
  // An ownerless write is a CREATE, or the community-moderator edit that
  // says so explicitly. Every other update path authorises against an owner
  // (`assertPlaceWriteAccess`); one without could only be a caller bug, and
  // it must not reach the row.
  if (owner === null && existingPlace && ctx.ownerlessStaffWrite !== true) {
    throw fail("INTERNAL", {
      message: "writePlaceInTx: an ownerless write may only create a place",
      meta: { placeId: existingPlace.id },
    });
  }
  // ── Event-location cascade, part 1: LOCK, then read BEFORE ──────────
  // (place-address-withholding D1.) Every event at this venue stores the
  // venue's PUBLIC projection while it is withheld — the true location
  // lives on this Place row only. A privacy change must therefore
  // re-project them, atomically with the Place write.
  //
  // The EXCLUSIVE place-location lock is taken BEFORE the Place write:
  // event saves at this venue take the shared form before they read the
  // place, so they either finish first (and are re-projected below) or
  // wait and read the new state. Taking it after the write would let a
  // save that read the old state block on this row while holding the
  // shared lock — a deadlock, or worse, a true address committed after
  // the cascade ran.
  //
  // The BEFORE state is re-read here, under the lock, rather than taken
  // from `existingPlace` (read outside the tx): a concurrent edit that
  // committed in between would otherwise make a real change look like a
  // no-op and skip the cascade.
  let placeBefore: PlaceRecord | null = null;
  if (existingPlace) {
    await tx.events.lockLocationsAtPlace({
      placeId: existingPlace.id,
      mode: "exclusive",
    });
    placeBefore =
      (await tx.places.getById(existingPlace.id)) ?? existingPlace;
  }

  // The ownerless edit is for a place nobody owns, nobody is claiming and no
  // organiser's live event uses. The caller checked that already; it is
  // re-checked here, under the lock and on the re-read row, with the same
  // predicate, so the flag can never carry a write onto such a place.
  if (owner === null && placeBefore) {
    await assertOwnerlessWriteAllowed(tx, placeBefore, auditTime);
  }

  const placeRecord = await tx.places.upsert({
    placeId: input.placeId ?? null,
    owner,
    name: input.name.trim(),
    address: normalizedAddress,
    geo:
      normalizedAddress.lat !== undefined
        ? { lat: normalizedAddress.lat, lng: normalizedAddress.lng }
        : undefined,
    capacity: input.capacity ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    // A user-set/edited website is UNTRUSTED provenance — it must never
    // unlock the claim email-domain fast-track (FR-010). Only verified
    // bulk-import marks TRUSTED_IMPORT. The moderator edit of an unowned
    // place keeps the stored provenance ONLY while the website is the one
    // stored: a changed website is user-set, and keeping TRUSTED_IMPORT on
    // it would let a claimant from that domain auto-verify (FR-010).
    websiteSource:
      ctx.ownerlessStaffWrite === true &&
      placeBefore &&
      (input.website ?? null) === (placeBefore.website ?? null)
        ? placeBefore.websiteSource
        : "USER_STUB",
    // ── Address privacy ──────────────────────────────────────────────
    // Spread, never `?? null`: for these three columns OMITTED means
    // "leave the stored value alone" and an explicit null on the radius
    // means "fully hidden". A defensive `?? null` here would hide every
    // venue on every unrelated edit.
    //
    // On CREATE with nothing supplied, the venue starts EXACT — see
    // NEW_PLACE_DEFAULT_LOCATION_PRIVACY (ruled 2026-09-17).
    ...(existingPlace
      ? {
          ...(input.locationMode !== undefined
            ? { locationMode: input.locationMode }
            : {}),
          ...(input.locationRadiusMeters !== undefined
            ? { locationRadiusMeters: input.locationRadiusMeters }
            : {}),
          ...(input.locationLabel !== undefined
            ? { locationLabel: input.locationLabel }
            : {}),
        }
      : {
          locationMode:
            input.locationMode ??
            NEW_PLACE_DEFAULT_LOCATION_PRIVACY.locationMode,
          locationRadiusMeters:
            input.locationRadiusMeters !== undefined
              ? input.locationRadiusMeters
              : NEW_PLACE_DEFAULT_LOCATION_PRIVACY.locationRadiusMeters,
          ...(input.locationLabel !== undefined
            ? { locationLabel: input.locationLabel }
            : {}),
        }),
    ...(!existingPlace && ctx.listInDirectoryOnCreate === true
      ? { listedInDirectory: true }
      : {}),
    // ── Performer-review switch (R3 / FR-006) — CREATE ONLY ──────────
    // Never written on UPDATE. CALLER CONTRACT: refuse the field on an
    // update before calling (upsertPlace does, in handleUpsert), so an
    // existing place's switch is untouched by every edit. On
    // CREATE with nothing supplied the default follows the location
    // choice the caller just made — withheld address ⇒ switch off.
    ...(existingPlace
      ? {}
      : {
          communityReviewsEnabled:
            input.communityReviewsEnabled ??
            newPlaceCommunityReviewsDefault(
              input.locationMode ??
                NEW_PLACE_DEFAULT_LOCATION_PRIVACY.locationMode,
            ),
        }),
  });

  // NOTE: this path deliberately mints NO `Place.slug`. A place carries a
  // single addressable slug — its `EntityPage.slug`, minted by
  // `buildPageSlug` further down — and that is what `/places/[slug]` and
  // `/p/[slug]` resolve on. The old `Place.slug` was a multi-segment
  // directory key (`us/tn/name--shortid`) that no route ever resolved,
  // because places never got the catch-all route `/events/[...slug]` has.
  // Do not reintroduce it.
  const finalRecord = placeRecord;

  await tx.audit.log({
    entity: "place",
    entityId: placeRecord.id,
    action: existingPlace ? "updated" : "created",
    data: {
      ...(owner
        ? {
            ownerType: owner.kind,
            ownerId: owner.kind === "org" ? owner.orgId : owner.humanId,
          }
        : { ownerType: null, ownerId: null, ownerless: true }),
      actorHumanId: input.actorHumanId,
      name: input.name.trim(),
    },
    at: auditTime,
  });

  // ── Event-location cascade, part 2: RE-PROJECT ────────────────────
  // Tighten or loosen, in ONE statement however many events the venue
  // has. Withheld → every event gets the public projection (and a reveal
  // schedule if it was EXACT with none); EXACT → the true location is
  // restored from this row. See `EventsRepo.reprojectLocationForPlace`.
  let reprojectedEventIds: string[] = [];
  if (placeBefore && placeEventProjectionChanged(placeBefore, placeRecord)) {
    const projection = projectPlaceLocationForEvents(placeRecord);
    reprojectedEventIds = await tx.events.reprojectLocationForPlace({
      placeId: placeRecord.id,
      projection,
      now: auditTime,
      defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
    });
    await tx.audit.log({
      entity: "place",
      entityId: placeRecord.id,
      action: "place.event_locations_reprojected",
      data: {
        actorHumanId: input.actorHumanId,
        fromLocationMode: placeBefore.locationMode,
        toLocationMode: placeRecord.locationMode,
        fromRadiusMeters: placeBefore.locationRadiusMeters ?? null,
        toRadiusMeters: placeRecord.locationRadiusMeters ?? null,
        projection: projection.kind,
        eventCount: reprojectedEventIds.length,
      },
      at: auditTime,
    });
  }

  // Auto-provision an EntityPage for new places so the page editor works
  // immediately and public profile routes have something to render.
  if (!existingPlace) {
    const pageSlug = buildPageSlug(input.name.trim(), finalRecord.id);
    await tx.entityPages.upsert({
      ownerType: "PLACE",
      ownerId: finalRecord.id,
      slug: pageSlug,
      displayName: input.name.trim(),
      bio: input.bio ?? null,
    });

    // ── Default Space + Calendar minting (venue-hierarchy FR-001/FR-002) ──
    // Every place gets exactly one "Main Space" and one default "Main
    // Calendar" (slug "main") joined via CalendarSpace, atomically with the
    // place row. Names/slugs mirror apps/api/src/scripts/seed/places.ts —
    // keep them in sync.
    const mainSpace = await tx.spaces.create({
      placeId: finalRecord.id,
      name: "Main Space",
      sortOrder: 0,
    });
    // The join lands with the calendar row (every calendar has ≥1
    // space — the repo writes both in this transaction). "Main Space" is
    // this place's only room and was created ACTIVE one statement ago, so
    // it is also the calendar's PRIMARY — the room the FK holds the
    // calendar to (owner ruling 2026-09-24).
    const mainCalendar = await tx.calendars.create({
      placeId: finalRecord.id,
      name: "Main Calendar",
      slug: "main",
      isDefault: true,
      spaceIds: [mainSpace.id],
      primarySpaceId: mainSpace.id,
    });
    await tx.audit.log({
      entity: "place",
      entityId: finalRecord.id,
      action: "place.defaults_minted",
      data: {
        spaceId: mainSpace.id,
        calendarId: mainCalendar.id,
        actorHumanId: input.actorHumanId,
      },
      at: auditTime,
    });
  }

  // ── Admission tax-rate lookup, WRITE half ────────────────────────────
  // The provider was called before the tx (see `preparedTaxRate`). Only
  // the DB write happens here. Defensive guard: the rate is written only
  // if the row we just wrote carries the postal code + country the lookup
  // was made for. A mismatch means the adapter normalised the address
  // differently from what core assumed above — the rate would belong to
  // another jurisdiction, so it is NOT written (treated exactly like a
  // provider miss) and the drift is reported, since it would otherwise be
  // invisible.
  let taxRateCached = false;
  if (preparedTaxRate) {
    if (
      finalRecord.postalCode === taxLookupAddress.postalCode &&
      finalRecord.countryCode === taxLookupAddress.countryCode
    ) {
      await tx.places.updateTaxRate({
        id: finalRecord.id,
        admissionTaxRateBps: preparedTaxRate.rateBps,
        taxRateSource: preparedTaxRate.source,
        taxRateFetchedAt: preparedTaxRate.fetchedAt,
      });
      taxRateCached = true;
      logger?.info("tax_rate_cached_on_place", {
        placeId: finalRecord.id,
        rateBps: preparedTaxRate.rateBps,
        source: preparedTaxRate.source,
      });
    } else {
      const mismatch = new Error(
        "upsertPlace: written place address differs from the tax-rate lookup address; rate not cached",
      );
      try {
        deps.reportError?.(mismatch, {
          tags: {
            useCase: deps.useCase ?? "upsertPlace",
            stage: "tax_rate_address_mismatch",
          },
          extra: {
            placeId: finalRecord.id,
            lookupPostalCode: taxLookupAddress.postalCode,
            lookupCountryCode: taxLookupAddress.countryCode,
            writtenPostalCode: finalRecord.postalCode,
            writtenCountryCode: finalRecord.countryCode,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never
        // escape the swallow branch and fail the place save.
      }
      logger?.error("tax_rate_address_mismatch", {
        placeId: finalRecord.id,
        lookupPostalCode: taxLookupAddress.postalCode,
        lookupCountryCode: taxLookupAddress.countryCode,
        writtenPostalCode: finalRecord.postalCode,
        writtenCountryCode: finalRecord.countryCode,
      });
    }
  }

  // ── Admission tax-rate cache, CLEAR on a jurisdiction change ──────────
  // Owner ruling 2026-10-03: when the venue's postcode or country changed
  // and no rate for the NEW one was cached above (provider miss, throwing
  // provider, no provider configured, no postcode, or the address-
  // mismatch guard), the old jurisdiction's rate is cleared rather than
  // kept. A NULL cache is a miss — event save and checkout look the rate
  // up again (`prepareEventTaxRate`) — whereas a kept rate is trusted
  // as-is and would charge the old jurisdiction's tax on every new stamp.
  //
  // Keyed on the jurisdiction, not `addressHash`: a street-text edit that
  // keeps the postcode keeps a rate that is still right for it, even when
  // that save's lookup failed.
  //
  // Compared against `placeBefore` (re-read under the exclusive lock),
  // not `existingPlace`: a concurrent edit that moved the venue between
  // the two reads must still count as a move for THIS write, and one that
  // already moved it to this same postcode (and cached its rate) must
  // not. Nothing to clear on CREATE — the new row's columns start null.
  //
  // Written unconditionally, even when `placeBefore` showed no rate: a
  // checkout's after-commit `fillTaxRateIfUnset` for the old postcode can
  // land between that read and the row write above.
  if (
    placeBefore &&
    !taxRateCached &&
    !sameTaxJurisdiction(placeBefore, finalRecord)
  ) {
    await tx.places.updateTaxRate({
      id: finalRecord.id,
      admissionTaxRateBps: null,
      taxRateSource: null,
      taxRateFetchedAt: null,
    });
    logger?.info("tax_rate_cleared_on_address_change", {
      placeId: finalRecord.id,
      previousRateBps: placeBefore.admissionTaxRateBps ?? null,
      previousSource: placeBefore.taxRateSource ?? null,
      previousPostalCode: placeBefore.postalCode ?? null,
      postalCode: finalRecord.postalCode ?? null,
    });
  }

  // `addressHash` is the adapter's `formatted.trim().toLowerCase()`; read
  // from the written row, so the timezone gate below does not depend on
  // core's mirror of that rule.
  const addressChanged =
    !existingPlace || existingPlace.addressHash !== finalRecord.addressHash;

  // The zone this write derived, if any. The address follow below writes
  // only events already in the place's zone, so whenever it runs the zone
  // is re-derived here too — including a pin move that kept the address
  // text (same `addressHash`, new lat/lng).
  let derivedTimezone: string | null = null;
  const addressFollows =
    placeBefore !== null && placeExactAddressChanged(placeBefore, finalRecord);
  if (addressChanged || addressFollows) {
    // ── Timezone derivation (venue-hierarchy FR-004) ─────────────────────
    // Derived from the address coordinates on create and whenever the
    // address text changes (keyed on `addressHash`, not the tax-rate
    // cache's postcode/country key — the timezone comes from lat/lng).
    // UNLIKE the rate, a `null` lookup (or missing port/coords) keeps the
    // existing value: a previously-derived timezone is never nulled out on
    // lookup failure (a venue rarely moves across a tz line; it often
    // moves across a tax jurisdiction).
    // A THROWING lookup is swallowed + reported: a place save must never
    // fail because tz lookup broke.
    const lat = normalizedAddress.lat;
    const lng = normalizedAddress.lng;
    if (deps.timezoneLookup && lat !== undefined && lng !== undefined) {
      let timezone: string | null = null;
      try {
        timezone = deps.timezoneLookup(lat, lng);
      } catch (error) {
        try {
          deps.reportError?.(error, {
            tags: {
              useCase: deps.useCase ?? "upsertPlace",
              stage: "timezone_lookup",
            },
            extra: { placeId: finalRecord.id },
          });
        } catch {
          // Reporting is best-effort — a throwing reporter must never
          // escape the swallow branch and fail the place save.
        }
        logger?.error("timezone_lookup_failed", {
          placeId: finalRecord.id,
          error: describeError(error),
        });
      }
      if (timezone) {
        derivedTimezone = timezone;
        await tx.places.updateTimezone({
          id: finalRecord.id,
          timezone,
        });
        logger?.info("timezone_cached_on_place", {
          placeId: finalRecord.id,
          timezone,
        });
      }
    }
  }

  // ── Event-location cascade, part 2b: EVENTS FOLLOW AN ADDRESS EDIT ──
  // EXACT → EXACT address edits reach this place's upcoming events (owner
  // ruling 2026-10-14). Scope, timezone rule and what is NOT touched:
  // `_shared/follow-place-address.ts`. A privacy change took part 2 above
  // and never reaches here as a follow (the helper checks both sides are
  // EXACT). Runs after the timezone derivation, which it reads. A failure
  // throws and rolls the place write back with it.
  if (placeBefore && addressFollows) {
    const follow = await followPlaceAddressOntoEvents(tx, {
      placeBefore,
      placeAfter: finalRecord,
      // A lookup miss keeps the stored zone (above), so it is the place's
      // zone after this write; null only when neither is known.
      placeTimezone: derivedTimezone ?? placeBefore.timezone ?? null,
      actorHumanId: input.actorHumanId,
      at: auditTime,
    });
    // Holder notices, if the owner rules for them, hang off `follow.eventIds`.
    if (follow.eventIds.length > 0) {
      reprojectedEventIds = [...reprojectedEventIds, ...follow.eventIds];
    }
  }

  // ── Search reindex marks (edit-triggered batched reindex) ───────────
  // The venue's document and every re-projected event's are stale from
  // this commit on. Marked here so the refresh survives a failed or
  // starved post-commit reindex (`search/search-reindex-marks.ts`).
  await markForSearchReindex(
    tx,
    [
      { kind: "place", id: finalRecord.id },
      ...reprojectedEventIds.map((id) => ({ kind: "event" as const, id })),
    ],
    auditTime,
  );

  // ── Search privacy scrub: the LAST step before commit ───────────────
  // When the venue now withholds its address, its search document (and
  // every re-projected event's) still holds the old public location, and
  // search plots it on a public map. The post-commit reindex below is
  // best-effort, so on its own a failure there would leave the old pin up
  // until the nightly reindex. Delete the documents here instead, and
  // THROW if that fails: the save rolls back and the owner retries, so
  // the venue is never withheld while its old document is still served.
  // See `search/privacy-scrub.ts`. The reindex below writes the redacted
  // documents back.
  if (placeBefore && placeLocationScrubNeeded(placeBefore, placeRecord)) {
    // On the transaction's own connection when the index is a Postgres
    // table: the DELETE commits or rolls back with the save.
    await scrubSearchDocumentsOrThrow(searchForTx(deps.search, tx), {
      docIds: [
        placeSearchDocId(placeRecord.id),
        ...reprojectedEventIds.map(eventSearchDocId),
      ],
      useCase: deps.useCase ?? "upsertPlace",
      logger,
      reportError: deps.reportError,
    });
  }

  return { record: finalRecord, reprojectedEventIds };
}

/**
 * After a Place write COMMITS: the best-effort reindex of the venue and of
 * every event the cascade re-projected. Never throws.
 */
export function afterPlaceWriteCommitted(
  deps: Pick<
    UpsertPlaceDeps,
    "repos" | "search" | "clock" | "logger" | "reportError"
  >,
  placeId: string,
  reprojectedEventIds: string[],
): void {
  reindexAfterMutation(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      // `buildSearchIndex` swallows a failed EntityPage read and writes a
      // null `pageSlug` — the venue silently loses its public link in
      // search until the nightly reindex. Only reportable if forwarded.
      reportError: deps.reportError,
    },
    "upsertPlace",
    { kind: "place", id: placeId },
  );

  // Event-location cascade, part 3: the search documents. Each event's
  // document carries its location, so a re-projected event whose document
  // still holds the old (true) point is a leak until the nightly reindex.
  reindexReprojectedEvents(deps, placeId, reprojectedEventIds);
}

/**
 * Single-event index passes in flight at once — see below. Each one is an
 * index-write fence transaction holding a pool connection for its build
 * (pool: 10 per process), so this stays small.
 */
const REPROJECT_REINDEX_CONCURRENCY = 2;

/**
 * Re-index every event the cascade re-projected, OFF the request path and
 * PACED — the same shape as `setPlaceCommunityListingAcceptance`'s fan-out,
 * for the same reason: each single-event pass is ~8–10 queries on the pool
 * that serves live requests, so a venue with thousands of events must not
 * dispatch them all at once. `runReindexAfterMutation` is the shared body of
 * `reindexAfterMutation` (same swallow/report discipline), handed back as a
 * promise so completion can apply back-pressure.
 *
 * Every id is re-indexed, not just PUBLISHED ones: `buildSearchIndex` decides
 * upsert vs remove per event, and a stale document for any of them is exactly
 * the leak this cascade closes. Whatever this misses, the nightly
 * `search.full-reindex` rebuilds from the (already re-projected) rows.
 */
function reindexReprojectedEvents(
  deps: Pick<
    UpsertPlaceDeps,
    "repos" | "search" | "clock" | "logger" | "reportError"
  >,
  placeId: string,
  eventIds: string[],
): void {
  if (!deps.search || eventIds.length === 0) return;

  const reindexDeps = {
    repos: deps.repos,
    search: deps.search,
    clock: deps.clock,
    logger: deps.logger,
    reportError: deps.reportError,
  };

  void (async () => {
    // Collect-and-rethrow, as in the fan-out this mirrors: one event's
    // failure never abandons the rest, and a broken "never rejects" contract
    // still reaches Sentry exactly once through the terminal catch.
    const failures: unknown[] = [];
    for (let i = 0; i < eventIds.length; i += REPROJECT_REINDEX_CONCURRENCY) {
      const settled = await Promise.allSettled(
        eventIds
          .slice(i, i + REPROJECT_REINDEX_CONCURRENCY)
          .map((id) =>
            runReindexAfterMutation(reindexDeps, "upsertPlace", {
              kind: "event",
              id,
            }),
          ),
      );
      for (const outcome of settled) {
        if (outcome.status === "rejected") failures.push(outcome.reason);
      }
    }

    deps.logger?.info("upsertPlace.reprojected_events_reindexed", {
      placeId,
      reindexed: eventIds.length - failures.length,
      failed: failures.length,
    });

    if (failures.length > 0) throw failures[0];
  })().catch((err: unknown) => {
    // No backstop above a fire-and-forget loop, and `warn` is not captured:
    // error + report, each guarded so a throwing logger/reporter changes
    // nothing (repo Sentry convention).
    try {
      deps.logger?.error("upsertPlace.reprojected_events_reindex_failed", {
        placeId,
        error: describeError(err),
      });
    } catch {
      // Best-effort.
    }
    try {
      deps.reportError?.(err, {
        tags: { useCase: "upsertPlace", op: "reindexReprojectedEvents" },
        extra: { placeId, eventCount: eventIds.length },
      });
    } catch {
      // Best-effort.
    }
  });
}

async function ensureOwnerAccess(
  repos: Repos,
  actorHumanId: string,
  owner: UpsertPlaceInput["owner"],
): Promise<void> {
  if (owner.kind === "human") {
    if (owner.humanId !== actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER");
    }
    const human = await repos.humans.getById(owner.humanId);
    if (!human) {
      throw fail("HUMAN_NOT_FOUND");
    }
    return;
  }

  await requireOrgMembership({
    repos,
    orgId: owner.orgId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
    errorCode: "NOT_RESOURCE_OWNER",
  });
}

/**
 * upsertPlace's write authorisation for an EXISTING place, as one call: the
 * actor may write as `owner` (the human themself, or an ORG_EDIT_ROLES
 * member of the org), and `owner` holds verified access to `place`.
 * Exported so publishPageDraft writes Place facts under exactly the check
 * the live path uses (spec entity-page-wysiwyg-editor R13: no new access).
 */
export async function assertPlaceWriteAccess(
  repos: Repos,
  actorHumanId: string,
  owner: UpsertPlaceInput["owner"],
  place: PlaceRecord,
): Promise<void> {
  await ensureOwnerAccess(repos, actorHumanId, owner);
  ensureOwnerMatches(place, owner);
}

/**
 * `owner` holds verified access to `place`. Exported so publishPageDraft can
 * re-check it on the Place row it re-reads under the place-location lock.
 */
export function ensureOwnerMatches(
  place: PlaceRecord,
  owner: UpsertPlaceInput["owner"],
): void {
  if (owner.kind === "org") {
    if (!place.orgIdsWithAccess.includes(owner.orgId)) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "org" } });
    }
    return;
  }

  if (!place.humanIdsWithAccess.includes(owner.humanId)) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "human" } });
  }
}

/**
 * Same admission-tax jurisdiction key — the postcode + country the rate is
 * looked up by (`lookupAdmissionTaxRate`). `undefined`/`null` are one value.
 */
function sameTaxJurisdiction(
  a: { postalCode?: string | null; countryCode?: string | null },
  b: { postalCode?: string | null; countryCode?: string | null },
): boolean {
  return (
    (a.postalCode ?? null) === (b.postalCode ?? null) &&
    (a.countryCode ?? null) === (b.countryCode ?? null)
  );
}

/**
 * An upsertPlace address as the Place write stores it. `line1` is optional
 * HERE ONLY so `updateCommunityPlace`'s name-only edit can re-send the stored
 * address without turning a stored NULL `addrLine1` into `""` (omitted =
 * the adapter leaves the column alone); `normalizeAddress` always sets it.
 */
export type NormalizedPlaceAddress = Omit<
  ReturnType<typeof normalizeAddress>,
  "line1"
> & { line1?: string };

export function normalizeAddress(
  address: UpsertPlaceInput["address"] & { lat?: number; lng?: number },
) {
  return {
    formatted: address.formatted.trim(),
    // `""`, not `null`: the existing addressless callers (submit-place-review's
    // stub place, the `?? ""` round-trips) already write the empty string, so
    // every read path downstream — `filter(Boolean)` joins, `addressLine1 && …`
    // guards — is already built for it. The port's `line1` is optional, where
    // omitted means "leave the stored column alone"; a save from a form
    // writes what the form says, so a missing line here is written as `""`.
    line1: address.line1?.trim() ?? "",
    line2: address.line2?.trim() ?? null,
    city: address.city?.trim() ?? null,
    region: address.region?.trim() ?? null,
    postalCode: address.postalCode?.trim() ?? null,
    countryCode: address.countryCode,
    lat: address.lat,
    lng: address.lng,
  };
}

function buildPayloadHash(input: {
  placeId: string | null;
  owner: UpsertPlaceInput["owner"];
  name: string;
  address: ReturnType<typeof normalizeAddress>;
  capacity: number | null;
  phone: string | null;
  website: string | null;
  /**
   * Address privacy, hashed so replaying a clientKey with a DIFFERENT privacy
   * choice is an IDEMPOTENCY_KEY_CONFLICT rather than a silently-ignored
   * change. `"unset"` distinguishes "omitted" (preserve) from an explicit
   * `null` (fully hidden) — they are different requests.
   */
  locationMode: "EXACT" | "OBSCURED" | null;
  locationRadiusMeters: number | null | "unset";
  locationLabel: string | null;
  /** Same reason as the location fields: a replay that flips it must conflict. */
  communityReviewsEnabled: boolean | "unset";
}): string {
  const hash = createHash("sha256");
  hash.update(input.placeId ?? "new");
  if (input.owner.kind === "org") {
    hash.update(`org:${input.owner.orgId}`);
  } else {
    hash.update(`human:${input.owner.humanId}`);
  }
  hash.update(input.name);
  hash.update(JSON.stringify(input.address));
  hash.update(String(input.capacity ?? ""));
  hash.update(input.phone ?? "");
  hash.update(input.website ?? "");
  hash.update(input.locationMode ?? "");
  hash.update(String(input.locationRadiusMeters));
  hash.update(input.locationLabel ?? "");
  hash.update(String(input.communityReviewsEnabled));
  return hash.digest("hex");
}

function buildIdempotencyKey(
  owner: UpsertPlaceInput["owner"],
  placeId: string | null,
  clientKey: string,
): string {
  if (owner.kind === "org") {
    return `place:org:${owner.orgId}:${placeId ?? "new"}:${clientKey}`;
  }
  return `place:human:${owner.humanId}:${placeId ?? "new"}:${clientKey}`;
}
