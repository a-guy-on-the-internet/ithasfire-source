import { describe, expect, it, vi } from "vitest";

import { archiveCommunityPlace } from "../archive-community-place";
import { restoreCommunityPlace } from "../restore-community-place";
import {
  EXISTING_PLACE_ID,
  OTHER_PLACE_ID,
  auditRows,
  buildHarness,
  makePlace,
  provisionalClaim,
  verifiedOwnership,
  type HarnessOptions,
} from "./community-place-harness";
import { ADMIN_ID, MODERATOR_ID, USER_ID } from "./helpers";

/**
 * restoreCommunityPlace — a moderator brings back a place they archived by
 * mistake, under the same rules as archive.
 */

const ARCHIVED = makePlace({
  status: "ARCHIVED",
  formattedAddress: "2190 Nolensville Pike, Nashville, TN 37211, USA",
  capacity: 80,
  website: "https://cornerbar.example",
  websiteSource: "TRUSTED_IMPORT",
});

const T0 = new Date("2026-06-01T12:00:00.000Z");
const T1 = new Date("2026-06-02T12:00:00.000Z");
const T2 = new Date("2026-06-03T12:00:00.000Z");

/** The audit row a moderator's archive leaves. */
const MOD_ARCHIVED = [
  { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
];

const BASE_INPUT = {
  actorHumanId: MODERATOR_ID,
  placeId: EXISTING_PLACE_ID,
  clientKey: "community-place-restore-1",
};

describe("restoreCommunityPlace — who may, and which places", () => {
  it("refuses when the owner's status_updated is hidden behind 51 newer verification_status_updated rows", async () => {
    const noise = Array.from({ length: 51 }, (_, i) => ({
      entityId: EXISTING_PLACE_ID,
      action: "verification_status_updated",
      at: new Date(T2.getTime() + (i + 1) * 60_000),
    }));
    const h = buildHarness({
      auditSeed: [
        ...MOD_ARCHIVED,
        { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T2 },
        ...noise,
      ],
      places: [ARCHIVED],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "NOT_COMMUNITY_ARCHIVED", latestStatusAction: "status_updated" },
    });
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
  });

  it("refuses a non-moderator before any write", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED],
    });

    await expect(
      restoreCommunityPlace(h.deps, { ...BASE_INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });

  it("PLACE_NOT_FOUND for an unknown place", async () => {
    const h = buildHarness({ auditSeed: MOD_ARCHIVED });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  it("refuses an ACTIVE place: CONFLICT, reason PLACE_NOT_ARCHIVED", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [{ ...ARCHIVED, status: "ACTIVE" }],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "PLACE_NOT_ARCHIVED", status: "ACTIVE" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses a SUSPENDED place (staff's call)", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [{ ...ARCHIVED, status: "SUSPENDED" }],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_NOT_ACTIVE",
    });
  });

  it.each([
    [
      "an owned place",
      { verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) } },
      "OWNED",
    ],
    [
      "a place with a claim in review",
      { provisionalClaims: { [EXISTING_PLACE_ID]: provisionalClaim(EXISTING_PLACE_ID) } },
      "CLAIM_PENDING",
    ],
    [
      "a place an organiser's event uses",
      { ownedEventPlaceIds: [EXISTING_PLACE_ID] },
      "OWNED_EVENTS_AT_PLACE",
    ],
  ] as const)("refuses %s: PLACE_HAS_OWNER, reason %s", async (_label, opts, reason) => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED], ...(opts as HarnessOptions),
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("re-checks under the claim lock: a claim submitted meanwhile wins (CLAIM_PENDING)", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED],
      onClaimLock: (placeId) => {
        h.provisionalClaims.set(placeId, provisionalClaim(placeId));
      },
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses when an ACTIVE same-name place was added at the same spot meanwhile", async () => {
    const twin = makePlace({ id: OTHER_PLACE_ID });
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED, twin],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(h.finder.findActiveExactByNormalizedName).toHaveBeenCalledWith(
      expect.objectContaining({ excludePlaceId: EXISTING_PLACE_ID }),
    );
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });
});

