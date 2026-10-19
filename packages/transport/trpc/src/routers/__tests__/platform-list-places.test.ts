import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PLACE_ID = "44444444-4444-4444-8444-444444444444";

const placeRecord = (id: string, status: string) => ({
  id,
  name: `Place ${id.slice(0, 4)}`,
  slug: null,
  formattedAddress: "1 Main St",
  city: "Nashville",
  region: "TN",
  countryCode: "US",
  capacity: null,
  status,
  verificationStatus: "UNVERIFIED",
  listedInDirectory: true,
  orgIdsWithAccess: [],
  humanIdsWithAccess: [],
});

/**
 * `platform.listPlaces` through the REAL use case: the /platform/places
 * status chips send `status` (Active = ACTIVE+SUSPENDED, Archived = ARCHIVED,
 * All = omitted), and each row carries the place's public page path.
 */
function setup() {
  const listAll = vi.fn(async () => ({
    items: [placeRecord(PLACE_ID, "ACTIVE"), placeRecord(OTHER_PLACE_ID, "ARCHIVED")],
    pageInfo: { total: 2, limit: 25, offset: 0, hasMore: false },
  }));
  const getByOwners = vi.fn(async () => [
    { ownerType: "PLACE", ownerId: PLACE_ID, slug: "corner-bar", visibility: "PUBLIC" },
  ]);
  const hasStaffRole = vi.fn(async () => ({ allowed: true }));
  const { caller } = createCaller(
    { listPlaces: platformRouter.listPlaces },
    {
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as never,
      repos: {
        places: { listAll },
        entityPages: { getByOwners },
        // The staff second-factor probe: an enrolled admin.
        humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
      } as never,
    },
  );
  return { caller, listAll, getByOwners };
}

describe("platform.listPlaces", () => {
  it.each([
    ["Active", ["ACTIVE", "SUSPENDED"]],
    ["Archived", ["ARCHIVED"]],
  ])("passes the %s chip's status filter through to the repo", async (_chip, status) => {
    const { caller, listAll } = setup();

    await caller.listPlaces({ status });

    expect(listAll).toHaveBeenCalledWith(expect.objectContaining({ status }));
  });

  it("All: no status reaches the repo", async () => {
    const { caller, listAll } = setup();

    await caller.listPlaces({});

    expect(listAll).toHaveBeenCalledTimes(1);
    expect((listAll.mock.calls[0] as unknown[])[0]).toMatchObject({
      status: undefined,
    });
  });

  it("rejects an unknown status value", async () => {
    const { caller, listAll } = setup();

    await expect(caller.listPlaces({ status: ["DELETED"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(listAll).not.toHaveBeenCalled();
  });

  it("passes the exact id filter through to the repo", async () => {
    const { caller, listAll } = setup();

    await caller.listPlaces({ placeIds: [OTHER_PLACE_ID], limit: 1 });

    expect(listAll).toHaveBeenCalledWith(
      expect.objectContaining({ placeIds: [OTHER_PLACE_ID], status: undefined }),
    );
  });

  it("rejects a non-uuid id filter", async () => {
    const { caller, listAll } = setup();

    await expect(caller.listPlaces({ placeIds: ["nope"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(listAll).not.toHaveBeenCalled();
  });

  it("each row carries publicPath: the page's /places/ path, or null with no page", async () => {
    const { caller, getByOwners } = setup();

    const result = await caller.listPlaces({});

    expect(
      result.places.map((p: { placeId: string; publicPath: string | null }) => [
        p.placeId,
        p.publicPath,
      ]),
    ).toEqual([
      [PLACE_ID, "/places/corner-bar"],
      [OTHER_PLACE_ID, null],
    ]);
    expect(getByOwners).toHaveBeenCalledTimes(1);
    expect(getByOwners).toHaveBeenCalledWith("PLACE", [PLACE_ID, OTHER_PLACE_ID]);
  });
});
