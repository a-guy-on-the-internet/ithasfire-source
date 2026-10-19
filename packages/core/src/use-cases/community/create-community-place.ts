import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PlaceRecord, Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import { fail } from "@th/errors";

import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import {
  afterPlaceWriteCommitted,
  normalizeAddress,
  preparePlaceTaxRate,
  writePlaceInTx,
} from "../places/upsert-place";
import {
  communityPlaceAddressSchema,
  communityPlaceNameSchema,
  communityPlaceSchema,
  ensurePlaceNameAllowed,
  hashPayload,
  lockAndRefuseDuplicatePlace,
  toCommunityPlace,
} from "./_shared/community-place";
import { communityWriteAddress } from "./_shared/community-place-unit";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";

/**
 * A community moderator (or platform ADMIN) adds a place NOBODY OWNS, so a
 * community listing can be held at a room no geocoder knows by name ("Corner
 * Bar South" at 2190A Nolensville Pike). Owner ruling 2026-10-13.
 *
 * The place is created through the ONE Place write path (`writePlaceInTx`,
 * shared with upsertPlace and publishPageDraft) with `owner: null`, so it gets
 * everything an owned create gets — the `place`/`created` audit row (marked
 * `ownerless`), its EntityPage, "Main Space" + "Main Calendar", the cached tax
 * rate, the timezone, the search mark and the after-commit reindex — and NO
 * PlaceOwnership row. Anyone may later claim it through the normal claim flow.
 * Until then a moderator corrects it with `updateCommunityPlace` and retires
 * it with `archiveCommunityPlace`.
 *
 * It is born ACTIVE, UNVERIFIED, address public (EXACT) and LISTED in the
 * directory (owner ruling 2026-10-14: "places made by platform admins should
 * appear in the directory", scope admins and moderators). The listing is
 * audited as `place.directory_listed`, the same action and data shape
 * `setPlaceDirectoryListing` writes, so one action answers "when and by whom
 * was this place listed". EXACT plus a required pin is what makes it pass
 * `resolveListingPlaceLocation`, the rule a community listing's place must
 * meet.
 *
 * Duplicates: `lockAndRefuseDuplicatePlace`, inside the transaction.
 */
export const createCommunityPlaceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    name: communityPlaceNameSchema,
    address: communityPlaceAddressSchema,
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const createCommunityPlaceOutputSchema = communityPlaceSchema;

export type CreateCommunityPlaceInput = z.infer<
  typeof createCommunityPlaceInputSchema
>;
export type CreateCommunityPlaceOutput = z.infer<
  typeof createCommunityPlaceOutputSchema
>;

export type CreateCommunityPlaceDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  logger?: LoggerPort;
  /** Best-effort reindex after commit (and the in-tx search mark). */
  search?: MultiSearchPort;
  /** Caches the admission tax rate on create. Non-fatal when absent. */
  taxRateLookup?: TaxRateLookupPort | null;
  /** Derives `Place.timezone` from the pin. Non-fatal when absent. */
  timezoneLookup?: TimezoneLookupPort | null;
  /**
   * The Place write's swallow branches (a throwing tax or timezone lookup,
   * a failed post-commit reindex) report here. Repo Sentry convention.
   */
  reportError?: ReporterPort;
};

type StoredRecord = {
  payloadHash: string;
  response: CreateCommunityPlaceOutput;
};

const USE_CASE = "createCommunityPlace";

/** Audit reason on the `place.directory_listed` row written at create. */
const DIRECTORY_LISTING_REASON =
  "Staff-created place listed (owner ruling 2026-10-14)";

