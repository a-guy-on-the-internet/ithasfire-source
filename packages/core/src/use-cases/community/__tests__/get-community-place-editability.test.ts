import { describe, expect, it, vi } from "vitest";

import { getCommunityPlaceEditability } from "../get-community-place-editability";
import {
  EXISTING_PLACE_ID,
  OTHER_PLACE_ID,
  PIN,
  buildHarness,
  makePlace,
  provisionalClaim,
  verifiedOwnership,
  type HarnessOptions,
} from "./community-place-harness";
import { ADMIN_ID, MODERATOR_ID, ORG_ID, USER_ID } from "./helpers";

/**
 * getCommunityPlaceEditability — what the moderator card asks before it
 * opens the edit dialog. Advisory: it takes no lock and writes nothing.
 */

const ACTIVE = makePlace();
const ARCHIVED = makePlace({ status: "ARCHIVED" });

const T1 = new Date("2026-06-02T12:00:00.000Z");
const T2 = new Date("2026-06-03T12:00:00.000Z");

const INPUT = { actorHumanId: MODERATOR_ID, placeId: EXISTING_PLACE_ID };

async function ask(options: HarnessOptions, input: object = INPUT) {
  const h = buildHarness(options);
  const result = await getCommunityPlaceEditability(h.deps, input);
  return { h, result };
}

