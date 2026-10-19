import { describe, expect, it } from "vitest";

import { flattenCatalog, icuArgumentNames } from "@th/locale";

import enMessages from "../messages/en";
import esMessages from "../messages/es";

/**
 * WHOLE-CATALOG drift guard for the LIVE app catalogs
 * (`apps/web/src/i18n/messages/{en,es}.ts`).
 *
 * The three gates beside this one — `spotlight-catalog-parity`,
 * `pagination-label-parity`, `error-code-parity` — each pin a hand-picked
 * BLOCK. That is how this drift was found and it is not how it should be
 * caught: a block gate only ever guards the block someone already thought
 * about. Seventeen argument mismatches and three key-set drifts were live
 * across the two catalog systems while all three block gates were green.
 *
 * Two failure modes, both silent:
 *   1. A key present in one locale only. This app renders the RAW KEY string
 *      when a lookup misses, so an es user reads "spotlight.statusDraft" on a
 *      pill. Nothing throws.
 *   2. An ICU argument renamed on one side only. `createTranslator` passes the
 *      message to `IntlMessageFormat` with the call site's values, and
 *      IntlMessageFormat THROWS on an argument it was not given — so this one
 *      takes out the render in exactly one locale.
 *
 * Argument extraction goes through {@link icuArgumentNames} (`@th/locale`) — a
 * recursive ICU parser, never a `/\{(\w+)\}/g` regex. The regex was wrong in
 * BOTH directions: it read plural sub-message TEXT as an argument (failing
 * parity on CORRECT translations, since branch text is *supposed* to differ per
 * locale — `spotlight.facetsToggle` is exactly such a message and is live
 * today) and it could not see an argument nested inside a plural branch, so a
 * one-sided rename passed clean. The scanner's own gate lives with it, at
 * `packages/locale/src/__tests__/icu-arguments.test.ts`.
 *
 * The block gates are kept, not folded into this one: each carries rationale
 * this file does not restate, and `error-code-parity` in particular asserts a
 * STRICTLY STRONGER rule for its block — no `errors.*` message may reference
 * ANY argument, in either locale. A parity assert would be vacuous there
 * ([] vs []) and would still pass if someone interpolated BOTH locales, which
 * is the actual defect.
 */
const en = flattenCatalog(enMessages);
const es = flattenCatalog(esMessages);

/** `["a", "b"]` → `a, b`; `[]` → `(none)`. Keeps failure output readable. */
const fmtArgs = (args: string[]): string =>
  args.length ? args.join(", ") : "(none)";

describe("app catalog parity (whole catalog)", () => {
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
      `${missingInEs.length} key(s) in messages/en.ts are MISSING from messages/es.ts — es renders the raw key for these`,
    ).toEqual([]);
  });

  it("every es key exists in en", () => {
    const missingInEn = Object.keys(es)
      .filter((key) => !(key in en))
      .sort();
    expect(
      missingInEn,
      `${missingInEn.length} key(s) in messages/es.ts are MISSING from messages/en.ts — en renders the raw key for these`,
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
      .filter(([, enArgs, esArgs]) => enArgs.join(" ") !== esArgs.join(" "))
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