export async function createCommunityPlace(
  deps: CreateCommunityPlaceDeps,
  rawInput: unknown,
): Promise<CreateCommunityPlaceOutput> {
  const logger = deps.logger?.child({ useCase: USE_CASE });

  const input = parseInput(createCommunityPlaceInputSchema, rawInput);

  // Actor gate: COMMUNITY_MODERATOR or platform ADMIN (the same gate as
  // `createCommunityListing`). Never trust a client-sent role.
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: COMMUNITY_MODERATION_ROLES,
  });

  await ensurePlaceNameAllowed(deps.contentFilter, input.name);

  // "Unit or room" lands in `addrLine2` and is folded into the formatted
  // text (`community-place-unit.ts`); none = a NULL `addrLine2`.
  const writeAddress = communityWriteAddress(
    input.address,
    input.address.line2 ?? null,
  );
  const normalizedAddress = normalizeAddress(writeAddress);
  const name = input.name.trim();

  const payloadHash = hashPayload(name, normalizedAddress);
  const idemKey = `place:community:create:${input.actorHumanId}:${input.clientKey}`;

  const replay = await deps.idempotency.get<StoredRecord>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const ownerToken = crypto.randomUUID();
  const claimed = await deps.idempotency.begin(idemKey, 300, ownerToken);
  if (!claimed) {
    const afterWait = await deps.idempotency.get<StoredRecord>(idemKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  const writeDeps = { ...deps, useCase: USE_CASE };
  let created: { place: PlaceRecord; reprojectedEventIds: string[] };
  try {
    const auditTime = deps.clock.now();
    const { taxLookupAddress, preparedTaxRate } = await preparePlaceTaxRate(
      deps,
      logger,
      null,
      normalizedAddress,
    );

    created = await deps.repos.tx(async (tx) => {
      // Lock the name, then look: a racing create of the same name commits
      // first and is refused here, or waits for this one.
      await lockAndRefuseDuplicatePlace(tx, { name, address: normalizedAddress });

      const result = await writePlaceInTx(writeDeps, logger, tx, {
        input: {
          actorHumanId: input.actorHumanId,
          owner: null,
          name,
          address: writeAddress,
          // Address public: the place exists to be picked by a community
          // listing, which refuses a place that withholds its address.
          locationMode: "EXACT",
        },
        existingPlace: null,
        normalizedAddress,
        taxLookupAddress,
        preparedTaxRate,
        auditTime,
        listInDirectoryOnCreate: true,
      });

      // Who added it and how, beside writePlaceInTx's `created` row (which
      // already carries the actor and `ownerless: true`).
      await tx.audit.log({
        entity: "place",
        entityId: result.record.id,
        action: "place.community_created",
        data: {
          actorHumanId: input.actorHumanId,
          name,
          formattedAddress: normalizedAddress.formatted,
          addressLine2: normalizedAddress.line2,
          countryCode: normalizedAddress.countryCode,
          lat: normalizedAddress.lat,
          lng: normalizedAddress.lng,
        },
        at: auditTime,
      });

      // Listed at birth: the same row `setPlaceDirectoryListing` writes.
      await tx.audit.log({
        entity: "place",
        entityId: result.record.id,
        action: "place.directory_listed",
        data: {
          previous: false,
          next: true,
          reason: DIRECTORY_LISTING_REASON,
          actorHumanId: input.actorHumanId,
        },
        at: auditTime,
      });

      // Re-read: the timezone and tax rate were written after the row.
      const place =
        (await tx.places.getById(result.record.id)) ?? result.record;
      return { place, reprojectedEventIds: result.reprojectedEventIds };
    });
  } catch (error) {
    // Release so the same-key retry proceeds at once (lib/idempotency-claim.ts).
    await abandonClaim(deps.idempotency, idemKey, ownerToken, error, {
      useCase: USE_CASE,
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw asKnownError("create_community_place", error);
  }

  let response: CreateCommunityPlaceOutput;
  try {
    response = createCommunityPlaceOutputSchema.parse(
      toCommunityPlace(created.place),
    );
    await deps.idempotency.commit<StoredRecord>(idemKey, {
      payloadHash,
      response,
    });
  } catch (error) {
    // Work is committed: keep the claim (no release) and surface the error.
    throw asKnownError("create_community_place", error);
  }

  afterPlaceWriteCommitted(deps, response.placeId, created.reprojectedEventIds);

  logger?.info("community_place_created", {
    placeId: response.placeId,
    actorHumanId: input.actorHumanId,
  });

  return response;
}
