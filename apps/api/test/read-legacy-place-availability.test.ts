import { describe, expect, it, vi } from "vitest";

import {
  legacyPlaceAvailabilityExists,
  readLegacyPlaceAvailability,
  type RawQueryClient,
} from "../src/scripts/read-legacy-place-availability";

/**
 * The backfill's legacy read, after `PlaceAvailability` lost its Prisma model.
 *
 * What this is really protecting: the drop migration removes the table this
 * reads. A deploy that runs the backfill on an already-migrated database — the
 * normal case, forever, once the drop has shipped — must NOT die on a missing
 * relation. A crashing backfill step fails the deploy for a database that is
 * already in the desired state, so "table is gone" has to be an empty result,
 * not an exception. The other half is the ordering guarantee: while the table
 * still exists, every row must come back, because anything missed is a venue
 * whose booking picker silently shows closed on every date.
 */

/** A fake that dispatches on the SQL text of the tagged template. */
function fakeClient(opts: {
  present: boolean;
  rows?: unknown[];
  onSelect?: (sql: string) => void;
}): RawQueryClient {
  return {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join("");
      if (sql.includes("to_regclass")) return [{ present: opts.present }];
      opts.onSelect?.(sql);
      return opts.rows ?? [];
    }) as RawQueryClient["$queryRaw"],
  };
}

const LEGACY_ROW = {
  placeId: "00000000-0000-4000-8000-0000000000a1",
  dayOfWeek: 5,
  date: null,
  startTime: "18:00",
  endTime: "23:00",
  isOpen: true,
  note: null,
};

describe("legacyPlaceAvailabilityExists", () => {
  it("reports true when to_regclass resolves the table", async () => {
    await expect(
      legacyPlaceAvailabilityExists(fakeClient({ present: true })),
    ).resolves.toBe(true);
  });

  it("reports false when to_regclass returns NULL", async () => {
    await expect(
      legacyPlaceAvailabilityExists(fakeClient({ present: false })),
    ).resolves.toBe(false);
  });

  it("reports false rather than throwing on an empty result set", async () => {
    const client: RawQueryClient = {
      $queryRaw: vi.fn(async () => []) as RawQueryClient["$queryRaw"],
    };
    await expect(legacyPlaceAvailabilityExists(client)).resolves.toBe(false);
  });
});

describe("readLegacyPlaceAvailability", () => {
  it("returns the legacy rows while the table still exists", async () => {
    const rows = await readLegacyPlaceAvailability(
      fakeClient({ present: true, rows: [LEGACY_ROW] }),
    );
    expect(rows).toEqual([LEGACY_ROW]);
  });

  it("no-ops to an empty set once the table has been dropped", async () => {
    // The post-migration steady state. Must not throw: the backfill is a
    // deploy step, and a database that has already run the drop is CORRECT,
    // not broken.
    const client = fakeClient({ present: false, rows: [LEGACY_ROW] });
    await expect(readLegacyPlaceAvailability(client)).resolves.toEqual([]);
  });

  it("never issues the SELECT when the table is absent", async () => {
    // Probing first is the whole mechanism — a SELECT against a missing
    // relation raises 42P01 and would poison any surrounding transaction.
    const onSelect = vi.fn();
    await readLegacyPlaceAvailability(
      fakeClient({ present: false, onSelect, rows: [LEGACY_ROW] }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reads oldest-first and selects exactly the fields the planner needs", async () => {
    // Field drift here is silent data loss: a column dropped from the SELECT
    // arrives as `undefined` and is copied into CalendarAvailability as such.
    let seen = "";
    await readLegacyPlaceAvailability(
      fakeClient({ present: true, onSelect: (sql) => (seen = sql) }),
    );
    for (const column of [
      "placeId",
      "dayOfWeek",
      "date",
      "startTime",
      "endTime",
      "isOpen",
      "note",
    ]) {
      expect(seen).toContain(`"${column}"`);
    }
    expect(seen).toContain('ORDER BY "createdAt" ASC');
  });

  it("interpolates nothing — the statement carries no values", async () => {
    // The one raw-SQL site in this script. It must stay a fixed string.
    const $queryRaw = vi.fn(async (query: TemplateStringsArray) =>
      query.join("").includes("to_regclass") ? [{ present: true }] : [],
    );
    await readLegacyPlaceAvailability({
      $queryRaw,
    } as unknown as RawQueryClient);

    for (const call of $queryRaw.mock.calls) {
      const [strings, ...values] = call as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(values).toEqual([]);
      expect(strings).toHaveLength(1);
    }
  });
});
