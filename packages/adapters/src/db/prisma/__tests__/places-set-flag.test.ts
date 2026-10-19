import { describe, expect, it, vi } from "vitest";

import type { PlaceFlag } from "@th/ports/repos/places";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

// `places.setFlag` (the owner toggles: booking acceptance, attendee reviews
// public, community reviews enabled): ONE column, as a compare-and-set, so a
// flip can never write back a name/address read earlier (or a NULL street line
// or country as ""), and `changed` reports whether THIS call moved it.

const PLACE_ID = "place-1";

const FLAGS: readonly PlaceFlag[] = [
  "acceptsBookingRequests",
  "attendeeReviewsPublic",
  "communityReviewsEnabled",
];

describe("makePlacesRepo.setFlag", () => {
  for (const flag of FLAGS) {
    for (const value of [true, false]) {
      it(`CAS ${flag}=${value}: writes only that column, only while the row holds ${!value}`, async () => {
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

        const out = await makePlacesRepo(p).setFlag({
          placeId: PLACE_ID,
          flag,
          value,
        });

        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
          where: { id: PLACE_ID, [flag]: !value },
          data: { [flag]: value },
        });
        expect(out).toEqual({ changed: true });
      });
    }
  }

  it("reports changed:false when the row already held the value", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).setFlag({
      placeId: PLACE_ID,
      flag: "attendeeReviewsPublic",
      value: true,
    });

    expect(out).toEqual({ changed: false });
  });
});
