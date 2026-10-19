import { describe, it, expect, vi } from "vitest";

import { listGeoCategoryCombos } from "./list-geo-category-combos";
import { MIN_EVENTS_PER_GEO_CATEGORY_PAGE } from "./_shared/geo-category";
import type { GeoCategoryComboRecord } from "@th/ports/repos/events";

function makeDeps(combos: GeoCategoryComboRecord[]) {
  const enumerateGeoCategoryCombos = vi.fn(async () => combos);
  return {
    deps: {
      repos: {
        events: { enumerateGeoCategoryCombos },
      },
    } as any,
    enumerateGeoCategoryCombos,
  };
}

const combo = (
  overrides: Partial<GeoCategoryComboRecord> = {},
): GeoCategoryComboRecord => ({
  categorySlug: "open-mics",
  categoryName: "Open Mics",
  categoryNameTranslations: {},
  locality: "Nashville",
  regionCode: "tn",
  count: 5,
  latestUpdatedAt: new Date("2026-02-01T00:00:00Z"),
  ...overrides,
});

describe("listGeoCategoryCombos", () => {
  it("forwards the default min-count threshold and 'now' to the repo", async () => {
    const { deps, enumerateGeoCategoryCombos } = makeDeps([combo()]);

    await listGeoCategoryCombos(deps, {});

    expect(enumerateGeoCategoryCombos).toHaveBeenCalledTimes(1);
    const args = enumerateGeoCategoryCombos.mock.calls[0][0];
    expect(args.minCount).toBe(MIN_EVENTS_PER_GEO_CATEGORY_PAGE);
    expect(args.startsAfter).toBeInstanceOf(Date);
  });

  it("honours an explicit minCount", async () => {
    const { deps, enumerateGeoCategoryCombos } = makeDeps([]);
    await listGeoCategoryCombos(deps, { minCount: 10 });
    expect(enumerateGeoCategoryCombos.mock.calls[0][0].minCount).toBe(10);
  });

  it("builds a canonical city segment and serializes latestUpdatedAt", async () => {
    const { deps } = makeDeps([
      combo({ locality: "Nashville", regionCode: "tn" }),
      combo({
        locality: "New York",
        regionCode: null,
        latestUpdatedAt: null,
      }),
    ]);

    const result = await listGeoCategoryCombos(deps, {});

    expect(result[0]).toEqual({
      categorySlug: "open-mics",
      categoryName: "Open Mics",
      names: { en: "Open Mics" },
      city: "Nashville",
      regionCode: "tn",
      citySegment: "nashville-tn",
      count: 5,
      latestUpdatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(result[1].citySegment).toBe("new-york");
    expect(result[1].latestUpdatedAt).toBeNull();
  });

  it("carries the category's translated names beside its English name", async () => {
    const { deps } = makeDeps([
      combo({ categoryNameTranslations: { es: "Micrófono abierto" } }),
    ]);

    const result = await listGeoCategoryCombos(deps, {});

    expect(result[0].categoryName).toBe("Open Mics");
    expect(result[0].names).toEqual({
      en: "Open Mics",
      es: "Micrófono abierto",
    });
  });
});
