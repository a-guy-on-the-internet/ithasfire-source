import { describe, expect, it } from "vitest";

import { flattenCatalog, icuArgumentNames } from "@th/locale";
import { platformBookingStandardKeys } from "@th/core/use-cases/booking-standards/platform-defaults";

import enMessages from "../messages/en";
import esMessages from "../messages/es";

/**
 * The platform booking standards (venue-booking-standards spec, FR-002 /
 * NFR-002) are i18n KEYS in core — `platform-defaults.ts` — and COPY here.
 * A key renamed on one side renders as the raw key string on the request
 * form ("bookingStandards.platform.perform.linkMusic.label"), and nothing
 * throws. This pins every key core references to a non-empty string in both
 * catalogs.
 *
 * The copy is rendered with no values, so it must stay argument-free — an
 * ICU argument would throw inside IntlMessageFormat on render.
 */
const en = flattenCatalog(enMessages) as Record<string, unknown>;
const es = flattenCatalog(esMessages) as Record<string, unknown>;

describe("booking standards platform copy", () => {
  const keys = platformBookingStandardKeys();

  it("core references a non-trivial set of keys (guards a vacuous pass)", () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  it.each(keys)("%s exists, non-empty and argument-free in en and es", (key) => {
    for (const [name, catalog] of [
      ["en", en],
      ["es", es],
    ] as const) {
      const value = catalog[key];
      expect(typeof value, `${name}: ${key}`).toBe("string");
      expect((value as string).trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      expect(icuArgumentNames(value as string), `${name}: ${key}`).toEqual([]);
    }
  });
});
