import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaceRecord } from "@th/ports/repos/places";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import {
  scrubEventSearchDocIfWithheld,
  scrubSearchDocumentsOrThrow,
  type ScrubEventRow,
} from "../privacy-scrub";

/**
 * The event half of the fail-closed scrub (`privacy-scrub.ts`): WHICH changes
 * to an existing event delete its search document before commit, and that a
 * failed delete throws rather than returning.
 */

const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "99999999-9999-4999-8999-999999999999";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";

function event(overrides: Partial<ScrubEventRow> = {}): ScrubEventRow {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    placeId: null,
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressText: "1417 Shelby Ave, Nashville, TN 37206",
    lat: 36.1775,
    lng: -86.7412,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37206",
    ...overrides,
  };
}

function place(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Shelby House",
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    addressLine1: "1417 Shelby Ave",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1775,
    lng: -86.7412,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    ...overrides,
  } as PlaceRecord;
}

function setup(
  opts: { place?: PlaceRecord | null; scrub?: "ok" | "err" | "throw" } = {},
) {
  const deleteDocuments = vi.fn(async (input: { ids?: string[] }) => {
    if (opts.scrub === "throw") throw new Error("unreachable");
    if (opts.scrub === "err") {
      return { ok: false as const, error: new Error("delete failed") };
    }
    return { ok: true as const, value: { deleted: input.ids?.length ?? 0 } };
  });
  const places = {
    getById: vi.fn(async () =>
      opts.place === undefined ? null : opts.place,
    ),
  };
  const run = (before: ScrubEventRow, after: ScrubEventRow) =>
    scrubEventSearchDocIfWithheld({
      search: { deleteDocuments } as never,
      places: places as never,
      before,
      after,
      useCase: "test",
    });
  return { run, deleteDocuments, places };
}

beforeEach(() => {
  configureLocationObfuscation({ secret: "privacy-scrub-test-secret" });
});
afterEach(() => {
  resetLocationObfuscationForTests();
});

describe("scrubEventSearchDocIfWithheld", () => {
  it("EXACT → hidden (event-level): deletes the event document", async () => {
    const h = setup();
    await expect(
      h.run(event(), event({ locationMode: "OBSCURED" })),
    ).resolves.toBe(true);
    expect(h.deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${EVENT_ID}`],
    });
  });

  it("EXACT → circle, and a bigger circle while obscured: deletes", async () => {
    const circle = setup();
    await circle.run(
      event(),
      event({ locationMode: "OBSCURED", locationRadiusMeters: 1000 }),
    );
    expect(circle.deleteDocuments).toHaveBeenCalledTimes(1);

    const wider = setup();
    await wider.run(
      event({ locationMode: "OBSCURED", locationRadiusMeters: 500 }),
      event({ locationMode: "OBSCURED", locationRadiusMeters: 2000 }),
    );
    expect(wider.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("a gate being added: deletes (a gated event's location is label only)", async () => {
    const h = setup();
    await expect(
      h.run(event(), event({ gateType: "PASSWORD" })),
    ).resolves.toBe(true);
    expect(h.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("a move from an EXACT venue onto a withheld venue: deletes", async () => {
    const other = "44444444-4444-4444-8444-444444444444";
    const h = setup();
    const venues = async (id: string) =>
      id === PLACE_ID
        ? place({ locationMode: "OBSCURED", locationRadiusMeters: null })
        : place({ id: other });
    h.places.getById.mockImplementation(venues as never);

    await h.run(event({ placeId: other }), event({ placeId: PLACE_ID }));

    expect(h.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("an unreadable venue is treated as hidden (fails closed)", async () => {
    const h = setup({ place: null });
    // Before: no venue, exact pin. After: a venue we cannot read.
    await h.run(event(), event({ placeId: PLACE_ID }));
    expect(h.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("does NOT delete a loosening, an unrelated edit, or a new exact address", async () => {
    const h = setup();
    await h.run(event({ locationMode: "OBSCURED" }), event());
    await h.run(event(), event());
    await h.run(
      event(),
      event({ addressText: "2 Other St, Nashville, TN", lat: 36.2, lng: -86.8 }),
    );
    // A gate removed onto an exact pin.
    await h.run(event({ gateType: "APPLICATION" }), event());
    expect(h.deleteDocuments).not.toHaveBeenCalled();
  });

  it.each(["err", "throw"] as const)(
    "a failed delete (%s) THROWS SEARCH_UPDATE_RETRY instead of returning",
    async (mode) => {
      const h = setup({ scrub: mode });
      await expect(
        h.run(event(), event({ locationMode: "OBSCURED" })),
      ).rejects.toMatchObject({
        code: "SEARCH_UPDATE_RETRY",
      });
    },
  );

  it("no search port: nothing to scrub, no venue read", async () => {
    const places = { getById: vi.fn() };
    await expect(
      scrubEventSearchDocIfWithheld({
        search: undefined,
        places: places as never,
        before: event(),
        after: event({ locationMode: "OBSCURED" }),
        useCase: "test",
      }),
    ).resolves.toBe(false);
    expect(places.getById).not.toHaveBeenCalled();
  });
});

describe("scrubSearchDocumentsOrThrow", () => {
  it("de-duplicates and chunks large id sets", async () => {
    const deleteDocuments = vi.fn(async () => ({
      ok: true as const,
      value: { deleted: 0 },
    }));
    const ids = Array.from({ length: 2500 }, (_, i) => `event_${i}`);
    await scrubSearchDocumentsOrThrow(
      { deleteDocuments } as never,
      { docIds: [...ids, ids[0]!], useCase: "test" },
    );
    expect(deleteDocuments).toHaveBeenCalledTimes(3);
    const sent = deleteDocuments.mock.calls.flatMap(
      (c) => (c as unknown as [{ ids: string[] }])[0].ids,
    );
    expect(sent).toHaveLength(2500);
  });

  it("stops at the first failed chunk and throws", async () => {
    const deleteDocuments = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { deleted: 1000 } })
      .mockResolvedValueOnce({ ok: false, error: new Error("down") });
    const ids = Array.from({ length: 2500 }, (_, i) => `event_${i}`);
    await expect(
      scrubSearchDocumentsOrThrow({ deleteDocuments } as never, {
        docIds: ids,
        useCase: "test",
      }),
    ).rejects.toMatchObject({ code: "SEARCH_UPDATE_RETRY" });
    expect(deleteDocuments).toHaveBeenCalledTimes(2);
  });

  it("returns false with no ids (no call)", async () => {
    const deleteDocuments = vi.fn();
    await expect(
      scrubSearchDocumentsOrThrow({ deleteDocuments } as never, {
        docIds: [],
        useCase: "test",
      }),
    ).resolves.toBe(false);
    expect(deleteDocuments).not.toHaveBeenCalled();
  });
});
