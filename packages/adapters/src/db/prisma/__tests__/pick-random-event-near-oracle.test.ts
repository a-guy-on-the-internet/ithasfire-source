import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import { haversineDistance } from "@th/core/lib/geo/haversine";
import { projectPublicEventLocation } from "@th/core/lib/location/project-public-event-location";
import { redactPlaceLocation } from "@th/core/lib/location/redact-place-location";

import { makeEventsRepo } from "../events";

/**
 * "Surprise me" is anonymous. Three guarantees are pinned here:
 *
 *   H3 — the pick is ALWAYS published + PUBLIC + ungated. There is no scope
 *        flag on the port; the SQL carries all three predicates every time.
 *   PRESENCE — "near" is decided from the point an event is SHOWN at, never
 *        its stored pin (a stored-pin filter trilaterates the house).
 *   TIMING (M3) — the candidate query necessarily depends on the TRUE point,
 *        so nothing after it may: ONE candidate query carries every
 *        projection input, the range test runs in JS, and only the chosen
 *        row is hydrated. The number and shape of queries is identical
 *        whether or not the true point is inside the probe.
 */

const TRUE = { lat: 36.1775, lng: -86.7412 };
const HOUSE_ID = "00000000-0000-4000-8000-0000000000a1";
const WINDOW = { from: new Date("2026-01-01"), to: new Date("2026-12-31") };

/** An OBSCURED freeform event — the candidate row shape (event columns + no venue). */
const obscuredRow = {
  id: "00000000-0000-4000-8000-0000000000e1",
  orgId: "00000000-0000-4000-8000-0000000000b1",
  humanId: null,
  placeId: null,
  // Selected explicitly by the candidate query (N5).
  gateType: "NONE",
  locationMode: "OBSCURED",
  locationRadiusMeters: 500,
  locationLabel: null,
  addressText: "1417 Shelby Ave",
  locality: "Nashville",
  region: "TN",
  countryCode: "US",
  postalCode: "37206",
  placeRowId: null,
  placeLocationMode: null,
  placeLocationRadiusMeters: null,
  placeLocationLabel: null,
  placeLat: null,
  placeLng: null,
  placeCity: null,
  placeRegion: null,
  placeCountry: null,
  ...TRUE,
};

const houseRow = {
  id: HOUSE_ID,
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  locationLabel: null,
  city: "Nashville",
  region: "TN",
  countryCode: "US",
  ...TRUE,
};

/** A row stored EXACT (a stale true copy) at a venue that WITHHOLDS. */
const staleAtHouseRow = {
  ...obscuredRow,
  id: "00000000-0000-4000-8000-0000000000e2",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  placeId: HOUSE_ID,
  placeRowId: HOUSE_ID,
  placeLocationMode: "OBSCURED",
  placeLocationRadiusMeters: 800,
  placeLocationLabel: null,
  placeLat: TRUE.lat,
  placeLng: TRUE.lng,
  placeCity: "Nashville",
  placeRegion: "TN",
  placeCountry: "US",
};

type Call = { kind: string; sql?: Prisma.Sql };

/**
 * A Prisma double that records every call. `candidates` is what the
 * candidate query returns — i.e. what the widened TRUE-point predicate
 * admitted.
 */
function fakePrisma(candidates: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const prisma = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls.push({ kind: "$queryRaw", sql: query });
      return candidates;
    },
    event: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push({ kind: "event.findUnique" });
        const row = candidates.find((c) => c.id === where.id);
        return row ? { ...row, status: "PUBLISHED", title: "Show" } : null;
      },
      findMany: async () => {
        calls.push({ kind: "event.findMany" });
        return [];
      },
    },
    place: {
      findMany: async () => {
        calls.push({ kind: "place.findMany" });
        return [houseRow];
      },
    },
  };
  return { prisma, calls };
}

const pick = (
  candidates: Array<Record<string, unknown>>,
  near: { lat: number; lng: number; radiusKm: number } | null,
) => {
  const { prisma, calls } = fakePrisma(candidates);
  return {
    calls,
    result: makeEventsRepo(prisma as never).pickRandomEvent({
      window: WINDOW,
      near,
      q: null,
      orgId: null,
      placeId: null,
      excludeEventIds: [],
    }),
  };
};

const sqlText = (sql: Prisma.Sql) => sql.strings.join("?").replace(/\s+/g, " ");

describe("pickRandomEvent — H3: ALWAYS published + PUBLIC + ungated", () => {
  it.each([
    ["near", { ...TRUE, radiusKm: 5 }],
    ["no near", null],
  ] as const)("the %s query carries all three predicates", async (_label, near) => {
    const { calls, result } = pick([], near);
    await result;
    const text = sqlText(calls[0]!.sql!);
    expect(text).toContain("e.status = 'PUBLISHED'");
    expect(text).toContain("e.visibility = 'PUBLIC'");
    expect(text).toContain(`e."gateType" = 'NONE'`);
  });

  it("the port has no scope flag: a stray publishedOnly: false changes nothing", async () => {
    const { prisma, calls } = fakePrisma([]);
    await makeEventsRepo(prisma as never).pickRandomEvent({
      window: WINDOW,
      near: null,
      q: null,
      orgId: null,
      placeId: null,
      excludeEventIds: [],
      publishedOnly: false,
    } as never);
    const text = sqlText(calls[0]!.sql!);
    expect(text).toContain("e.status = 'PUBLISHED'");
    expect(text).toContain("e.visibility = 'PUBLIC'");
    expect(text).toContain(`e."gateType" = 'NONE'`);
  });
});

