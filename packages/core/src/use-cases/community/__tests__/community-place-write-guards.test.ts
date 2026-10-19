import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import { normalizeAddress, writePlaceInTx } from "../../places/upsert-place";
import {
  EXISTING_PLACE_ID,
  buildHarness,
  makePlace,
  provisionalClaim,
  verifiedOwnership,
  type HarnessOptions,
} from "./community-place-harness";
import { MODERATOR_ID, NOW } from "./helpers";

/**
 * The ownerless pieces of `writePlaceInTx` itself, called directly: the
 * guards must hold even for a caller that gets the flag wrong.
 */

const IMPORTED = makePlace({
  name: "Corner Bar South",
  website: "https://cornerbar.example",
  websiteSource: "TRUSTED_IMPORT",
});

const ADDRESS = {
  formatted: "2190A Nolensville Pike, Nashville, TN 37211, USA",
  countryCode: "US",
  lat: IMPORTED.lat!,
  lng: IMPORTED.lng!,
};

function ownerlessUpdate(
  overrides: { website?: string | null; flag?: boolean } = {},
) {
  return {
    input: {
      actorHumanId: MODERATOR_ID,
      owner: null,
      placeId: EXISTING_PLACE_ID,
      name: "Corner Bar South",
      address: ADDRESS,
      website:
        overrides.website !== undefined ? overrides.website : IMPORTED.website,
    },
    existingPlace: IMPORTED,
    normalizedAddress: normalizeAddress(ADDRESS),
    taxLookupAddress: { postalCode: null, countryCode: "US" },
    preparedTaxRate: null,
    auditTime: NOW,
    ...(overrides.flag === false ? {} : { ownerlessStaffWrite: true as const }),
  };
}

function txOf(h: ReturnType<typeof buildHarness>): TxRepos {
  return h.deps.repos as unknown as TxRepos;
}

describe("writePlaceInTx — ownerless update", () => {
  it("is refused without the explicit staff flag (INTERNAL), before any write", async () => {
    const h = buildHarness({ places: [IMPORTED] });

    await expect(
      writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate({ flag: false })),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("re-checks ownership under the lock even WITH the flag: an owned place is PLACE_HAS_OWNER", async () => {
    const h = buildHarness({
      places: [IMPORTED],
      verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) },
    });

    await expect(
      writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate()),
    ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER" });
    expect(h.mocks.lockLocationsAtPlace).toHaveBeenCalled();
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a provisional claim",
      { provisionalClaims: { [EXISTING_PLACE_ID]: provisionalClaim(EXISTING_PLACE_ID) } },
      false,
      "CLAIM_PENDING",
    ],
    ["verificationStatus PENDING on the re-read row", {}, true, "CLAIM_PENDING"],
    [
      "an organiser's event at the place",
      { ownedEventPlaceIds: [EXISTING_PLACE_ID] },
      false,
      "OWNED_EVENTS_AT_PLACE",
    ],
  ] as const)(
    "WITH the flag, refuses %s under the lock: PLACE_HAS_OWNER, reason %s",
    async (_label, opts, pending, reason) => {
      const h = buildHarness({
        places: [pending ? { ...IMPORTED, verificationStatus: "PENDING" } : IMPORTED],
        ...(opts as HarnessOptions),
      });

      await expect(
        writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate()),
      ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER", meta: { reason } });
      expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    },
  );

  it("asks for an organiser's LIVE events as of the write's audit time", async () => {
    const h = buildHarness({ places: [IMPORTED] });

    await writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate());

    const events = (h.deps.repos as unknown as {
      events: { hasOwnedLiveEventsAtPlace: ReturnType<typeof vi.fn> };
    }).events;
    expect(events.hasOwnedLiveEventsAtPlace).toHaveBeenCalledWith({
      placeId: EXISTING_PLACE_ID,
      now: NOW,
    });
  });

  it("refuses when the RE-READ row (not the caller's copy) shows an owner", async () => {
    const h = buildHarness({
      places: [{ ...IMPORTED, humanIdsWithAccess: ["ffffffff-ffff-4fff-8fff-ffffffffffff"] }],
    });

    await expect(
      writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate()),
    ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER" });
  });

  it("keeps TRUSTED_IMPORT while the website is unchanged", async () => {
    const h = buildHarness({ places: [IMPORTED] });

    await writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate());

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      website: "https://cornerbar.example",
      websiteSource: "TRUSTED_IMPORT",
    });
  });

  it("TAKEOVER GUARD: a changed website drops to USER_STUB, so a claimant from that domain cannot auto-verify", async () => {
    const h = buildHarness({ places: [IMPORTED] });

    await writePlaceInTx(
      {},
      undefined,
      txOf(h),
      ownerlessUpdate({ website: "https://attacker.example" }),
    );

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      website: "https://attacker.example",
      websiteSource: "USER_STUB",
    });
  });

  it("a cleared website is a change too: USER_STUB", async () => {
    const h = buildHarness({ places: [IMPORTED] });

    await writePlaceInTx({}, undefined, txOf(h), ownerlessUpdate({ website: null }));

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      website: null,
      websiteSource: "USER_STUB",
    });
  });
});
