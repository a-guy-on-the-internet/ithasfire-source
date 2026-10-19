import { z } from "zod";

import type { PlaceRecord, TxRepos } from "@th/ports/repos";
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
  type NormalizedPlaceAddress,
  type PlaceWriteInput,
} from "../places/upsert-place";
import type { CreateCommunityPlaceDeps } from "./create-community-place";
import {
  assertPlaceUnowned,
  communityPlaceAddressSchema,
  communityPlaceNameSchema,
  communityPlaceSchema,
  communityPlaceUnitSchema,
  ensurePlaceNameAllowed,
  hashPayload,
  normalizePlaceName,
  refuseDuplicatePlace,
  toCommunityPlace,
} from "./_shared/community-place";
import {
  foldUnitIntoFormatted,
  stripUnitFromFormatted,
  unitOrNull,
} from "../../lib/location/place-unit";
import { communityWriteAddress } from "./_shared/community-place-unit";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";

/**
 * A community moderator (or platform ADMIN) corrects the name, address and
 * pin of a place NOBODY OWNS — the typo'd "Corner Bar Suoth" a moderator
 * created a minute ago, which would otherwise stay a public page while the
 * retyped name became a second row.
 *
 * Refused unless, read inside the transaction after `lockPlaceForClaim`:
 *  - the place exists (PLACE_NOT_FOUND) and is ACTIVE (PLACE_ARCHIVED /
 *    PLACE_NOT_ACTIVE);
 *  - nobody owns it, nobody is claiming it and no organiser's event uses it
 *    (PLACE_HAS_OWNER, `meta.reason` "OWNED" | "CLAIM_PENDING" |
 *    "OWNED_EVENTS_AT_PLACE"; orchestrator decision 2026-10-13: organisers'
 *    events come first, since their ticket emails read the live place name
 *    and address. Owner ruling 2026-10-14: only a PUBLISHED event that has
 *    not ended counts);
 *  - it publishes its address (INVALID_INPUT, meta.reason
 *    "PLACE_WITHHOLDS_ADDRESS"): this edit writes an address that every
 *    community listing at the place shows, and must never publish one
 *    someone chose to hide.
 *
 * It writes through `writePlaceInTx` with `owner: null` and the explicit
 * `ownerlessStaffWrite` flag, so it gets what an upsertPlace update gets:
 * the `updated` audit row (actor = the moderator, `ownerless: true`), the tax
 * rate re-looked-up when the postcode/country changes and cleared on a
 * jurisdiction change, the timezone re-derived when the address text
 * changes, the search mark and the after-commit reindex. Capacity, phone and
 * website are carried over unchanged, and so is `websiteSource`.
 *
 * NOT re-projected: community listings already linked to the place keep the
 * address they copied. The same is true when an owner edits an address-public
 * place through upsertPlace (`placeEventProjectionChanged` only fires for
 * withheld places).
 *
 * Duplicates: the same in-transaction guard as create, excluding this place.
 *
 * `address` OMITTED = a name-only correction: every stored address column
 * (address text, lines, city, region, postcode, country, pin) and the tax
 * rate are kept exactly as stored. The web edit dialog can only prefill from
 * the public place read, which lacks the street line and postcode, so
 * re-sending its address would blank them. The duplicate guard then probes
 * the new name against the STORED address and pin, read under the claim
 * lock, and the tax provider is not called. `addressHash` and the timezone
 * are kept for a row whose hash matches its address text; a row stored with
 * a NULL hash (some bulk imports) gets its hash written and its timezone
 * re-derived from the stored pin, as any save of that row would.
 *
 * A name-only edit is refused (INVALID_INPUT, `meta.reason`
 * "ADDRESS_INCOMPLETE") when the stored row has no country: the Place write
 * needs one, and writing `""` would count as a jurisdiction change and clear
 * the tax rate. The moderator picks the address again instead.
 *
 * "Unit or room" (`Place.addrLine2`, folded into the formatted text by the
 * server: `lib/location/place-unit.ts`). One rule for both places it can be
 * sent: the field ABSENT = keep the stored unit; null or "" = clear it; a
 * string = set it.
 *  - with `address`: `address.line2`. The new address text gets the
 *    resulting unit folded in.
 *  - without `address`: top-level `line2`, a unit-only (or name + unit) edit.
 *    Every other stored address column is kept; the stored unit is taken out
 *    of the stored text and the new one folded in.
 * Sending both `address` and top-level `line2` is refused (INVALID_INPUT,
 * `meta.reason` "UNIT_SENT_TWICE"). The web dialog always sends the unit, so
 * "absent" only reaches a client that does not know the field.
 *
 * Because the dialog always sends it, the FIRST moderator save of a row whose
 * `addrLine2` is set but whose formatted text lacks it (a CSV import:
 * `apps/web/src/lib/place-csv-address.ts` writes `line2` from its own column)
 * folds the unit into the public text. That save changes `addressHash` and
 * re-derives the timezone from the same pin; the tax rate is untouched
 * (postcode and country are unchanged).
 *
 * Known limit: strip assumes the unit at its position was put there by fold.
 * On such a row, a unit written separately that equals the segment right
 * after the street line is removed as if it were the unit when the unit is
 * changed.
 */
