import { describe, expect, it, vi } from "vitest";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { TxRepos } from "@th/ports/repos";

import { normalizeAddress, writePlaceInTx } from "../upsert-place";

/**
 * writePlaceInTx's own guard: the row it writes (`input.placeId`) must be the
 * row it locked, authorised against and branched on (`existingPlace`). A
 * caller that mixed them up would overwrite one place under another's checks,
 * or mint a second page and calendar for an existing row.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-13T12:00:00.000Z");

const ADDRESS = {
  formatted: "123 Main St, City, ST",
  line1: "123 Main St",
  countryCode: "US",
  lat: 36.1,
  lng: -86.7,
};

function makeTx() {
  const upsert = vi.fn();
  const auditLog = vi.fn();
  const tx = {
    places: { upsert, getById: vi.fn() },
    events: { lockLocationsAtPlace: vi.fn() },
    audit: { log: auditLog },
  } as unknown as TxRepos;
  return { tx, upsert, auditLog };
}

function ctx(
  placeId: string | undefined,
  existingPlace: PlaceRecord | null,
) {
  return {
    input: {
      actorHumanId: ACTOR_ID,
      owner: { kind: "human" as const, humanId: ACTOR_ID },
      name: "My Place",
      address: ADDRESS,
      ...(placeId !== undefined ? { placeId } : {}),
    },
    existingPlace,
    normalizedAddress: normalizeAddress(ADDRESS),
    taxLookupAddress: { postalCode: null, countryCode: "US" },
    preparedTaxRate: null,
    auditTime: NOW,
  };
}

const existing = { id: PLACE_ID } as PlaceRecord;

describe("writePlaceInTx — input.placeId must be existingPlace.id", () => {
  it.each([
    ["an update id with no existing row (would overwrite, unlocked, as a 'create')", PLACE_ID, null],
    ["an existing row with no update id (would mint a second place)", undefined, existing],
    ["two different places", OTHER_ID, existing],
  ] as const)("refuses %s, before touching anything", async (_label, placeId, place) => {
    const { tx, upsert, auditLog } = makeTx();

    await expect(
      writePlaceInTx({}, undefined, tx, ctx(placeId, place)),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      meta: {
        inputPlaceId: placeId ?? null,
        existingPlaceId: place?.id ?? null,
      },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(tx.events.lockLocationsAtPlace).not.toHaveBeenCalled();
  });
});
