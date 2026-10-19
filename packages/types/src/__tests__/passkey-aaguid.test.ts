import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ABSENT_AAGUID,
  PASSKEY_AAGUID_NAMES,
  isAbsentAaguid,
  normalizeAaguid,
  passkeyAaguidLabel,
} from "../passkey-aaguid";
import { derivePasskeyName } from "../passkey-name";

/**
 * Spot-check values, each copied from the pinned upstream dataset (see the
 * header of `../passkey-aaguid-data.ts`) — NOT typed from memory. They are the
 * providers a real user is most likely to enroll with, so a refresh that drops
 * or renames one should fail loudly here rather than silently regress the
 * label to a browser guess.
 */
const KNOWN: readonly (readonly [string, string])[] = [
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "Apple Passwords"],
  ["dd4ec289-e01d-41c9-bb89-70fa845d4bf2", "iCloud Keychain (Managed)"],
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
  ["d548826e-79b4-db40-a3d8-11116f7e8349", "Bitwarden"],
  ["08987058-cadc-4b81-b6e1-30de50dcbe96", "Windows Hello"],
  ["9ddd1817-af5a-4672-a2b9-3e3dd95000a9", "Windows Hello"],
  ["6028b017-b1d4-4c02-b4b3-afcdafc96bb2", "Windows Hello"],
  ["cb69481e-8ff7-4039-93ec-0a2729a154a8", "YubiKey 5 Series"],
  ["53414d53-554e-4700-0000-000000000000", "Samsung Pass"],
];

describe("passkeyAaguidLabel", () => {
  it.each(KNOWN)("maps %s to %s", (aaguid, expected) => {
    expect(passkeyAaguidLabel(aaguid)).toBe(expected);
  });

  it("treats the all-zero AAGUID as absent", () => {
    expect(passkeyAaguidLabel(ABSENT_AAGUID)).toBeNull();
    // Same value in every spelling this module accepts.
    expect(passkeyAaguidLabel("00000000000000000000000000000000")).toBeNull();
    expect(
      passkeyAaguidLabel("{00000000-0000-0000-0000-000000000000}"),
    ).toBeNull();
  });

  it("returns null for a well-formed AAGUID that is not in the table", () => {
    // Valid shape, deliberately not a real model.
    expect(passkeyAaguidLabel("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeNull();
  });

  it("returns null for absent / malformed input rather than guessing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "not-an-aaguid",
      // One digit short.
      "fbfc3007-154e-4ecc-8c0b-6e020557d7b",
      // Non-hex digit in an otherwise correct shape.
      "fbfc3007-154e-4ecc-8c0b-6e020557d7bg",
      // Right length, wrong grouping.
      "fbfc3007154e-4ecc-8c0b-6e020557d7bd0",
    ]) {
      expect(passkeyAaguidLabel(bad as string | null | undefined)).toBeNull();
    }
  });

  it("never resolves an inherited Object property to a label", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(passkeyAaguidLabel(key)).toBeNull();
    }
  });

  it("normalises case, surrounding whitespace, braces and the dashless form", () => {
    const canonical = "bada5566-a7aa-401f-bd96-45619a55120d";
    for (const spelling of [
      canonical,
      canonical.toUpperCase(),
      `  ${canonical}  `,
      `{${canonical}}`,
      `{ ${canonical.toUpperCase()} }`,
      canonical.replace(/-/g, ""),
      canonical.replace(/-/g, "").toUpperCase(),
    ]) {
      expect(passkeyAaguidLabel(spelling)).toBe("1Password");
    }
  });
});

