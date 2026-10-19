import { describe, expect, it } from "vitest";

import {
  createTranslator,
  flattenCatalog,
  icuArgumentNames,
  type MessageCatalog,
} from "@th/locale";

import enMessages from "../../i18n/messages/en";
import esMessages from "../../i18n/messages/es";
import {
  CREATE_CLAIM_ERROR_KEYS,
  REVIEW_CLAIM_ERROR_KEYS,
  RESALE_CLAIM_WINDOW_DAYS,
  claimResolutionKey,
} from "../resale-claims";

/**
 * The claim screens' copy, formatted through the REAL translator with the
 * REAL catalogs. `IntlMessageFormat` throws on an argument it was not given,
 * so a `t("resaleClaim.errorWindowExpired")` without `{days}` takes the whole
 * page down: exactly the bug the closed-window notice shipped with.
 */

const LOCALES: Array<[string, MessageCatalog]> = [
  ["en", enMessages as unknown as MessageCatalog],
  ["es", esMessages as unknown as MessageCatalog],
];

/** A plausible value for every argument name the claim block uses. */
const SAMPLE_VALUES: Record<string, string | number> = {
  days: 3,
  date: "6 Oct 2026",
  code: "TKT-1234",
  claim: "Wrong seat 3f2a9c1d",
  kind: "Wrong seat",
  id: "3f2a9c1d",
};

describe.each(LOCALES)("resaleClaim copy (%s)", (locale, messages) => {
  const { t } = createTranslator(locale, messages);
  const flat = flattenCatalog(messages);
  const claimKeys = Object.keys(flat).filter((key) =>
    key.startsWith("resaleClaim."),
  );

  it("formats the closed-window notice the buyer sees", () => {
    const title = t("resaleClaim.closedTitle");
    expect(title).not.toBe("resaleClaim.closedTitle");

    for (const days of [1, RESALE_CLAIM_WINDOW_DAYS]) {
      const body = t("resaleClaim.errorWindowExpired", { days });
      expect(body).not.toBe("resaleClaim.errorWindowExpired");
      expect(body).toContain(String(days));
    }
  });

  it("throws when errorWindowExpired is called without {days} (the gate is real)", () => {
    expect(() => t("resaleClaim.errorWindowExpired")).toThrow();
  });

  it("formats every resaleClaim message when given its arguments", () => {
    expect(claimKeys.length).toBeGreaterThan(50);
    for (const key of claimKeys) {
      const names = icuArgumentNames(flat[key]!);
      const values = Object.fromEntries(
        [...names].map((name) => {
          expect(SAMPLE_VALUES, `${key} uses {${name}}`).toHaveProperty(name);
          return [name, SAMPLE_VALUES[name]!];
        }),
      );
      expect(() => t(key, values), key).not.toThrow();
    }
  });

  it("keeps map-routed keys argument-free (callers pass no values)", () => {
    const routed = [
      // FileClaim passes `{days}` to every create error, so only these
      // may use it, and nothing else.
      ...Object.values(CREATE_CLAIM_ERROR_KEYS).map((key) => ({
        key,
        allowed: ["days"],
      })),
      ...Object.values(REVIEW_CLAIM_ERROR_KEYS).map((key) => ({
        key,
        allowed: [] as string[],
      })),
      ...(
        [
          { status: "approved", refundConfirmed: true },
          { status: "approved", refundConfirmed: false },
          { status: "denied", refundConfirmed: false },
          { status: "expired", refundConfirmed: false },
        ] as const
      ).map((claim) => ({
        key: claimResolutionKey(claim)!,
        allowed: [] as string[],
      })),
    ];

    for (const { key, allowed } of routed) {
      expect(flat, key).toHaveProperty([key]);
      const names = [...icuArgumentNames(flat[key]!)];
      expect(
        names.filter((name) => !allowed.includes(name)),
        key,
      ).toEqual([]);
    }
  });
});
