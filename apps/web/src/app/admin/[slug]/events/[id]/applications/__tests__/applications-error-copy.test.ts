/**
 * Guards the applications page's error copy.
 *
 * `listEventApplicationSubmissions` answers 409 `EVENT_NOT_APPLICATION_GATED`
 * for an event that isn't application-gated — a legitimate configuration, not
 * a crash. Every `formatErrorMessage` call on this page used to omit the
 * translator, so that code never reached the catalog and the page rendered
 * "Something went wrong. Please try again or contact support." next to a
 * Retry button that could never succeed.
 *
 * Two invariants are asserted here, because either one alone regresses
 * silently:
 *   1. The catalogs still carry `errors.eventNotApplicationGated` (en AND es).
 *   2. Every `formatErrorMessage(` call in `page.tsx` still passes a
 *      translator. A render test can't catch a dropped second argument at the
 *      four toast call sites, which only fire on a mutation failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createTranslator, type MessageCatalog } from "@th/locale";

import enPackage from "@th/locale/messages/en.json";
import esPackage from "@th/locale/messages/es.json";
import enApp from "@/i18n/messages/en";
import esApp from "@/i18n/messages/es";
import {
  __resetWarnedCodes,
  formatErrorMessage,
} from "@/lib/format-error-message";

const GENERIC = "Something went wrong. Please try again or contact support.";

const PAGE_PATH = join(
  process.cwd(),
  "src/app/admin/[slug]/events/[id]/applications/page.tsx",
);

/** Mirrors `LocaleProvider`'s merge: app keys override package keys. */
const merge = (
  base: MessageCatalog,
  override: MessageCatalog,
): MessageCatalog => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] =
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
        ? merge(existing as MessageCatalog, value as MessageCatalog)
        : value;
  }
  return out as MessageCatalog;
};

/**
 * The PRODUCTION translator, not a fake: the same `createTranslator` the
 * `TranslationProvider` builds, over the same merged catalog `LocaleProvider`
 * feeds it. Its miss semantics (unknown key resolves to the key itself) are
 * exactly what `formatErrorMessage` detects a miss with.
 */
const translatorFor = (locale: "en" | "es") =>
  createTranslator(
    locale,
    merge(
      (locale === "en" ? enPackage : esPackage) as unknown as MessageCatalog,
      (locale === "en" ? enApp : esApp) as unknown as MessageCatalog,
    ),
  ).t;

beforeEach(() => {
  __resetWarnedCodes();
});

describe("EVENT_NOT_APPLICATION_GATED resolves to real copy", () => {
  it.each(["en", "es"] as const)(
    "%s catalog carries errors.eventNotApplicationGated",
    (locale) => {
      const copy = translatorFor(locale)("errors.eventNotApplicationGated");

      expect(copy).not.toBe("errors.eventNotApplicationGated");
      expect(copy.length).toBeGreaterThan(0);
    },
  );

  it("returns the translated sentence when a translator is supplied", () => {
    const t = translatorFor("en");
    const message = formatErrorMessage(
      new Error("EVENT_NOT_APPLICATION_GATED"),
      t,
    );

    expect(message).toBe(t("errors.eventNotApplicationGated"));
    expect(message).not.toBe(GENERIC);
    // The exact string the admin now sees in the error card.
    expect(message).toBe(
      "This event doesn't use applications, so that action doesn't apply.",
    );
  });

  it("falls back to the useless generic message WITHOUT a translator", () => {
    // Documents the bug this guard exists for: the catalog is never consulted
    // when the call site drops `t`, so the fix belongs at the call site.
    expect(formatErrorMessage(new Error("EVENT_NOT_APPLICATION_GATED"))).toBe(
      GENERIC,
    );
  });
});

describe("every formatErrorMessage call on the page passes a translator", () => {
  it("finds at least one call, and none of them is single-argument", () => {
    const source = readFileSync(PAGE_PATH, "utf8");
    const calls: string[] = [];

    const needle = "formatErrorMessage(";
    let index = source.indexOf(needle);
    while (index !== -1) {
      // Walk the argument list, tracking nesting so a nested call's own
      // parens don't terminate the scan early.
      let depth = 0;
      let cursor = index + needle.length - 1;
      for (; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (char === "(") depth += 1;
        else if (char === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push(source.slice(index + needle.length, cursor));
      index = source.indexOf(needle, cursor);
    }

    expect(calls.length).toBeGreaterThan(0);

    for (const args of calls) {
      // A top-level comma = a second argument was passed.
      let depth = 0;
      let hasTopLevelComma = false;
      for (const char of args) {
        if (char === "(" || char === "[" || char === "{") depth += 1;
        else if (char === ")" || char === "]" || char === "}") depth -= 1;
        else if (char === "," && depth === 0) hasTopLevelComma = true;
      }
      expect(
        hasTopLevelComma,
        `formatErrorMessage(${args}) has no translator — pass \`t\``,
      ).toBe(true);
    }
  });
});
