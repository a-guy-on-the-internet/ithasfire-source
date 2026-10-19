import { describe, expect, it } from "vitest";

import { icuArgumentNames } from "@th/locale";
import baseEn from "@th/locale/messages/en.json";
import baseEs from "@th/locale/messages/es.json";

import enMessages from "../messages/en";
import esMessages from "../messages/es";

/**
 * `Pagination` (src/components/AdminTableParts.tsx) is reused by SELLER-facing
 * pages — /sell/listings, /sell/claims, /sell/payouts — not just admin chrome.
 * Its "rows X–Y of Z" range label was a hardcoded English literal, which is a
 * Spanish regression on those surfaces (the same class of bug NoResults' own
 * `clearLabel` comment already calls out).
 *
 * This pins the label's keys as present-and-interpolated in BOTH catalogs, so
 * adding `total` to a pager can never reintroduce untranslated copy.
 */
const PAGER_KEYS = [
  "atRowsRange",
  "atPageOf",
  "atRowsPerPage",
  "atPrevious",
  "atNext",
] as const;

const LOCALES = [
  { name: "en", admin: enMessages.admin as Record<string, string> },
  { name: "es", admin: esMessages.admin as Record<string, string> },
] as const;

describe("pagination label i18n parity", () => {
  for (const { name, admin } of LOCALES) {
    it.each(PAGER_KEYS)(`${name} defines admin.%s`, (key) => {
      expect(admin).toHaveProperty(key);
      expect(typeof admin[key]).toBe("string");
      expect(admin[key]!.trim().length).toBeGreaterThan(0);
    });

    it(`${name}'s admin.atRowsRange interpolates start, end and total`, () => {
      const value = admin.atRowsRange!;
      expect(value).toContain("{start}");
      expect(value).toContain("{end}");
      expect(value).toContain("{total}");
    });
  }

  /**
   * Argument parity across EVERY pager key, via the shared recursive scanner
   * ({@link icuArgumentNames}) rather than a local `/\{(\w+)\}/g` match.
   *
   * The flat regex was blind to two things a pager label plausibly grows:
   * a typed argument (`{total, number}` — matched nothing) and an argument
   * nested inside a plural branch (`{total, plural, other {# of {pages}}}` —
   * `pages` invisible, so a one-sided rename passed clean). See the helper's
   * doc comment for the full both-directions failure story.
   */
  it.each(PAGER_KEYS)(
    "keeps the same ICU argument set across locales for admin.%s",
    (key) => {
      const en = (enMessages.admin as Record<string, string>)[key]!;
      const es = (esMessages.admin as Record<string, string>)[key]!;
      expect(icuArgumentNames(es), `admin.${key}`).toEqual(
        icuArgumentNames(en),
      );
    },
  );

  /**
   * `@th/ui`'s fallback translator is built from `@th/locale/messages/en.json`
   * (translation-context.tsx:15), NOT from the app catalog. Every current
   * consumer sits under AppLocaleProvider so the app catalog wins the merge,
   * but a provider-less render — a story, an isolated test, or moving
   * `Pagination` into `@th/ui` — would print the raw key. Keep the base
   * catalog in sync with the app one, verbatim.
   */
  const BASE = [
    {
      name: "en",
      base: baseEn.admin as Record<string, string>,
      app: enMessages,
    },
    {
      name: "es",
      base: baseEs.admin as Record<string, string>,
      app: esMessages,
    },
  ] as const;

  for (const { name, base, app } of BASE) {
    it(`${name} base catalog (@th/locale) carries admin.atRowsRange verbatim`, () => {
      expect(base).toHaveProperty("atRowsRange");
      expect(base.atRowsRange).toBe(
        (app.admin as Record<string, string>).atRowsRange,
      );
    });
  }
});
