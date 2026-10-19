import { describe, expect, it } from "vitest";

import { icuArgumentNames } from "../icu-arguments";

/**
 * The extractor pinned in both directions — it is the gate for every i18n
 * parity check in BOTH catalog systems (this package's base catalog, and
 * `apps/web`'s spotlight / pagination / error-code / whole-catalog gates), so
 * it needs its own gate.
 *
 * It replaced two flat regexes, each broken in both directions — see the
 * helper's own doc comment for the measured before/after. The cases below are
 * organised around those two directions:
 *
 *  - False POSITIVE: sub-message text is *supposed* to differ per locale, so
 *    `{count, plural, =0 {Filters} …}` vs `{… =0 {Filtros} …}` must compare
 *    EQUAL. `/\{(\w+)/g` read `Filters` / `Filtros` as argument names and
 *    failed on that correct pair.
 *  - False NEGATIVE: `/\{(\w+)\}/g` cannot see `{name, number}` or
 *    `{name, plural, …}` at all, so renaming the selector argument in one
 *    locale passed clean.
 */
describe("icuArgumentNames", () => {
  it("reads a simple argument", () => {
    expect(icuArgumentNames("+{count} more")).toEqual(["count"]);
    expect(icuArgumentNames("{shown} of {total}")).toEqual(["shown", "total"]);
  });

  it("reads a typed argument the `/\\{(\\w+)\\}/` variant cannot see", () => {
    expect(icuArgumentNames("{total, number} rows")).toEqual(["total"]);
    expect(icuArgumentNames("{when, date, medium}")).toEqual(["when"]);
  });

  it("ignores plural branch text, whatever it starts with", () => {
    expect(
      icuArgumentNames("{count, plural, one {# order} other {# orders}}"),
    ).toEqual(["count"]);
    expect(
      icuArgumentNames("{count, plural, =0 {Filters} other {Filters (#)}}"),
    ).toEqual(["count"]);
    expect(
      icuArgumentNames("{count, plural, =0 {Filtros} other {Filtros (#)}}"),
    ).toEqual(["count"]);
  });

  /**
   * The false-POSITIVE half, stated as the gate sees it: two locales whose
   * plural branches carry different literal TEXT must compare EQUAL.
   */
  it("treats locale-divergent branch text as equal argument sets", () => {
    expect(
      icuArgumentNames("{count, plural, =0 {Filters} other {Filters (#)}}"),
    ).toEqual(
      icuArgumentNames("{count, plural, =0 {Filtros} other {Filtros (#)}}"),
    );
    expect(
      icuArgumentNames("{count, select, other {No results for {query}}}"),
    ).toEqual(
      icuArgumentNames("{count, select, other {Sin resultados para {query}}}"),
    );
  });

  /** The false-negative half: a branch may legitimately contain an argument. */
  it("still finds arguments nested inside a branch", () => {
    expect(
      icuArgumentNames("{count, plural, other {# of {total} shown}}"),
    ).toEqual(["count", "total"]);
    // …and a rename in there is therefore visible.
    expect(
      icuArgumentNames("{count, plural, other {# de {cuenta} vistos}}"),
    ).not.toEqual(
      icuArgumentNames("{count, plural, other {# of {total} shown}}"),
    );
  });

  it("recurses through nested sub-messages", () => {
    expect(
      icuArgumentNames(
        "{a, plural, other {{b, select, other {{c} and {d}}}}}",
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("catches a renamed argument at the top level", () => {
    expect(icuArgumentNames("{cuenta, plural, other {#}}")).not.toEqual(
      icuArgumentNames("{count, plural, other {#}}"),
    );
  });

  it("treats a lone apostrophe as literal and an ICU escape as quoting", () => {
    expect(icuArgumentNames("don't {count}")).toEqual(["count"]);
    expect(icuArgumentNames("'{not an arg}' {real}")).toEqual(["real"]);
  });

  it("returns nothing for plain copy", () => {
    expect(icuArgumentNames("Untitled event")).toEqual([]);
  });
});
