import { describe, expect, it } from "vitest";

import { icuArgumentNames } from "@th/locale";

import enMessages from "../messages/en";
import esMessages from "../messages/es";

/**
 * FR-009 (admin-search-parity): the spotlight overlay's entity-pill labels,
 * facet labels and group headers moved out of hardcoded English literals and
 * into the catalogs. A missing key renders the RAW key string in this app, so
 * an es-locale admin would read "spotlight.statusDraft" on a pill.
 *
 * This pins the two catalogs to the same `spotlight.*` key set with non-empty
 * values on both sides — the failure mode is silent otherwise, and this file
 * is the cheap durable check.
 *
 * (The `@th/locale` base catalog carries only a 13-key spotlight subset and
 * has done since `adminPlaceholder`/`surprise` shipped; the overlay always
 * renders under the app's locale provider, so the app catalog is the operative
 * one. Deliberately not asserted here.)
 */
function flatten(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, `${prefix}.${k}`),
  );
}

const enSpotlight = (enMessages as Record<string, unknown>).spotlight;
const esSpotlight = (esMessages as Record<string, unknown>).spotlight;

describe("spotlight catalog parity", () => {
  it("en and es carry an identical spotlight.* key set", () => {
    expect(flatten(esSpotlight, "spotlight").sort()).toEqual(
      flatten(enSpotlight, "spotlight").sort(),
    );
  });

  it.each(["en", "es"] as const)("%s has no empty spotlight value", (locale) => {
    const block = (locale === "en" ? enSpotlight : esSpotlight) as Record<
      string,
      string
    >;
    for (const [key, value] of Object.entries(block)) {
      expect(typeof value, `spotlight.${key}`).toBe("string");
      expect(value.trim().length, `spotlight.${key}`).toBeGreaterThan(0);
    }
  });

  it("keeps the same ICU arguments on both sides", () => {
    const en = enSpotlight as Record<string, string>;
    const es = esSpotlight as Record<string, string>;
    for (const key of Object.keys(en)) {
      expect(icuArgumentNames(es[key]!), `spotlight.${key}`).toEqual(
        icuArgumentNames(en[key]!),
      );
    }
  });
});
