import { describe, expect, it } from "vitest";

import {
  PLACE_NAME_CORPUS,
  sqlNormalizedPlaceName,
} from "@th/test-utils/fakes/place-name-finder";

import { normalizePlaceName } from "../_shared/community-place";

/**
 * The duplicate guard locks and looks up by `normalizePlaceName`; the SQL
 * finder matches on its own normal form. They must agree, or the lock and
 * the lookup miss each other. This checks core against the JS mirror of the
 * SQL (`sqlNormalizedPlaceName`); the adapter integration test
 * (`places-name-finder.test.ts`) checks that mirror against Postgres on the
 * SAME corpus.
 */
describe("normalizePlaceName agrees with the SQL normal form", () => {
  it.each(PLACE_NAME_CORPUS.map((name) => [JSON.stringify(name), name]))(
    "%s",
    (_label, name) => {
      expect(normalizePlaceName(name)).toBe(sqlNormalizedPlaceName(name));
    },
  );

  it("folds the spacing and Unicode variants to one name", () => {
    expect(
      new Set(
        [
          "Corner Bar South",
          "  corner   BAR\tsouth ",
          "Corner Bar South",
          "Corner Bar South",
          "Corner　Bar South",
        ].map(normalizePlaceName),
      ),
    ).toEqual(new Set(["corner bar south"]));
    expect(
      new Set(["Café Lola", "Café Lola", "CAFÉ LOLA"].map(normalizePlaceName)),
    ).toEqual(new Set(["café lola"]));
  });
});
