import { describe, expect, test } from "vitest";

import { createZiptaxAdapter } from "../../src/tax-rate-lookup/ziptax-adapter";

const ZIPTAX_API_KEY = process.env.ZIPTAX_API_KEY ?? "";

describe.skipIf(!ZIPTAX_API_KEY)(
  "Ziptax adapter integration (requires ZIPTAX_API_KEY)",
  () => {
    const adapter = createZiptaxAdapter(ZIPTAX_API_KEY);

    test("valid US zip returns non-zero rateBps with source 'ziptax'", async () => {
      const result = await adapter.lookupByPostalCode({
        postalCode: "78701",
        countryCode: "US",
      });

      expect(result).not.toBeNull();
      expect(result!.rateBps).toBeGreaterThan(0);
      expect(result!.source).toBe("ziptax");
    }, 15_000);

    test("US zip with +4 suffix is normalized and resolved", async () => {
      const result = await adapter.lookupByPostalCode({
        postalCode: "78701-1234",
        countryCode: "US",
      });

      expect(result).not.toBeNull();
      expect(result!.rateBps).toBeGreaterThan(0);
    }, 15_000);

    test("non-US country code returns null without calling API", async () => {
      const result = await adapter.lookupByPostalCode({
        postalCode: "SW1A 1AA",
        countryCode: "GB",
      });

      expect(result).toBeNull();
    }, 5_000);

    test("invalid US zip format returns null", async () => {
      const result = await adapter.lookupByPostalCode({
        postalCode: "ABCDE",
        countryCode: "US",
      });

      expect(result).toBeNull();
    }, 5_000);
  },
);