describe("getCommunityPlaceEditability — who may ask", () => {
  it("refuses a non-moderator with STAFF_ONLY and reads no place", async () => {
    const h = buildHarness({ places: [ACTIVE] });

    await expect(
      getCommunityPlaceEditability(h.deps, { ...INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.mocks.placesRepo.getById).not.toHaveBeenCalled();
  });

  it("answers a platform ADMIN", async () => {
    const { result } = await ask(
      { places: [ACTIVE] },
      { ...INPUT, actorHumanId: ADMIN_ID },
    );
    expect(result.canEdit).toBe(true);
  });

  it("PLACE_NOT_FOUND for an unknown id", async () => {
    const h = buildHarness();
    await expect(getCommunityPlaceEditability(h.deps, INPUT)).rejects.toMatchObject(
      { code: "PLACE_NOT_FOUND" },
    );
  });

  it("rejects unknown input keys (strict)", async () => {
    const h = buildHarness({ places: [ACTIVE] });
    await expect(
      getCommunityPlaceEditability(h.deps, { ...INPUT, extra: 1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("getCommunityPlaceEditability — the answer", () => {
  it("an ownerless ACTIVE place with no listings: edit and archive, exactly these fields", async () => {
    const { h, result } = await ask({ places: [ACTIVE] });

    expect(result).toStrictEqual({
      placeId: EXISTING_PLACE_ID,
      status: "ACTIVE",
      canEdit: true,
      canArchive: true,
      canRestore: false,
      reason: null,
      linkedListingCount: 0,
      duplicatePlaceId: null,
      archivedByModerator: false,
      statusChangedAt: null,
    });
    // Advisory: no transaction, no lock, no write.
    expect(h.mocks.tx).not.toHaveBeenCalled();
    expect(h.mocks.placesRepo.lockPlaceForClaim).not.toHaveBeenCalled();
    expect(h.mocks.lockLocationsAtPlace).not.toHaveBeenCalled();
    expect(h.mocks.placesRepo.setStatus).not.toHaveBeenCalled();
    expect(h.mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("live listings: may edit, may not archive, the count says why", async () => {
    const { result } = await ask({
      places: [ACTIVE],
      liveListingCounts: { [EXISTING_PLACE_ID]: 2 },
    });

    expect(result).toMatchObject({
      canEdit: true,
      canArchive: false,
      canRestore: false,
      reason: null,
      linkedListingCount: 2,
    });
  });

  it.each([
    [
      "OWNED (verified ownership)",
      { verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) } },
      "OWNED",
    ],
    [
      "OWNED (an org with access)",
      { places: [makePlace({ orgIdsWithAccess: [ORG_ID] })] },
      "OWNED",
    ],
    [
      "CLAIM_PENDING (provisional claim)",
      { provisionalClaims: { [EXISTING_PLACE_ID]: provisionalClaim(EXISTING_PLACE_ID) } },
      "CLAIM_PENDING",
    ],
    [
      "CLAIM_PENDING (verificationStatus PENDING)",
      { places: [makePlace({ verificationStatus: "PENDING" })] },
      "CLAIM_PENDING",
    ],
    [
      "OWNED_EVENTS_AT_PLACE",
      { ownedEventPlaceIds: [EXISTING_PLACE_ID] },
      "OWNED_EVENTS_AT_PLACE",
    ],
  ] satisfies Array<[string, HarnessOptions, string]>)(
    "%s blocks every action",
    async (_label, options: HarnessOptions, reason) => {
    const { result } = await ask({ places: [ACTIVE], ...options });

    expect(result).toMatchObject({
      status: "ACTIVE",
      canEdit: false,
      canArchive: false,
      canRestore: false,
      reason,
    });
    },
  );

  it("an owned place answers OWNED even when ARCHIVED by a moderator", async () => {
    const { result } = await ask({
      places: [ARCHIVED],
      auditSeed: [
        { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
      ],
      verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) },
    });

    expect(result).toMatchObject({ canRestore: false, reason: "OWNED" });
  });

  it("SUSPENDED: nothing allowed, NOT_ACTIVE", async () => {
    const { result } = await ask({ places: [makePlace({ status: "SUSPENDED" })] });

    expect(result).toMatchObject({
      status: "SUSPENDED",
      canEdit: false,
      canArchive: false,
      canRestore: false,
      reason: "NOT_ACTIVE",
    });
  });

  it("ARCHIVED by a moderator: restore only, reason null", async () => {
    const { result } = await ask({
      places: [ARCHIVED],
      auditSeed: [
        { entityId: EXISTING_PLACE_ID, action: "place.community_restored", at: T1 },
        { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T2 },
      ],
    });

    expect(result).toMatchObject({
      status: "ARCHIVED",
      canEdit: false,
      canArchive: false,
      canRestore: true,
      reason: null,
      archivedByModerator: true,
    });
  });

  it.each([
    ["its owner archived it (status_updated is newest)", [
      { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
      { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T2 },
    ]],
    ["no status audit row at all", []],
    ["only a substring match (verification_status_updated)", [
      { entityId: EXISTING_PLACE_ID, action: "verification_status_updated", at: T2 },
    ]],
  ])("ARCHIVED, not by a moderator — %s: NOT_COMMUNITY_ARCHIVED", async (_label, auditSeed) => {
    const { result } = await ask({ places: [ARCHIVED], auditSeed });

    expect(result).toMatchObject({
      canRestore: false,
      reason: "NOT_COMMUNITY_ARCHIVED",
    });
  });

  it("an owner's archive stays found behind 51 newer verification_status_updated rows (the substring trap, past one page)", async () => {
    const T0 = new Date("2026-06-01T00:00:00.000Z");
    const noise = Array.from({ length: 51 }, (_, i) => ({
      entityId: EXISTING_PLACE_ID,
      action: "verification_status_updated",
      at: new Date(T2.getTime() + (i + 1) * 60_000),
    }));
    const { h, result } = await ask({
      places: [ARCHIVED],
      auditSeed: [
        { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T0 },
        { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T2 },
        ...noise,
      ],
    });

    expect(result).toMatchObject({
      canRestore: false,
      reason: "NOT_COMMUNITY_ARCHIVED",
    });
    // It paged past the first window rather than stopping at 50.
    expect(
      h.mocks.auditRepo.list.mock.calls.some(
        ([input]) => (input as { offset?: number }).offset === 50,
      ),
    ).toBe(true);
  });

  describe("an ADMIN actor (owner ruling 2026-10-14: restores what a moderator did not archive)", () => {
    const ADMIN_INPUT = { ...INPUT, actorHumanId: ADMIN_ID };
    const OWNER_ARCHIVED = [
      { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
      { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T2 },
    ];

    it.each([
      ["archived by status_updated", OWNER_ARCHIVED],
      ["no status audit row at all (a legacy archived row)", []],
    ])("ARCHIVED %s: canRestore true, reason null", async (_label, auditSeed) => {
      const { result } = await ask({ places: [ARCHIVED], auditSeed }, ADMIN_INPUT);

      expect(result).toMatchObject({
        status: "ARCHIVED",
        canEdit: false,
        canArchive: false,
        canRestore: true,
        reason: null,
        duplicatePlaceId: null,
        archivedByModerator: false,
      });
    });

    it("the same place still answers NOT_COMMUNITY_ARCHIVED to a moderator", async () => {
      const { result } = await ask({ places: [ARCHIVED], auditSeed: OWNER_ARCHIVED });

      expect(result).toMatchObject({
        canRestore: false,
        reason: "NOT_COMMUNITY_ARCHIVED",
      });
    });

    it("an admin probe that answers secondFactorRequired does not count as admin: canRestore false, NOT_COMMUNITY_ARCHIVED", async () => {
      const h = buildHarness({ places: [ARCHIVED], auditSeed: OWNER_ARCHIVED });
      const hasStaffRole = vi.fn(
        async ({ requiredRoles }: { requiredRoles: readonly string[] }) =>
          requiredRoles.length === 1 && requiredRoles[0] === "ADMIN"
            ? { allowed: false, secondFactorRequired: true as const }
            : { allowed: true },
      );

      const result = await getCommunityPlaceEditability(
        { ...h.deps, authz: { hasStaffRole } } as unknown as typeof h.deps,
        INPUT,
      );

      expect(result).toMatchObject({
        canRestore: false,
        reason: "NOT_COMMUNITY_ARCHIVED",
      });
      expect(hasStaffRole).toHaveBeenCalledWith(
        expect.objectContaining({ requiredRoles: ["ADMIN"] }),
      );
    });

    it("an owned ARCHIVED place: no restore, OWNED", async () => {
      const { result } = await ask(
        {
          places: [ARCHIVED],
          auditSeed: OWNER_ARCHIVED,
          verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) },
        },
        ADMIN_INPUT,
      );

      expect(result).toMatchObject({ canRestore: false, reason: "OWNED" });
    });

    it("an ACTIVE same-name twin at the same spot: no restore, DUPLICATE_ACTIVE", async () => {
      const twin = makePlace({ id: OTHER_PLACE_ID, status: "ACTIVE" });
      const { result } = await ask(
        { places: [ARCHIVED, twin], auditSeed: OWNER_ARCHIVED },
        ADMIN_INPUT,
      );

      expect(result).toMatchObject({
        canRestore: false,
        reason: "DUPLICATE_ACTIVE",
        duplicatePlaceId: OTHER_PLACE_ID,
      });
    });
  });

  describe("statusChangedAt", () => {
    it("is the time of the newest status row: community_archived newer than status_updated", async () => {
      const { result } = await ask({
        places: [ARCHIVED],
        auditSeed: [
          { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T1 },
          { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T2 },
        ],
      });

      expect(result).toMatchObject({
        canRestore: true,
        statusChangedAt: T2.toISOString(),
      });
    });

    it("is the time of the newest status row: status_updated newer than community_archived", async () => {
      const { result } = await ask({
        places: [ARCHIVED],
        auditSeed: [
          { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
          { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T2 },
        ],
      });

      expect(result).toMatchObject({
        canRestore: false,
        reason: "NOT_COMMUNITY_ARCHIVED",
        statusChangedAt: T2.toISOString(),
      });
    });

    it("dates an ACTIVE place by its restore row", async () => {
      const { result } = await ask({
        places: [ACTIVE],
        auditSeed: [
          { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
          { entityId: EXISTING_PLACE_ID, action: "place.community_restored", at: T2 },
        ],
      });

      expect(result.statusChangedAt).toBe(T2.toISOString());
    });

    it("ignores near-miss actions (verification_status_updated) and other places' rows", async () => {
      const { result } = await ask({
        places: [ARCHIVED],
        auditSeed: [
          { entityId: EXISTING_PLACE_ID, action: "verification_status_updated", at: T2 },
          { entityId: OTHER_PLACE_ID, action: "place.community_archived", at: T2 },
        ],
      });

      expect(result.statusChangedAt).toBeNull();
    });

    it("is null when the place has no status audit row", async () => {
      const { result } = await ask({ places: [ARCHIVED], auditSeed: [] });

      expect(result.statusChangedAt).toBeNull();
    });

    it("is still reported when the place is owned (the block does not hide it)", async () => {
      const { result } = await ask({
        places: [ARCHIVED],
        auditSeed: [
          { entityId: EXISTING_PLACE_ID, action: "status_updated", at: T1 },
        ],
        verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) },
      });

      expect(result).toMatchObject({
        reason: "OWNED",
        statusChangedAt: T1.toISOString(),
      });
    });
  });

  describe("restore's duplicate guard", () => {
    const MOD_ARCHIVED = [
      { entityId: EXISTING_PLACE_ID, action: "place.community_archived", at: T1 },
    ];
    /** About 49 m and 52 m north of PIN. */
    const NEAR = 49 / 111_195;
    const FAR = 52 / 111_195;
    const archived = makePlace({
      status: "ARCHIVED",
      formattedAddress: "2190A Nolensville Pike, Nashville, TN 37211, USA",
    });
    const twin = (latOffset: number, formattedAddress: string) =>
      makePlace({
        id: OTHER_PLACE_ID,
        status: "ACTIVE",
        lat: PIN.lat + latOffset,
        formattedAddress,
      });

    it("an ACTIVE same-name twin within 50 m: no restore, DUPLICATE_ACTIVE, the twin's id", async () => {
      const { result } = await ask({
        places: [archived, twin(NEAR, "Across the lot, Nashville")],
        auditSeed: MOD_ARCHIVED,
      });

      expect(result).toStrictEqual({
        placeId: EXISTING_PLACE_ID,
        status: "ARCHIVED",
        canEdit: false,
        canArchive: false,
        canRestore: false,
        reason: "DUPLICATE_ACTIVE",
        linkedListingCount: 0,
        duplicatePlaceId: OTHER_PLACE_ID,
        archivedByModerator: true,
        statusChangedAt: T1.toISOString(),
      });
    });

    it("an ACTIVE same-name twin at the same address text, however far: DUPLICATE_ACTIVE", async () => {
      const { result } = await ask({
        places: [archived, twin(1, archived.formattedAddress!)],
        auditSeed: MOD_ARCHIVED,
      });

      expect(result).toMatchObject({
        canRestore: false,
        reason: "DUPLICATE_ACTIVE",
        duplicatePlaceId: OTHER_PLACE_ID,
      });
    });

    it("a twin 52 m away at a different address is not a duplicate: restore allowed", async () => {
      const { result } = await ask({
        places: [archived, twin(FAR, "Across the street, Nashville")],
        auditSeed: MOD_ARCHIVED,
      });

      expect(result).toMatchObject({
        canRestore: true,
        reason: null,
        duplicatePlaceId: null,
      });
    });

    it("a twin that withholds its address is never matched (the finder excludes it)", async () => {
      const { result } = await ask({
        places: [
          archived,
          { ...twin(NEAR, "Across the lot, Nashville"), locationMode: "OBSCURED" },
        ],
        auditSeed: MOD_ARCHIVED,
      });

      expect(result).toMatchObject({ canRestore: true, duplicatePlaceId: null });
    });
  });

  it("an ACTIVE place that withholds its address: no edit (update refuses it), archive still allowed, nothing about the address returned", async () => {
    const { result } = await ask({
      places: [
        makePlace({
          locationMode: "OBSCURED",
          formattedAddress: "1 Secret Lane",
        }),
      ],
    });

    expect(result).toStrictEqual({
      placeId: EXISTING_PLACE_ID,
      status: "ACTIVE",
      canEdit: false,
      canArchive: true,
      canRestore: false,
      reason: "ADDRESS_WITHHELD",
      linkedListingCount: 0,
      duplicatePlaceId: null,
      archivedByModerator: false,
      statusChangedAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("Secret");
  });
});
