import { beforeAll, describe, expect, it } from "vitest";

import { icuArgumentNames } from "../icu-arguments";
import { loadMessages } from "../load-messages";
import { flattenCatalog } from "../message-resolver";

/**
 * WHOLE-CATALOG drift guard for `@th/locale`'s base catalogs
 * (`packages/locale/messages/{en,es}.json`).
 *
 * This package had NO parity gate until now. That mattered because these files
 * are not dead weight — they are the catalog behind:
 *   - `@th/ui`'s provider-less fallback translator (a component rendered
 *     outside `AppLocaleProvider` reads these, not the app catalog),
 *   - Storybook stories,
 *   - the help centre's server-side i18n.
 *
 * Two failure modes, both silent in production:
 *   1. A key present in one locale only. The resolver has no cross-locale
 *      fallback, so the es render prints the RAW KEY ("admin.atRowsRange") on
 *      screen. Nothing throws; nobody notices until a Spanish user complains.
 *   2. An ICU argument renamed on one side only. `createTranslator` hands the
 *      message to `IntlMessageFormat` with the caller's values, and
 *      IntlMessageFormat THROWS on an argument it was not given
 *      ("The intl string context variable \"total\" was not provided…").
 *      So this one is not a cosmetic bug: it takes out the render.
 *
 * Argument extraction goes through {@link icuArgumentNames} — a recursive ICU
 * parser, never a `/\{(\w+)\}/g` regex. The regex was wrong in BOTH directions:
 * it read plural sub-message TEXT as an argument (failing parity on CORRECT
 * translations, since branch text is supposed to differ per locale) and it
 * could not see an argument nested inside a plural branch (so a one-sided
 * rename passed clean). See the scanner's doc comment for the measured
 * before/after, and `icu-arguments.test.ts` for the pinned behaviour.
 *
 * Loading goes through the real {@link loadMessages}, so the gate also proves
 * both catalogs still satisfy `messageDictionarySchema`.
 */
let en: Record<string, string>;
let es: Record<string, string>;

beforeAll(async () => {
  en = flattenCatalog(await loadMessages("en"));
  es = flattenCatalog(await loadMessages("es"));
});

/** `["a", "b"]` → `a, b`; `[]` → `(none)`. Keeps failure output readable. */
const fmtArgs = (args: string[]): string =>
  args.length ? args.join(", ") : "(none)";

describe("@th/locale base catalog parity (whole catalog)", () => {
  it("both catalogs are non-empty (guards a vacuous pass)", () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
    expect(Object.keys(es).length).toBeGreaterThan(0);
  });

  it("every en key exists in es", () => {
    const missingInEs = Object.keys(en)
      .filter((key) => !(key in es))
      .sort();
    expect(
      missingInEs,
      `${missingInEs.length} key(s) in messages/en.json are MISSING from messages/es.json — es renders the raw key for these`,
    ).toEqual([]);
  });

  it("every es key exists in en", () => {
    const missingInEn = Object.keys(es)
      .filter((key) => !(key in en))
      .sort();
    expect(
      missingInEn,
      `${missingInEn.length} key(s) in messages/es.json are MISSING from messages/en.json — en renders the raw key for these`,
    ).toEqual([]);
  });

  it("every shared key references the same ICU arguments in both locales", () => {
    const mismatches = Object.keys(en)
      .filter((key) => key in es)
      .sort()
      .map(
        (key) =>
          [key, icuArgumentNames(en[key]!), icuArgumentNames(es[key]!)] as const,
      )
      .filter(([, enArgs, esArgs]) => enArgs.join("\u0000") !== esArgs.join("\u0000"))
      .map(
        ([key, enArgs, esArgs]) =>
          `${key}\n      en: ${fmtArgs(enArgs)}\n      es: ${fmtArgs(esArgs)}`,
      );

    expect(
      mismatches,
      `${mismatches.length} message(s) reference different ICU arguments across locales. ` +
        `IntlMessageFormat THROWS on an argument it was not passed, so each of these breaks the render in one locale.`,
    ).toEqual([]);
  });
});