describe("normalizeAaguid", () => {
  it("returns the canonical dashed lowercase form", () => {
    expect(normalizeAaguid("BADA5566-A7AA-401F-BD96-45619A55120D")).toBe(
      "bada5566-a7aa-401f-bd96-45619a55120d",
    );
    expect(normalizeAaguid("bada5566a7aa401fbd9645619a55120d")).toBe(
      "bada5566-a7aa-401f-bd96-45619a55120d",
    );
  });

  it("canonicalises the all-zero AAGUID instead of rejecting it", () => {
    // Absence is a LOOKUP decision, not a parse failure — see the module doc.
    expect(normalizeAaguid("00000000000000000000000000000000")).toBe(
      ABSENT_AAGUID,
    );
    expect(isAbsentAaguid("00000000000000000000000000000000")).toBe(true);
    expect(isAbsentAaguid("bada5566-a7aa-401f-bd96-45619a55120d")).toBe(false);
    expect(isAbsentAaguid(null)).toBe(false);
  });

  it("returns null for malformed input", () => {
    expect(normalizeAaguid(undefined)).toBeNull();
    expect(normalizeAaguid("{bada5566-a7aa-401f-bd96-45619a55120d")).toBeNull();
    expect(normalizeAaguid(42 as unknown as string)).toBeNull();
  });
});

describe("PASSKEY_AAGUID_NAMES data integrity", () => {
  const entries = Object.entries(PASSKEY_AAGUID_NAMES);

  it("is non-trivially populated", () => {
    // Guards the "refresh script wrote an empty object" failure, which would
    // otherwise turn every assertion above into the only thing that fails.
    expect(entries.length).toBeGreaterThan(300);
  });

  it("has every key in canonical lowercase UUID form", () => {
    const malformed = entries
      .map(([key]) => key)
      .filter((key) => normalizeAaguid(key) !== key);
    expect(malformed).toEqual([]);
  });

  it("has no duplicate keys in the SOURCE file", () => {
    // Deliberately reads the file off disk instead of inspecting the imported
    // object. A duplicated key in an object literal is not a runtime
    // observable at all: JavaScript silently keeps the last one, so
    // `new Set(Object.keys(map)).size === Object.keys(map).length` is true by
    // construction and would be a green-by-construction gate. A generator bug
    // that emitted one AAGUID twice under two different product names would
    // pass that and quietly ship the wrong label.
    const source = readFileSync(
      new URL("../passkey-aaguid-data.ts", import.meta.url),
      "utf8",
    );
    const keys = [...source.matchAll(/^ {2}"([0-9a-f-]{36})":/gm)].map(
      (match) => match[1],
    );

    // Sanity: the regex must actually be finding the rows, or the dupe check
    // below is vacuous for a different reason than the one it guards.
    expect(keys.length).toBe(entries.length);

    const seen = new Set<string>();
    const duplicates = keys.filter((key) => !seen.add(key));
    expect(duplicates).toEqual([]);
  });

  it("has no blank or non-string names", () => {
    const bad = entries.filter(
      ([, name]) => typeof name !== "string" || name.trim() === "",
    );
    expect(bad).toEqual([]);
  });

  it("does not contain the all-zero AAGUID", () => {
    expect(
      Object.prototype.hasOwnProperty.call(PASSKEY_AAGUID_NAMES, ABSENT_AAGUID),
    ).toBe(false);
  });

  it("is frozen so a caller cannot poison the table", () => {
    expect(Object.isFrozen(PASSKEY_AAGUID_NAMES)).toBe(true);
  });
});

describe("composition with derivePasskeyName", () => {
  it("feeds the label through the shared collision suffix", () => {
    const label = passkeyAaguidLabel("bada5566-a7aa-401f-bd96-45619a55120d");
    expect(label).toBe("1Password");
    expect(derivePasskeyName({ deviceLabel: label })).toBe("1Password");
    expect(
      derivePasskeyName({ deviceLabel: label, existingNames: ["1Password"] }),
    ).toBe("1Password (2)");
  });

  it("degrades to the browser-derived label when the AAGUID is absent", () => {
    const label = passkeyAaguidLabel(ABSENT_AAGUID) ?? "macOS";
    expect(derivePasskeyName({ deviceLabel: label, userName: "Tom" })).toBe(
      `Tom${String.fromCodePoint(0x2019)}s macOS`,
    );
  });
});