describe("pickRandomEvent near — decided by the EMITTED point", () => {
  const emitted = projectPublicEventLocation(obscuredRow as never);

  it("a probe on the TRUE pin that misses the emitted point finds NOTHING", async () => {
    expect(
      haversineDistance(TRUE.lat, TRUE.lng, emitted.lat!, emitted.lng!),
    ).toBeGreaterThan(25);
    await expect(
      pick([obscuredRow], { ...TRUE, radiusKm: 0.025 }).result,
    ).resolves.toBeNull();
  });

  it("a probe on the EMITTED point finds it, though the true pin is outside", async () => {
    const found = await pick([obscuredRow], {
      lat: emitted.lat!,
      lng: emitted.lng!,
      radiusKm: 0.025,
    }).result;
    expect(found?.id).toBe(obscuredRow.id);
  });

  it("a stale row at a WITHHELD venue is found by the VENUE's circle, not its stored pin", async () => {
    const venue = redactPlaceLocation(houseRow);
    await expect(
      pick([staleAtHouseRow], { ...TRUE, radiusKm: 0.025 }).result,
    ).resolves.toBeNull();
    const found = await pick([staleAtHouseRow], {
      lat: venue.lat!,
      lng: venue.lng!,
      radiusKm: 0.025,
    }).result;
    expect(found?.id).toBe(staleAtHouseRow.id);
  });

  it("the SQL is only a WIDENED candidate fetch, by the DRAWN (ladder-snapped) radius", async () => {
    const { calls, result } = pick([], { ...TRUE, radiusKm: 1 });
    await result;
    const text = sqlText(calls[0]!.sql!);
    expect(text).toContain('LEFT JOIN "Place" pl ON pl.id = e."placeId"');
    expect(text).toContain("ll_to_earth(pl.lat, pl.lng)");
    // Both widenings go through the ladder snap, never the raw column.
    expect(text).toContain(
      "(SELECT min(rung) FROM unnest(?::int[]) AS rung WHERE rung >= pl.location_radius_meters)",
    );
    expect(text).toContain(
      `(SELECT min(rung) FROM unnest(?::int[]) AS rung WHERE rung >= e."locationRadiusMeters")`,
    );
    expect(text).not.toContain("+ pl.location_radius_meters");
    expect(text).toContain("ORDER BY random()");
    // Every projection input comes back from the ONE candidate query.
    for (const column of [
      // N5: the gate rides with the row; the projector never infers it.
      `e."gateType"::text AS "gateType"`,
      `e."locationMode"`,
      `e."locationRadiusMeters"`,
      `e."orgId"`,
      "e.lat",
      `pl.location_mode AS "placeLocationMode"`,
      `pl.location_radius_meters AS "placeLocationRadiusMeters"`,
      `pl.lat AS "placeLat"`,
    ]) {
      expect(text).toContain(column);
    }
  });
});

describe("pickRandomEvent near — M3: no TIMING oracle", () => {
  it("the queries are IDENTICAL whether the TRUE point is inside the probe (candidate admitted, shown point out of range) or outside it (no candidate)", async () => {
    // Probe a 25 m circle on the true pin. The widened SQL admits the row
    // (true point inside radius + R); its SHOWN point is outside.
    const inside = pick([obscuredRow], { ...TRUE, radiusKm: 0.025 });
    // Probe far away: the SQL admits nothing.
    const outside = pick([], { lat: 40, lng: -74, radiusKm: 0.025 });

    await expect(inside.result).resolves.toBeNull();
    await expect(outside.result).resolves.toBeNull();
    const shape = (calls: Call[]) =>
      calls.map((call) => ({
        kind: call.kind,
        sql: call.sql ? call.sql.strings.join("?") : null,
      }));
    expect(inside.calls).toHaveLength(1);
    expect(shape(inside.calls)).toEqual(shape(outside.calls));
  });

  it("a hit hydrates ONLY the chosen row — one candidate query + one findUnique, no venue batch", async () => {
    const emitted = projectPublicEventLocation(obscuredRow as never);
    const hit = pick([staleAtHouseRow, obscuredRow], {
      lat: emitted.lat!,
      lng: emitted.lng!,
      radiusKm: 0.025,
    });
    const found = await hit.result;
    expect(found?.id).toBe(obscuredRow.id);
    expect(hit.calls.map((call) => call.kind)).toEqual([
      "$queryRaw",
      "event.findUnique",
    ]);
  });
});
