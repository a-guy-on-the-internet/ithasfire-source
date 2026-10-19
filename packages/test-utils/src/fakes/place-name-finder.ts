import { vi } from "vitest";

import type { PlaceRecord } from "@th/types/repos/places";

/**
 * The adapter's SQL name normal form, in JS:
 * `lower(btrim(regexp_replace(normalize(name, NFKC), '[[:space:]]+', ' ', 'g')))`
 * (`findActiveExactPlaceIdsByNormalizedName` in the Prisma places adapter).
 */
export function sqlNormalizedPlaceName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Names whose normal form must agree in core (`normalizePlaceName`), here
 * (`sqlNormalizedPlaceName`) and in Postgres: the core test checks the
 * first two, the adapter integration test the last two. Spacing runs and
 * tabs, NO-BREAK SPACE, EM SPACE, IDEOGRAPHIC SPACE, NFD accents, a
 * non-ASCII capital, the fullwidth / ligature compatibility forms NFKC
 * folds, and LIKE wildcards (matched literally).
 */
export const PLACE_NAME_CORPUS: readonly string[] = [
  "Corner Bar South",
  "  corner   BAR\tsouth ",
  "Corner\u00a0Bar\u00a0South",
  "Corner\u2003Bar South",
  "Corner\u3000Bar South",
  "Cafe\u0301 Lola",
  "Caf\u00e9 Lola",
  "CAF\u00c9 LOLA",
  "\uff23orner Bar",
  "\ufb01ve Points",
  "100% Bar_Room",
  "\tThe\n  Basement\t",
];

/**
 * A fake `findActiveExactByNormalizedName` + `lockPlaceName` over `rows()`,
 * applying the SAME filter the adapter's SQL does — ACTIVE, EXACT, the SQL
 * name normal form, the exclusion, id order, then the limit. A fake that
 * returned every row would let a caller's own post-filter hide a query bug.
 *
 * `onLock` runs inside `lockPlaceName`: a test can commit a competing row
 * there to model the write it was waiting behind.
 */
export function createPlaceNameFinderFake(
  rows: () => readonly PlaceRecord[],
  options: { onLock?: (normalizedName: string) => void } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    findActiveExactByNormalizedName: vi.fn(
      async (input: {
        normalizedName: string;
        excludePlaceId?: string;
        limit?: number;
      }): Promise<PlaceRecord[]> => {
        calls.push("find");
        const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
        return rows()
          .filter(
            (place) =>
              place.status === "ACTIVE" &&
              place.locationMode === "EXACT" &&
              sqlNormalizedPlaceName(place.name) === input.normalizedName &&
              place.id !== input.excludePlaceId,
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, limit);
      },
    ),
    lockPlaceName: vi.fn(async (normalizedName: string) => {
      calls.push(`lock:${normalizedName}`);
      options.onLock?.(normalizedName);
    }),
  };
}
