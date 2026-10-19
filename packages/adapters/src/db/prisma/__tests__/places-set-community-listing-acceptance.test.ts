import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

// `places.setCommunityListingAcceptance` (the owner's community-listing
// consent switch, and the FR-006 reset in `reviewPlaceVerification`): ONE
// column, as a compare-and-set, so a flip never writes back a name, address,
// phone, website or websiteSource read earlier, and `changed` reports whether
// THIS call moved it. `requireVerified` adds `verification = VERIFIED` to the
// guard, so an enable cannot land on a place that lost its verification.

const PLACE_ID = "place-1";

function repoWith(count: number) {
  const updateMany = vi.fn(async () => ({ count }));
  const p = { place: { updateMany } } as unknown as PrismaClientOrTx;
  return { repo: makePlacesRepo(p), updateMany };
}

describe("makePlacesRepo.setCommunityListingAcceptance", () => {
  for (const accepts of [true, false]) {
    it(`CAS accepts=${accepts}: writes only that column, only while the row holds ${!accepts}`, async () => {
      const { repo, updateMany } = repoWith(1);

      const out = await repo.setCommunityListingAcceptance({
        placeId: PLACE_ID,
        accepts,
      });

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: PLACE_ID, acceptsCommunityListings: !accepts },
        data: { acceptsCommunityListings: accepts },
      });
      expect(out).toEqual({ changed: true });
    });
  }

  it("requireVerified adds verification = VERIFIED to the guard", async () => {
    const { repo, updateMany } = repoWith(1);

    await repo.setCommunityListingAcceptance({
      placeId: PLACE_ID,
      accepts: true,
      requireVerified: true,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: PLACE_ID,
        acceptsCommunityListings: false,
        verification: "VERIFIED",
      },
      data: { acceptsCommunityListings: true },
    });
  });

  it("requireVerified: false adds no verification guard", async () => {
    const { repo, updateMany } = repoWith(1);

    await repo.setCommunityListingAcceptance({
      placeId: PLACE_ID,
      accepts: false,
      requireVerified: false,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: PLACE_ID, acceptsCommunityListings: true },
      data: { acceptsCommunityListings: false },
    });
  });

  it("reports changed:false when no row matched", async () => {
    const { repo } = repoWith(0);

    const out = await repo.setCommunityListingAcceptance({
      placeId: PLACE_ID,
      accepts: true,
      requireVerified: true,
    });

    expect(out).toEqual({ changed: false });
  });
});
