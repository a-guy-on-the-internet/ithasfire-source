import { describe, expect, it } from "vitest";

import en from "../messages/en";
import es from "../messages/es";

/**
 * THE NO-CERTIFICATION INVARIANT, guarded at the CATALOG.
 *
 * `/my-volunteering/hours/print` is handed to school registrars, court
 * officers, employer matching programmes and grant administrators. Ithas Fire
 * recorded a check-in; it did not audit anyone's work, and the document must
 * never imply otherwise. That is the feature, not a copy preference.
 *
 * The component test asserts this too, but only against a render of the merged
 * ENGLISH catalog — so a translator adding "certificado" to `es.ts` shipped
 * green, and the Spanish document's central constraint was guarded by nothing.
 * `catalog-parity.test.ts` doesn't help either: it gates keys and ICU
 * arguments, not content.
 *
 * So the guard lives with the data. A hand-checked English render in another
 * package is green by construction for every language it doesn't render.
 */

/** Every string in a message subtree, flattened with its dotted key path. */
const flatten = (
  node: unknown,
  path: string[] = [],
): Array<{ key: string; value: string }> => {
  if (typeof node === "string") return [{ key: path.join("."), value: node }];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, [...path, k]),
    );
  }
  return [];
};

type Catalog = { name: string; subtree: unknown; forbidden: RegExp };

const CATALOGS: Catalog[] = [
  {
    name: "en",
    subtree: (en as Record<string, unknown>).hoursStatement,
    // "confirmed BY" specifically — an unqualified "confirmed" is not the
    // claim we're policing, and banning it outright would be superstition.
    forbidden: /verif|certif|notaris|notariz|confirmed by|attest|guarantee/i,
  },
  {
    name: "es",
    subtree: (es as Record<string, unknown>).hoursStatement,
    // `confirmad(o|a)` = "confirmed"; `da fe` = the notarial "attests that".
    forbidden: /verific|certific|notari|confirmad|da fe|garantiz/i,
  },
];

describe("hours statement — the document may not claim it verified anything", () => {
  for (const { name, subtree, forbidden } of CATALOGS) {
    describe(name, () => {
      it("has an hoursStatement subtree with strings in it", () => {
        // Guards the guard: if the subtree is ever renamed or moved, the
        // assertions below would pass over an empty list and this whole file
        // would become decorative.
        const entries = flatten(subtree);
        expect(entries.length).toBeGreaterThan(15);
      });

      it("uses no language implying Ithas Fire audited the work", () => {
        const offenders = flatten(subtree)
          .filter(({ value }) => forbidden.test(value))
          .map(({ key, value }) => `${key}: ${value}`);

        expect(
          offenders,
          `hoursStatement.${name} must not assert verification/certification. ` +
            `Ithas Fire recorded a check-in — say that, and nothing stronger. ` +
            `Offending strings:\n${offenders.join("\n")}`,
        ).toEqual([]);
      });

      it("still states what the document actually is", () => {
        // The flip side: stripping the strong words must not leave the sheet
        // making no claim at all. The footer has to say what it IS.
        const footer = flatten(subtree).find(({ key }) => key === "footerNote");
        expect(footer?.value).toBeTruthy();
        expect(footer!.value).toMatch(
          name === "es" ? /asistencia registrada/i : /recorded as checked in/i,
        );
      });
    });
  }
});
