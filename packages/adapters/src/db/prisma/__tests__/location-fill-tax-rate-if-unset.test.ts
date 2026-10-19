import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import { makeSavedLocationsRepo } from "../saved-locations";

// `fillTaxRateIfUnset` on Place / SavedLocation — the checkout's after-commit
// rate-cache write. The WHERE is the behaviour: only an EMPTY cache, and only
// while the row still has the postal code / country the lookup was made for,
// so an address edited between the checkout's lookup and its write keeps the
// new address's rate (or stays empty) instead of getting the old one back.

const ID = "22222222-2222-4222-8222-222222222222";
const FETCHED_AT = new Date("2026-09-30T10:00:00.000Z");
const input = {
  id: ID,
  expectedPostalCode: "94103",
  expectedCountryCode: "US",
  admissionTaxRateBps: 863,
  taxRateSource: "ziptax",
  taxRateFetchedAt: FETCHED_AT,
};
const data = {
  admissionTaxRateBps: 863,
  taxRateSource: "ziptax",
  taxRateFetchedAt: FETCHED_AT,
};

describe("PlacesRepo.fillTaxRateIfUnset", () => {
  const repoWith = (count: number) => {
    const updateMany = vi.fn(async () => ({ count }));
    const update = vi.fn();
    const repo = makePlacesRepo({ place: { updateMany, update } } as never);
    return { repo, updateMany, update };
  };

  it("writes only WHERE the cache IS NULL and the row is still at the looked-up postcode / country", async () => {
    const { repo, updateMany, update } = repoWith(1);
    await expect(repo.fillTaxRateIfUnset(input)).resolves.toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        admissionTaxRateBps: null,
        postcode: "94103",
        country: "US",
      },
      data,
    });
  });

  it("reports a skipped write (cache filled or address moved) as false", async () => {
    await expect(repoWith(0).repo.fillTaxRateIfUnset(input)).resolves.toBe(
      false,
    );
  });
});

describe("SavedLocationsRepo.fillTaxRateIfUnset", () => {
  const repoWith = (count: number) => {
    const updateMany = vi.fn(async () => ({ count }));
    const update = vi.fn();
    const repo = makeSavedLocationsRepo({
      savedLocation: { updateMany, update },
    } as never);
    return { repo, updateMany, update };
  };

  it("writes only WHERE the cache IS NULL and the row is still at the looked-up postal code / country", async () => {
    const { repo, updateMany, update } = repoWith(1);
    await expect(repo.fillTaxRateIfUnset(input)).resolves.toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        admissionTaxRateBps: null,
        postalCode: "94103",
        countryCode: "US",
      },
      data,
    });
  });

  it("reports a skipped write as false", async () => {
    await expect(repoWith(0).repo.fillTaxRateIfUnset(input)).resolves.toBe(
      false,
    );
  });
});