describe("restoreCommunityPlace — only what a moderator archived", () => {
  it.each([
    [
      "its owner archived it (ownership later revoked)",
      [{ entityId: EXISTING_PLACE_ID, action: "status_updated", at: T1 }],
      "status_updated",
    ],
    [
      "a moderator archived it, but its owner re-archived it since",
      [
        { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T0 },
        { entityId: EXISTING_PLACE_ID, action: "place.community_restored", at: T1 },
        { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T2 },
      ],
      "status_updated",
    ],
    ["no status change was ever audited (raw SQL, an import)", [], null],
  ] as const)(
    "refuses when %s: CONFLICT, reason NOT_COMMUNITY_ARCHIVED",
    async (_label, auditSeed, latestStatusAction) => {
      const h = buildHarness({ auditSeed: [...auditSeed], places: [ARCHIVED] });

      await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
        code: "CONFLICT",
        meta: { reason: "NOT_COMMUNITY_ARCHIVED", latestStatusAction },
      });
      expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
    },
  );

  it("a later NON-status row (verification_status_updated, an edit) does not hide the moderator's archive", async () => {
    const h = buildHarness({
      auditSeed: [
        { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T0 },
        { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
        { entityId: EXISTING_PLACE_ID, action: "verification_status_updated", at: T2 },
        { entityId: EXISTING_PLACE_ID, action: "updated", at: T2 },
      ],
      places: [ARCHIVED],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("a moderator restores after an archive, restore, archive cycle (the newest row is the community archive)", async () => {
    const h = buildHarness({
      auditSeed: [
        { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T0 },
        { entityId: EXISTING_PLACE_ID, action: "place.community_restored", at: T1 },
        { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T2 },
      ],
      places: [ARCHIVED],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("another place's rows do not count", async () => {
    const h = buildHarness({
      auditSeed: [
        { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T1 },
        { entityId: OTHER_PLACE_ID, action: "place.community_archived", at: T2 },
      ],
      places: [ARCHIVED],
    });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      meta: { reason: "NOT_COMMUNITY_ARCHIVED" },
    });
  });
});

describe("restoreCommunityPlace — a platform ADMIN restores what a moderator did not archive (owner ruling 2026-10-14)", () => {
  /** Archived by its owner (status_updated), whose ownership was later revoked. */
  const OWNER_ARCHIVED = [
    { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T0 },
    { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T1 },
  ];
  const ADMIN_INPUT = { ...BASE_INPUT, actorHumanId: ADMIN_ID };

  it.each([
    ["archived by status_updated (owner lost ownership)", OWNER_ARCHIVED, "status_updated"],
    ["a legacy archived row with no status audit row", [], null],
  ] as const)(
    "an ADMIN restores a place %s, and the audit row says which rule applied",
    async (_label, auditSeed, previousStatusAction) => {
      const h = buildHarness({ auditSeed: [...auditSeed], places: [ARCHIVED] });

      await expect(restoreCommunityPlace(h.deps, ADMIN_INPUT)).resolves.toMatchObject({
        placeId: EXISTING_PLACE_ID,
        status: "ACTIVE",
      });
      expect(h.mocks.placesRepo.setStatus).toHaveBeenCalledWith({
        placeId: EXISTING_PLACE_ID,
        status: "ACTIVE",
      });
      const restoredRow = auditRows(h.mocks.auditRepo.log).find(
        (r) => r.action === "place.community_restored",
      );
      expect(restoredRow!.data).toMatchObject({
        actorHumanId: ADMIN_ID,
        from: "ARCHIVED",
        to: "ACTIVE",
        restoredBy: "ADMIN",
        previousStatusAction,
      });
    },
  );

  it("a moderator is still refused the same place: NOT_COMMUNITY_ARCHIVED", async () => {
    const h = buildHarness({ auditSeed: OWNER_ARCHIVED, places: [ARCHIVED] });

    await expect(restoreCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "NOT_COMMUNITY_ARCHIVED", latestStatusAction: "status_updated" },
    });
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
  });

  it("a moderator's restore records restoredBy COMMUNITY_MODERATOR and the community archive", async () => {
    const h = buildHarness({ auditSeed: MOD_ARCHIVED, places: [ARCHIVED] });

    await restoreCommunityPlace(h.deps, BASE_INPUT);

    expect(
      auditRows(h.mocks.auditRepo.log).find(
        (r) => r.action === "place.community_restored",
      )!.data,
    ).toMatchObject({
      actorHumanId: MODERATOR_ID,
      restoredBy: "COMMUNITY_MODERATOR",
      previousStatusAction: "place.community_archived",
    });
  });

  it.each([
    [
      "an owned place",
      { verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) } },
      "OWNED",
    ],
    [
      "a place with a claim in review",
      { provisionalClaims: { [EXISTING_PLACE_ID]: provisionalClaim(EXISTING_PLACE_ID) } },
      "CLAIM_PENDING",
    ],
    [
      "a place an organiser's event uses",
      { ownedEventPlaceIds: [EXISTING_PLACE_ID] },
      "OWNED_EVENTS_AT_PLACE",
    ],
  ] as const)("an ADMIN is still refused %s: PLACE_HAS_OWNER, reason %s", async (_label, opts, reason) => {
    const h = buildHarness({
      auditSeed: OWNER_ARCHIVED,
      places: [ARCHIVED],
      ...(opts as HarnessOptions),
    });

    await expect(restoreCommunityPlace(h.deps, ADMIN_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason },
    });
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
  });

  it("an ADMIN is still refused when an ACTIVE same-name place stands at the same spot", async () => {
    const twin = makePlace({ id: OTHER_PLACE_ID });
    const h = buildHarness({ auditSeed: OWNER_ARCHIVED, places: [ARCHIVED, twin] });

    await expect(restoreCommunityPlace(h.deps, ADMIN_INPUT)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
  });

  it("an admin probe that answers secondFactorRequired does not count as admin: the moderator gate passes, the place stays NOT_COMMUNITY_ARCHIVED", async () => {
    const h = buildHarness({ auditSeed: OWNER_ARCHIVED, places: [ARCHIVED] });
    const hasStaffRole = vi.fn(
      async ({ requiredRoles }: { requiredRoles: readonly string[] }) =>
        requiredRoles.length === 1 && requiredRoles[0] === "ADMIN"
          ? { allowed: false, secondFactorRequired: true as const }
          : { allowed: true },
    );

    await expect(
      restoreCommunityPlace(
        { ...h.deps, authz: { hasStaffRole } } as unknown as typeof h.deps,
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "NOT_COMMUNITY_ARCHIVED", latestStatusAction: "status_updated" },
    });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({ requiredRoles: ["ADMIN"] }),
    );
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
  });

  it("an ADMIN without a second factor is refused before any read or write", async () => {
    const h = buildHarness({ auditSeed: OWNER_ARCHIVED, places: [ARCHIVED] });
    const hasStaffRole = vi.fn(async () => ({
      allowed: false,
      secondFactorRequired: true as const,
    }));

    await expect(
      restoreCommunityPlace(
        { ...h.deps, authz: { hasStaffRole } },
        ADMIN_INPUT,
      ),
    ).rejects.toMatchObject({
      // The staff gate's code is rbac's to choose (STAFF_ONLY today; a
      // second-factor change makes it SECOND_FACTOR_REQUIRED). This test
      // pins only that the refusal comes before any read or write.
      code: expect.stringMatching(/^(STAFF_ONLY|SECOND_FACTOR_REQUIRED)$/),
    });
    expect(h.mocks.tx).not.toHaveBeenCalled();
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
  });
});

