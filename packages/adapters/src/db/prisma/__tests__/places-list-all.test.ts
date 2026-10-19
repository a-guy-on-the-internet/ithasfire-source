import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

// `places.listAll` (the /platform/places table): the exact id filter is an
// `id IN (...)` on the same `where` the count and the page share, ANDed with
// the other filters, and absent unless asked for.

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

function setup() {
  const count = vi.fn(async () => 0);
  const findMany = vi.fn(async () => []);
  const p = { place: { count, findMany } } as unknown as PrismaClientOrTx;
  return { repo: makePlacesRepo(p), count, findMany };
}

function whereOf(mock: ReturnType<typeof vi.fn>) {
  return (mock.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
    .where;
}

describe("makePlacesRepo.listAll", () => {
  it("filters count and page by the exact ids, with the other filters", async () => {
    const { repo, count, findMany } = setup();

    await repo.listAll({ placeIds: [PLACE_ID], status: ["ARCHIVED"] });

    const expected = { id: { in: [PLACE_ID] }, status: { in: ["ARCHIVED"] } };
    expect(whereOf(count)).toEqual(expected);
    expect(whereOf(findMany)).toEqual(expected);
  });

  it("an empty id list matches nothing (never 'no filter')", async () => {
    const { repo, findMany } = setup();

    await repo.listAll({ placeIds: [] });

    expect(whereOf(findMany)).toEqual({ id: { in: [] } });
  });

  it("no id filter unless asked for", async () => {
    const { repo, findMany } = setup();

    await repo.listAll({ query: "fillmore" });

    expect(whereOf(findMany)).not.toHaveProperty("id");
  });
});