export const updateCommunityPlaceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    name: communityPlaceNameSchema,
    address: communityPlaceAddressSchema.optional(),
    line2: communityPlaceUnitSchema.optional(),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const updateCommunityPlaceOutputSchema = communityPlaceSchema;

export type UpdateCommunityPlaceInput = z.infer<
  typeof updateCommunityPlaceInputSchema
>;
export type UpdateCommunityPlaceOutput = z.infer<
  typeof updateCommunityPlaceOutputSchema
>;

/** Same deps as create: the same Place write. */
export type UpdateCommunityPlaceDeps = CreateCommunityPlaceDeps;

type StoredRecord = {
  payloadHash: string;
  response: UpdateCommunityPlaceOutput;
};

const USE_CASE = "updateCommunityPlace";

/**
 * The place a community moderator may change: exists, not SUSPENDED, ACTIVE
 * unless `allowArchived`, and `assertPlaceUnowned` passes. Shared by update
 * (which also needs EXACT), archive and restore.
 */
export async function loadUnownedPlaceForModerator(
  tx: Pick<TxRepos, "places" | "events">,
  placeId: string,
  options: { now: Date; allowArchived?: boolean },
): Promise<PlaceRecord> {
  const place = await tx.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND", { meta: { placeId } });
  }
  await assertPlaceUnowned(tx, place, options.now);
  if (place.status === "ARCHIVED" && !options.allowArchived) {
    throw fail("PLACE_ARCHIVED", { meta: { placeId } });
  }
  if (place.status === "SUSPENDED") {
    throw fail("PLACE_NOT_ACTIVE", { meta: { placeId, status: place.status } });
  }
  return place;
}

function assertAddressPublic(place: PlaceRecord): void {
  if (place.locationMode !== "EXACT") {
    throw fail("INVALID_INPUT", {
      message: "this place withholds its address",
      meta: { placeId: place.id, reason: "PLACE_WITHHOLDS_ADDRESS" },
    });
  }
}

