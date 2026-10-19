import { describe, expect, it, vi } from "vitest";

import { archiveCommunityPlace } from "../archive-community-place";
import {
  EXISTING_PLACE_ID,
  auditRows,
  buildHarness,
  makePlace,
  provisionalClaim,
  verifiedOwnership,
} from "./community-place-harness";
import { MODERATOR_ID, NOW, USER_ID } from "./helpers";

/**
 * archiveCommunityPlace — a moderator retires a place NOBODY owns (the
 * duplicate, the typo). It leaves search, so the place picker stops offering
 * it; nothing else about the place, or the listings at it, changes.
 */

const PLACE = makePlace({
  addressLine1: null,
  countryCode: "US",
  capacity: 80,
  website: "https://cornerbar.example",
});

const BASE_INPUT = {
  actorHumanId: MODERATOR_ID,
  placeId: EXISTING_PLACE_ID,
  clientKey: "community-place-archive-1",
};

describe("archiveCommunityPlace", () => {
  it("refuses a non-moderator before any write", async () => {
    const h = buildHarness({ places: [PLACE] });

    await expect(
      archiveCommunityPlace(h.deps, { ...BASE_INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });

  it("refuses a claimed place: PLACE_HAS_OWNER", async () => {
    const h = buildHarness({
      places: [PLACE],
      verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) },
    });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("re-checks under the claim lock: a claim verified meanwhile wins", async () => {
    const h = buildHarness({
      places: [PLACE],
      onClaimLock: (placeId) => {
        h.verifiedOwners.set(placeId, verifiedOwnership(placeId));
      },
    });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("archives an unowned place: status only, every other column kept, audited as the moderator", async () => {
    const h = buildHarness({ places: [PLACE] });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).resolves.toEqual({
      placeId: EXISTING_PLACE_ID,
      status: "ARCHIVED",
    });

    // `places.setStatus` writes the status column and nothing else.
    expect(h.mocks.placesRepo.setStatus).toHaveBeenCalledWith({
      placeId: EXISTING_PLACE_ID,
      status: "ARCHIVED",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(h.rows.get(EXISTING_PLACE_ID)).toEqual({
      ...PLACE,
      status: "ARCHIVED",
    });
    expect(
      auditRows(h.mocks.auditRepo.log).find(
        (r) => r.action === "place.community_archived",
      )!.data,
    ).toMatchObject({ actorHumanId: MODERATOR_ID, from: "ACTIVE", to: "ARCHIVED" });
    expect(h.mocks.markSpy).toHaveBeenCalledTimes(1);
  });

  it("takes it out of the search the place picker uses (the real reindex removes the document)", async () => {
    const h = buildHarness({ places: [PLACE], withSearch: true });

    await archiveCommunityPlace(h.deps, BASE_INPUT);

    await vi.waitFor(() =>
      expect(h.search!.deleteDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ ids: [`place_${EXISTING_PLACE_ID}`] }),
      ),
    );
    expect(h.search!.upsertDocuments).not.toHaveBeenCalled();
  });

  it("a place with NO address stays without one (never rewritten as \"\")", async () => {
    const bare = makePlace({ formattedAddress: null });
    const h = buildHarness({ places: [bare] });

    await archiveCommunityPlace(h.deps, BASE_INPUT);

    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      formattedAddress: null,
      addressHash: null,
      status: "ARCHIVED",
    });
  });

  it.each([
    [
      "a place with a claim in review",
      { provisionalClaims: { [EXISTING_PLACE_ID]: provisionalClaim(EXISTING_PLACE_ID) } },
      "CLAIM_PENDING",
    ],
    ["a place whose verificationStatus is PENDING", { pending: true }, "CLAIM_PENDING"],
    [
      "a place an organiser's event uses",
      { ownedEventPlaceIds: [EXISTING_PLACE_ID] },
      "OWNED_EVENTS_AT_PLACE",
    ],
  ] as const)("refuses %s: PLACE_HAS_OWNER, reason %s", async (_label, opts, reason) => {
    const { pending, ...rest } = opts as { pending?: boolean };
    const h = buildHarness({
      places: [pending ? { ...PLACE, verificationStatus: "PENDING" } : PLACE],
      ...rest,
    });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses while live published community listings use the place, with the count", async () => {
    const h = buildHarness({
      places: [PLACE],
      liveListingCounts: { [EXISTING_PLACE_ID]: 3 },
    });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_LIVE_LISTINGS",
      meta: { reason: "LINKED_LISTINGS", linkedListingCount: 3 },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    // Counted against the use case's clock, inside the transaction.
    const events = (h.deps.repos as unknown as {
      events: { countLiveCommunityListingsAtPlace: ReturnType<typeof vi.fn> };
    }).events;
    expect(events.countLiveCommunityListingsAtPlace).toHaveBeenCalledWith({
      placeId: EXISTING_PLACE_ID,
      now: NOW,
    });
  });

  it("re-checks under the claim lock: a claim submitted meanwhile wins (CLAIM_PENDING)", async () => {
    const h = buildHarness({
      places: [PLACE],
      onClaimLock: (placeId) => {
        h.provisionalClaims.set(placeId, provisionalClaim(placeId));
      },
    });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("an already-archived place is a no-op that returns it", async () => {
    const h = buildHarness({ places: [{ ...PLACE, status: "ARCHIVED" }] });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).resolves.toEqual({
      placeId: EXISTING_PLACE_ID,
      status: "ARCHIVED",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(h.mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("refuses a SUSPENDED place (staff's call)", async () => {
    const h = buildHarness({ places: [{ ...PLACE, status: "SUSPENDED" }] });

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_NOT_ACTIVE",
    });
  });

  it("PLACE_NOT_FOUND for an unknown place", async () => {
    const h = buildHarness();

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  it("replays the same clientKey", async () => {
    const h = buildHarness({ places: [PLACE] });

    await archiveCommunityPlace(h.deps, BASE_INPUT);
    await archiveCommunityPlace(h.deps, BASE_INPUT);

    expect(h.mocks.placesRepo.setStatus).toHaveBeenCalledTimes(1);
  });

  it("answers a replay BEFORE re-reading the place: the first answer stands even after a claim lands", async () => {
    const h = buildHarness({ places: [PLACE] });

    await archiveCommunityPlace(h.deps, BASE_INPUT);
    // A claim lands afterwards; a fresh archive would now be refused.
    h.provisionalClaims.set(EXISTING_PLACE_ID, provisionalClaim(EXISTING_PLACE_ID));
    h.mocks.placesRepo.getById.mockClear();

    await expect(archiveCommunityPlace(h.deps, BASE_INPUT)).resolves.toEqual({
      placeId: EXISTING_PLACE_ID,
      status: "ARCHIVED",
    });
    expect(h.mocks.placesRepo.getById).not.toHaveBeenCalled();
  });

  it("takes the claim lock, then the place-location lock EXCLUSIVE, before the reads and the write", async () => {
    const h = buildHarness({ places: [PLACE] });
    const events = (h.deps.repos as unknown as {
      events: {
        countLiveCommunityListingsAtPlace: ReturnType<typeof vi.fn>;
        hasOwnedLiveEventsAtPlace: ReturnType<typeof vi.fn>;
      };
    }).events;
    events.countLiveCommunityListingsAtPlace.mockImplementation(async () => {
      h.order.push("countLiveCommunityListingsAtPlace");
      return 0;
    });
    events.hasOwnedLiveEventsAtPlace.mockImplementation(async () => {
      h.order.push("hasOwnedLiveEventsAtPlace");
      return false;
    });

    await archiveCommunityPlace(h.deps, BASE_INPUT);

    // The pre-check outside the tx also reads owned events; look at the tx.
    const claim = h.order.indexOf(`lockPlaceForClaim:${EXISTING_PLACE_ID}`);
    const inTx = h.order.slice(claim);
    expect(inTx).toEqual([
      `lockPlaceForClaim:${EXISTING_PLACE_ID}`,
      "lockLocationsAtPlace:exclusive",
      "hasOwnedLiveEventsAtPlace",
      "countLiveCommunityListingsAtPlace",
      "setStatus:ARCHIVED",
    ]);
  });
});
