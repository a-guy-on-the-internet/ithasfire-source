import { describe, expect, it, vi } from "vitest";

import { resolveQuoteTaxRateBps } from "../_shared/resolve-quote-tax-rate";

/**
 * `resolveQuoteTaxRateBps` — the rate a pre-checkout quote taxes at for an
 * event whose admission-tax stamp may be NULL. It must reach every answer
 * checkout's `resolveCheckoutTax` reaches WITHOUT the tax provider, and say
 * `null` (unknown) where only the provider could answer — never a silent 0.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const SAVED_ID = "33333333-3333-4333-8333-333333333333";

const clock = { now: () => new Date("2026-06-01T00:00:00.000Z") };

type PlaceRow = {
  id: string;
  postalCode: string | null;
  countryCode: string | null;
  region: string | null;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
};

function makeRepos(
  place: PlaceRow | null = null,
  savedLocation: PlaceRow | null = null,
) {
  return {
    places: { getById: vi.fn(async () => place) },
    savedLocations: { getById: vi.fn(async () => savedLocation) },
  } as never as Parameters<typeof resolveQuoteTaxRateBps>[0]["repos"] & {
    places: { getById: ReturnType<typeof vi.fn> };
    savedLocations: { getById: ReturnType<typeof vi.fn> };
  };
}

const baseEvent = {
  id: EVENT_ID,
  admissionTaxRateBps: null as number | null | undefined,
  instructionalAdmission: false as boolean | null,
  placeId: null as string | null,
  savedLocationId: null as string | null,
  postalCode: null as string | null,
  countryCode: null as string | null,
  region: null as string | null,
};

/**
 * The caller's `resolveEventTaxSitus` result. Only the stamped path reads it
 * (for the TN instruction-only exemption); the unstamped path exempts against
 * the situs the cache read resolves, exactly as checkout does.
 */
const SITUS = { countryCode: "US", region: "TN", postalCode: "37203" };
const MIAMI_SITUS = { countryCode: "US", region: "FL", postalCode: "33139" };

const nashvillePlace = (cached: number | null): PlaceRow => ({
  id: PLACE_ID,
  postalCode: "37203",
  countryCode: "US",
  region: "TN",
  admissionTaxRateBps: cached,
  taxRateSource: cached == null ? null : "ziptax",
});

describe("resolveQuoteTaxRateBps", () => {
  it("a stamped event returns the stamp untouched, with no location read", async () => {
    const repos = makeRepos(nashvillePlace(500));
    const rate = await resolveQuoteTaxRateBps(
      { repos, clock },
      { ...baseEvent, admissionTaxRateBps: 975, placeId: PLACE_ID },
      SITUS,
    );
    expect(rate).toBe(975);
    expect(repos.places.getById).not.toHaveBeenCalled();
  });

  it("a stamped 0 is a known 0, not unknown", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(), clock },
      { ...baseEvent, admissionTaxRateBps: 0, placeId: PLACE_ID },
      SITUS,
    );
    expect(rate).toBe(0);
  });

  it("NULL stamp + the venue's cached rate → that rate (what checkout charges)", async () => {
    const repos = makeRepos(nashvillePlace(975));
    const rate = await resolveQuoteTaxRateBps(
      { repos, clock },
      { ...baseEvent, placeId: PLACE_ID },
      SITUS,
    );
    expect(rate).toBe(975);
  });

  it("an UNDEFINED stamp is treated like NULL", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(nashvillePlace(975)), clock },
      { ...baseEvent, admissionTaxRateBps: undefined, placeId: PLACE_ID },
      SITUS,
    );
    expect(rate).toBe(975);
  });

  it("NULL stamp + a saved location's cached rate → that rate", async () => {
    const repos = makeRepos(null, { ...nashvillePlace(700), id: SAVED_ID });
    const rate = await resolveQuoteTaxRateBps(
      { repos, clock },
      { ...baseEvent, savedLocationId: SAVED_ID },
      SITUS,
    );
    expect(rate).toBe(700);
  });

  it("NULL stamp + no cached rate → null (only the provider could answer)", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(nashvillePlace(null)), clock },
      { ...baseEvent, placeId: PLACE_ID },
      SITUS,
    );
    expect(rate).toBeNull();
  });

  it("NULL stamp + an inline US address → null (no cache to read)", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(), clock },
      { ...baseEvent, postalCode: "33139", countryCode: "US", region: "FL" },
      SITUS,
    );
    expect(rate).toBeNull();
  });

  it("NULL stamp + a venue row that no longer exists → null", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(null), clock },
      { ...baseEvent, placeId: PLACE_ID },
      SITUS,
    );
    expect(rate).toBeNull();
  });

  it("NULL stamp + no location at all → 0 (checkout charges 0 too)", async () => {
    const repos = makeRepos();
    const rate = await resolveQuoteTaxRateBps({ repos, clock }, baseEvent, null);
    expect(rate).toBe(0);
    expect(repos.places.getById).not.toHaveBeenCalled();
  });

  it("NULL stamp + a supported Canadian province → the static table rate", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(), clock },
      { ...baseEvent, postalCode: "T5J 0N3", countryCode: "CA", region: "AB" },
      SITUS,
    );
    expect(rate).toBe(500);
  });

  it("NULL stamp + an unsupported Canadian province → null", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(), clock },
      { ...baseEvent, postalCode: "M5V 2T6", countryCode: "CA", region: "ON" },
      SITUS,
    );
    expect(rate).toBeNull();
  });

  it("applies the TN instruction-only exemption to a cached rate, as checkout does", async () => {
    const rate = await resolveQuoteTaxRateBps(
      { repos: makeRepos(nashvillePlace(975)), clock },
      { ...baseEvent, placeId: PLACE_ID, instructionalAdmission: true },
      SITUS,
    );
    expect(rate).toBe(0);
  });

  it("a repo fault THROWS — never read as 'rate unknown'", async () => {
    const repos = makeRepos();
    repos.places.getById.mockRejectedValue(new Error("db down"));
    await expect(
      resolveQuoteTaxRateBps(
        { repos, clock },
        { ...baseEvent, placeId: PLACE_ID },
        SITUS,
      ),
    ).rejects.toThrow("db down");
  });

  describe("TN instruction-only exemption on a STAMPED rate (checkout's fast path)", () => {
    const stampedInstructional = {
      ...baseEvent,
      admissionTaxRateBps: 975,
      placeId: PLACE_ID,
      instructionalAdmission: true,
    };

    it("a stale non-zero TN stamp quotes 0, as checkout charges", async () => {
      const repos = makeRepos(nashvillePlace(975));
      const rate = await resolveQuoteTaxRateBps(
        { repos, clock },
        stampedInstructional,
        SITUS,
      );
      expect(rate).toBe(0);
      // The caller's situs is used — no extra venue read.
      expect(repos.places.getById).not.toHaveBeenCalled();
    });

    it("outside TN the stamp stands", async () => {
      const rate = await resolveQuoteTaxRateBps(
        { repos: makeRepos(), clock },
        stampedInstructional,
        MIAMI_SITUS,
      );
      expect(rate).toBe(975);
    });

    it("with the flag off the TN stamp stands", async () => {
      const rate = await resolveQuoteTaxRateBps(
        { repos: makeRepos(), clock },
        { ...stampedInstructional, instructionalAdmission: false },
        SITUS,
      );
      expect(rate).toBe(975);
    });

    it("no situs (no location) → the stamp stands", async () => {
      const rate = await resolveQuoteTaxRateBps(
        { repos: makeRepos(), clock },
        stampedInstructional,
        null,
      );
      expect(rate).toBe(975);
    });
  });
});