export async function updateCommunityPlace(
  deps: UpdateCommunityPlaceDeps,
  rawInput: unknown,
): Promise<UpdateCommunityPlaceOutput> {
  const logger = deps.logger?.child({ useCase: USE_CASE });

  const input = parseInput(updateCommunityPlaceInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: COMMUNITY_MODERATION_ROLES,
  });

  if (input.address && input.line2 !== undefined) {
    throw fail("INVALID_INPUT", {
      message: "send the unit as address.line2 when an address is sent",
      meta: { placeId: input.placeId, reason: "UNIT_SENT_TWICE" },
    });
  }

  await ensurePlaceNameAllowed(deps.contentFilter, input.name);

  // Cheap rejections before any claim; every one is re-checked in the tx.
  const before = await loadUnownedPlaceForModerator(deps.repos, input.placeId, {
    now: deps.clock.now(),
  });
  assertAddressPublic(before);
  if (!input.address) assertStoredAddressComplete(before);

  const name = input.name.trim();
  // undefined = keep the stored unit; null = clear; string = set.
  const unitSent = input.address ? input.address.line2 : input.line2;
  const unitChange = unitSent === undefined ? undefined : unitOrNull(unitSent);
  // The sent address WITHOUT any unit: what the payload hash covers (the
  // unit is hashed on its own, below, since "keep" has no value yet).
  const normalizedInputAddress = input.address
    ? normalizeAddress(communityWriteAddress(input.address, null))
    : null;

  /** The address this edit writes, given the row it overwrites. */
  const addressToWrite = (place: PlaceRecord): NormalizedPlaceAddress => {
    const unit = unitChange === undefined ? place.addressLine2 : unitChange;
    if (input.address) {
      return normalizeAddress(communityWriteAddress(input.address, unit));
    }
    const stored = storedNormalizedAddress(place);
    if (unitChange === undefined) return stored;
    return {
      ...stored,
      formatted: foldUnitIntoFormatted(
        stripUnitFromFormatted(
          stored.formatted,
          place.addressLine1,
          place.addressLine2,
        ),
        place.addressLine1,
        unitChange,
      ),
      line2: unitChange,
    };
  };

  // An omitted address hashes as a fixed marker, never as the stored
  // address, so the same clientKey replayed WITH an address is a conflict.
  // The same for an omitted unit.
  const payloadHash = hashPayload(
    input.placeId,
    name,
    normalizedInputAddress ?? ADDRESS_UNCHANGED,
    unitChange === undefined ? UNIT_UNCHANGED : unitChange,
  );
  const idemKey = `place:community:update:${input.actorHumanId}:${input.placeId}:${input.clientKey}`;

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
  let updated: { place: PlaceRecord; reprojectedEventIds: string[] };
  try {
    const auditTime = deps.clock.now();
    // The provider call stays outside the tx, as in upsertPlace. It decides
    // from `before` whether the jurisdiction changed. A name-only edit
    // keeps the jurisdiction, so it makes no provider call.
    const preparedTax = normalizedInputAddress
      ? await preparePlaceTaxRate(deps, logger, before, addressToWrite(before))
      : null;

    updated = await deps.repos.tx(async (tx) => {
      // Lock order: the name, then the place's claim lock (which claim
      // submit and review take too), then writePlaceInTx's location lock.
      // The duplicate probe needs the address this edit writes, which can
      // depend on the stored unit, read below under the claim lock; the name
      // lock is still taken first.
      await tx.places.lockPlaceName(normalizePlaceName(name));
      await tx.places.lockPlaceForClaim(input.placeId);
      const current = await loadUnownedPlaceForModerator(tx, input.placeId, {
        now: auditTime,
      });
      assertAddressPublic(current);
      if (!normalizedInputAddress) assertStoredAddressComplete(current);

      const normalizedAddress = addressToWrite(current);
      await refuseDuplicatePlace(tx, {
        name,
        address: normalizedAddress,
        excludePlaceId: input.placeId,
      });

      const result = await writePlaceInTx(writeDeps, logger, tx, {
        input: {
          actorHumanId: input.actorHumanId,
          owner: null,
          placeId: input.placeId,
          name,
          address: placeWriteInputAddress(normalizedAddress),
          // Carried over: writePlaceInTx writes these three on every save.
          capacity: current.capacity ?? undefined,
          phone: current.phone,
          website: current.website,
        },
        existingPlace: current,
        normalizedAddress,
        ...(preparedTax ?? {
          // Unchanged postcode and country: nothing to look up, and
          // writePlaceInTx's jurisdiction compare sees no change.
          taxLookupAddress: {
            postalCode: normalizedAddress.postalCode,
            countryCode: normalizedAddress.countryCode,
          },
          preparedTaxRate: null,
        }),
        auditTime,
        ownerlessStaffWrite: true,
      });

      const place =
        (await tx.places.getById(input.placeId)) ?? result.record;

      // Every column this edit can change, before and after, so the edit
      // can be undone from the audit log alone.
      await tx.audit.log({
        entity: "place",
        entityId: input.placeId,
        action: "place.community_updated",
        data: {
          actorHumanId: input.actorHumanId,
          from: placeAuditSnapshot(current),
          to: placeAuditSnapshot(place),
        },
        at: auditTime,
      });

      return { place, reprojectedEventIds: result.reprojectedEventIds };
    });
  } catch (error) {
    await abandonClaim(deps.idempotency, idemKey, ownerToken, error, {
      useCase: USE_CASE,
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw asKnownError("update_community_place", error);
  }

  let response: UpdateCommunityPlaceOutput;
  try {
    response = updateCommunityPlaceOutputSchema.parse(
      toCommunityPlace(updated.place),
    );
    await deps.idempotency.commit<StoredRecord>(idemKey, {
      payloadHash,
      response,
    });
  } catch (error) {
    throw asKnownError("update_community_place", error);
  }

  afterPlaceWriteCommitted(deps, response.placeId, updated.reprojectedEventIds);

  logger?.info("community_place_updated", {
    placeId: response.placeId,
    actorHumanId: input.actorHumanId,
  });

  return response;
}

/** The payload-hash stand-in for an omitted address. */
const ADDRESS_UNCHANGED = "address:unchanged";

/** The payload-hash stand-in for an omitted unit (keep the stored one). */
const UNIT_UNCHANGED = "unit:unchanged";

/**
 * A name-only edit re-sends the stored address, and the Place write needs a
 * country: refused when the row has none (only reachable for a legacy row;
 * every write path requires one). `""` instead would read as a jurisdiction
 * change in writePlaceInTx and clear the cached tax rate.
 */
function assertStoredAddressComplete(place: PlaceRecord): void {
  if (!place.countryCode) {
    throw fail("INVALID_INPUT", {
      message: "this place's stored address has no country; pick the address again",
      meta: { placeId: place.id, reason: "ADDRESS_INCOMPLETE" },
    });
  }
}

/**
 * The stored address, as the Place write takes it, so a name-only edit
 * rewrites every address column with the value it already holds. `line1`
 * is left OUT when the stored line is NULL: the adapter then skips the
 * column, where `normalizeAddress` would have written `""`. The adapter
 * derives `addressHash` from `formatted`, so a row whose stored hash matches
 * its text keeps it (and its timezone); a row stored with a NULL hash gets
 * one written and its timezone re-derived.
 */
function storedNormalizedAddress(place: PlaceRecord): NormalizedPlaceAddress {
  return {
    formatted: place.formattedAddress ?? "",
    ...(place.addressLine1 !== null ? { line1: place.addressLine1 } : {}),
    line2: place.addressLine2,
    city: place.city,
    region: place.region,
    postalCode: place.postalCode,
    // Never "": `assertStoredAddressComplete` refused a row with no country.
    countryCode: place.countryCode ?? "",
    lat: place.lat ?? undefined,
    lng: place.lng ?? undefined,
  };
}

/**
 * `PlaceWriteInput.address` from the address this edit writes. INERT: it
 * only satisfies the input type. writePlaceInTx writes `normalizedAddress`,
 * never `input.address`.
 */
function placeWriteInputAddress(
  stored: NormalizedPlaceAddress,
): NonNullable<PlaceWriteInput["address"]> {
  return {
    formatted: stored.formatted,
    ...(stored.line1 !== undefined ? { line1: stored.line1 } : {}),
    ...(stored.line2 ? { line2: stored.line2 } : {}),
    city: stored.city ?? undefined,
    region: stored.region ?? undefined,
    postalCode: stored.postalCode ?? undefined,
    countryCode: stored.countryCode,
    ...(stored.lat !== undefined && stored.lng !== undefined
      ? { lat: stored.lat, lng: stored.lng }
      : {}),
  };
}

/**
 * The columns a community edit writes (name, address, pin) and the ones it
 * derives (timezone, tax rate), as the audit row's `from` / `to`.
 */
export function placeAuditSnapshot(place: PlaceRecord) {
  return {
    name: place.name,
    formattedAddress: place.formattedAddress,
    addressLine1: place.addressLine1,
    addressLine2: place.addressLine2,
    city: place.city,
    region: place.region,
    postalCode: place.postalCode,
    countryCode: place.countryCode,
    lat: place.lat,
    lng: place.lng,
    timezone: place.timezone,
    admissionTaxRateBps: place.admissionTaxRateBps,
    taxRateSource: place.taxRateSource,
  };
}
