import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTranslator, flattenCatalog, icuArgumentNames } from "@th/locale";
import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

/**
 * The seat price screen's copy, checked against the code that asks for it.
 *
 * A missing key renders as the raw key string and throws nothing, and a
 * message handed the wrong argument throws only when that one state renders.
 * The whole-catalog parity test compares en with es; it cannot see a key the
 * CODE uses that neither catalog has. This test reads the keys out of the
 * source and formats every one of them, in both locales, both plural forms.
 */

const PREFIX = "admin.seatPrices";
const componentsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  ...readdirSync(componentsDir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(componentsDir, name)),
  join(componentsDir, "..", "page.tsx"),
];

const usedKeys = [
  ...new Set(
    sourceFiles.flatMap(
      (file) => readFileSync(file, "utf8").match(/admin\.seatPrices[A-Za-z]+/g) ?? [],
    ),
  ),
].sort();

const catalogs = {
  en: { flat: flattenCatalog(enMessages), t: createTranslator("en", enMessages as never).t },
  es: { flat: flattenCatalog(esMessages), t: createTranslator("es", esMessages as never).t },
} as const;

/** Every argument any seat price message takes, so each one can be formatted. */
const values = (count: number) => ({
  count,
  price: "$60.00",
  zero: "$0.00",
  min: "$30.00",
  max: "$90.00",
  section: "Orchestra",
  row: "Row A",
  rows: "A, B",
  seat: "A4",
  symbol: "$",
  ticketType: "Standard",
  ticketTypes: "Community",
  types: 3,
  when: "Oct 24 at 10:00 AM CDT",
  causes: "1 sold",
  reason: "Something went wrong.",
  notes: count,
});

describe("seat price copy", () => {
  it("found the keys in the source (guards a vacuous pass)", () => {
    expect(usedKeys.length).toBeGreaterThan(90);
    expect(usedKeys).toContain("admin.seatPricesTitle");
    expect(usedKeys).toContain("admin.seatPricesResultSkipped");
  });

  describe.each(["en", "es"] as const)("%s", (locale) => {
    const { flat, t } = catalogs[locale];

    it("has every key the code asks for", () => {
      expect(usedKeys.filter((key) => !(key in flat))).toEqual([]);
    });

    it("has no seat price key the code never asks for", () => {
      const defined = Object.keys(flat).filter((key) => key.startsWith(PREFIX));
      expect(defined.filter((key) => !usedKeys.includes(key))).toEqual([]);
    });

    it.each([1, 2])("formats every message for a count of %i", (count) => {
      for (const key of usedKeys) {
        const text = String(t(key, values(count)));
        expect(text, key).not.toBe(key);
        expect(text.trim(), key).not.toBe("");
        // A brace left in the output is an argument the message could not fill.
        expect(text, key).not.toMatch(/[{}]/);
      }
    });
  });

  it("takes the same arguments in en and es, key by key", () => {
    // Every value is handed to every key above, so an es message that
    // dropped {price} would still format. This compares the argument sets.
    const drift = usedKeys.flatMap((key) => {
      const enArgs = [...icuArgumentNames(String(catalogs.en.flat[key]))].sort();
      const esArgs = [...icuArgumentNames(String(catalogs.es.flat[key]))].sort();
      return enArgs.join(",") === esArgs.join(",")
        ? []
        : [`${key}: en(${enArgs.join(",")}) es(${esArgs.join(",")})`];
    });
    expect(drift).toEqual([]);
  });

  it("gives the bar's button a name of its own that starts with its visible words", () => {
    for (const locale of ["en", "es"] as const) {
      const { t } = catalogs[locale];
      const visible = String(t("admin.seatPricesSetPrice"));
      const name = String(t("admin.seatPricesOpenPanelAria", { count: 2 }));
      expect(name).not.toBe(visible);
      expect(name.toLowerCase().startsWith(visible.toLowerCase())).toBe(true);
    }
  });

  it("uses the glossary's words (CONTEXT.md), never the code's", () => {
    const banned = /override|\btiers?\b|sliding scale|—/i;
    const offenders = usedKeys.filter((key) =>
      banned.test(String(catalogs.en.flat[key])),
    );
    expect(offenders).toEqual([]);
  });

  it("names the private note with one key, and says who can read it", () => {
    expect(String(catalogs.en.t("admin.seatPricesNoteLabel"))).toBe("Note");
    expect(String(catalogs.en.t("admin.seatPricesNoteHint"))).toBe(
      "Buyers never see the note. Anyone who can edit this event does.",
    );
    const noteLabels = usedKeys.filter((key) => /Note(Label|Title|Head)/.test(key));
    expect(noteLabels).toEqual(["admin.seatPricesNoteLabel"]);
  });
});