describe("restoreCommunityPlace — the write", () => {
  it("sets ACTIVE and keeps every other column, address included", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED],
    });

    const result = await restoreCommunityPlace(h.deps, BASE_INPUT);

    expect(result).toMatchObject({
      placeId: EXISTING_PLACE_ID,
      name: ARCHIVED.name,
      formattedAddress: ARCHIVED.formattedAddress,
      status: "ACTIVE",
    });
    expect(h.mocks.placesRepo.setStatus).toHaveBeenCalledWith({
      placeId: EXISTING_PLACE_ID,
      status: "ACTIVE",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(h.rows.get(EXISTING_PLACE_ID)).toEqual({ ...ARCHIVED, status: "ACTIVE" });
  });

  it("audits as the moderator, marks for reindex, and puts the place back in search", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED], withSearch: true,
    });

    await restoreCommunityPlace(h.deps, BASE_INPUT);

    expect(
      auditRows(h.mocks.auditRepo.log).find(
        (r) => r.action === "place.community_restored",
      )!.data,
    ).toMatchObject({ actorHumanId: MODERATOR_ID, from: "ARCHIVED", to: "ACTIVE" });
    expect(h.mocks.markSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(h.search!.upsertDocuments).toHaveBeenCalledWith({
        documents: [
          expect.objectContaining({ type: "place", placeId: EXISTING_PLACE_ID }),
        ],
      }),
    );
  });

  it("takes the locks in order: name, claim, then the place-location lock EXCLUSIVE, before the write", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED],
    });

    await restoreCommunityPlace(h.deps, BASE_INPUT);

    const nameLock = h.order.indexOf("lockPlaceName:corner bar south");
    const claimLock = h.order.indexOf(`lockPlaceForClaim:${EXISTING_PLACE_ID}`);
    expect(nameLock).toBeGreaterThanOrEqual(0);
    expect(claimLock).toBeGreaterThan(nameLock);
    expect(h.order.slice(claimLock)).toEqual([
      `lockPlaceForClaim:${EXISTING_PLACE_ID}`,
      "lockLocationsAtPlace:exclusive",
      "setStatus:ACTIVE",
    ]);
  });

  it("replays the same clientKey after success (the place is ACTIVE by then)", async () => {
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [ARCHIVED],
    });

    const first = await restoreCommunityPlace(h.deps, BASE_INPUT);
    const second = await restoreCommunityPlace(h.deps, BASE_INPUT);

    expect(second).toEqual(first);
    expect(h.mocks.placesRepo.setStatus).toHaveBeenCalledTimes(1);
  });

  it("archive then restore round-trips the row", async () => {
    const active = { ...ARCHIVED, status: "ACTIVE" as const };
    const h = buildHarness({
      auditSeed: MOD_ARCHIVED,
      places: [active],
    });

    await archiveCommunityPlace(h.deps, { ...BASE_INPUT, clientKey: "archive-key-1" });
    await restoreCommunityPlace(h.deps, BASE_INPUT);

    expect(h.rows.get(EXISTING_PLACE_ID)).toEqual(active);
  });
});
