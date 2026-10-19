import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_LOCALE,
  NOTIFICATION_LOCALES,
  resolveNotificationLocale,
} from "../locale";

/**
 * The web app's language list, read from its source. apps/web cannot be
 * imported from core (and core is not a web dependency), so the file is parsed
 * — and the parse is asserted non-empty, so a refactor of that file fails this
 * test loudly instead of letting it pass on an empty list.
 */
function readWebSupportedLocales(): string[] {
  const path = fileURLToPath(
    new URL(
      "../../../../../../apps/web/src/i18n/config.ts",
      import.meta.url,
    ),
  );
  const source = readFileSync(path, "utf8");
  const match = /SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/u.exec(source);
  if (!match) {
    throw new Error(`SUPPORTED_LOCALES not found in ${path}`);
  }
  return [...match[1]!.matchAll(/["']([^"']+)["']/gu)].map((m) => m[1]!);
}

describe("notification locales", () => {
  it("cover every language the web app offers", () => {
    const web = readWebSupportedLocales();
    expect(web.length).toBeGreaterThan(0);
    const missing = web.filter(
      (l) => !(NOTIFICATION_LOCALES as readonly string[]).includes(l),
    );
    // A new web locale needs a NOTIFICATION_LOCALES entry in comms/locale.ts;
    // the typecheck then lists every copy catalog that needs its strings.
    expect(missing).toEqual([]);
  });

  it("include the default", () => {
    expect(NOTIFICATION_LOCALES).toContain(DEFAULT_NOTIFICATION_LOCALE);
  });
});

describe("resolveNotificationLocale", () => {
  it.each([
    ["en", "en"],
    ["es", "es"],
    ["ES", "es"],
    [" es ", "es"],
    ["es-MX", "es"],
    ["es_419", "es"],
    ["en-GB", "en"],
    ["fr", "en"],
    ["", "en"],
    ["e", "en"],
    ["<script>", "en"],
  ])("%j → %s", (input, expected) => {
    expect(resolveNotificationLocale(input)).toBe(expected);
  });

  it.each([undefined, null, 42, {}, ["es"]])("non-string %j → en", (input) => {
    expect(resolveNotificationLocale(input)).toBe("en");
  });
});
