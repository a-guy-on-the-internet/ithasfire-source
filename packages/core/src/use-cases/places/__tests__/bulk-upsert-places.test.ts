import { describe, expect, it, vi } from "vitest";

import { bulkUpsertPlaces } from "../bulk-upsert-places";
import * as upsertModule from "../upsert-place";
import type { BulkUpsertPlacesDeps } from "../bulk-upsert-places";
import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";

function buildDeps(): BulkUpsertPlacesDeps {
  return {
    repos: {} as unknown as Repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => BASE_DATE) },
    logger: createTestLogger(),
  };
}

function makePlaceInput(overrides: Record<string, unknown> = {}) {
  return {
    owner: { kind: "human" as const, humanId: DEFAULT_ACTOR_ID },
    name: (overrides.name as string) ?? "My Venue",
    address: {
      formatted: "123 Main St, City, ST",
      line1: "123 Main St",
      city: "City",
      region: "ST",
      postalCode: "12345",
      countryCode: "US",
    },
    clientKey:
      (overrides.clientKey as string) ??
      `key-${Math.random().toString(36).slice(2, 12)}`,
    ...overrides,
  };
}

describe("bulkUpsertPlaces", () => {
  it("upserts all places and returns per-item results", async () => {
    const deps = buildDeps();
    const upsertSpy = vi
      .spyOn(upsertModule, "upsertPlace")
      .mockResolvedValueOnce({
        placeId: "aaaa-1111",
        slug: "us/st/venue-a",
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        access: { orgIds: [], humanIds: [DEFAULT_ACTOR_ID] },
      })
      .mockResolvedValueOnce({
        placeId: "bbbb-2222",
        slug: "us/st/venue-b",
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        access: { orgIds: [], humanIds: [DEFAULT_ACTOR_ID] },
      });

    const result = await bulkUpsertPlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      places: [
        makePlaceInput({ name: "Venue A" }),
        makePlaceInput({ name: "Venue B" }),
      ],
    });

    expect(result.total).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.results).toEqual([
      { index: 0, placeId: "aaaa-1111" },
      { index: 1, placeId: "bbbb-2222" },
    ]);
    expect(upsertSpy).toHaveBeenCalledTimes(2);

    upsertSpy.mockRestore();
  });

  it("continues on partial failure and reports per-item errors", async () => {
    const deps = buildDeps();
    const upsertSpy = vi
      .spyOn(upsertModule, "upsertPlace")
      .mockResolvedValueOnce({
        placeId: "aaaa-1111",
        slug: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        access: { orgIds: [], humanIds: [DEFAULT_ACTOR_ID] },
      })
      .mockRejectedValueOnce({ code: "not_found", message: "human_not_found" })
      .mockResolvedValueOnce({
        placeId: "cccc-3333",
        slug: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        access: { orgIds: [], humanIds: [DEFAULT_ACTOR_ID] },
      });

    const result = await bulkUpsertPlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      places: [
        makePlaceInput({ name: "Good 1" }),
        makePlaceInput({ name: "Bad One" }),
        makePlaceInput({ name: "Good 2" }),
      ],
    });

    expect(result.total).toBe(3);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toEqual({ index: 0, placeId: "aaaa-1111" });
    expect(result.results[1]).toEqual({ index: 1, error: "not_found" });
    expect(result.results[2]).toEqual({ index: 2, placeId: "cccc-3333" });

    upsertSpy.mockRestore();
  });

  it("rejects when places array exceeds max of 100", async () => {
    const deps = buildDeps();
    const places = Array.from({ length: 101 }, (_, i) =>
      makePlaceInput({ name: `Place ${i}` }),
    );

    await expect(
      bulkUpsertPlaces(deps, { actorHumanId: DEFAULT_ACTOR_ID, places }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects empty places array", async () => {
    const deps = buildDeps();

    await expect(
      bulkUpsertPlaces(deps, { actorHumanId: DEFAULT_ACTOR_ID, places: [] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts exactly 100 places", async () => {
    const deps = buildDeps();
    const upsertSpy = vi.spyOn(upsertModule, "upsertPlace").mockResolvedValue({
      placeId: "xxxx-0000",
      slug: null,
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
      access: { orgIds: [], humanIds: [DEFAULT_ACTOR_ID] },
    });

    const places = Array.from({ length: 100 }, (_, i) =>
      makePlaceInput({ name: `Place ${i}` }),
    );

    const result = await bulkUpsertPlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      places,
    });

    expect(result.total).toBe(100);
    expect(result.imported).toBe(100);
    expect(upsertSpy).toHaveBeenCalledTimes(100);

    upsertSpy.mockRestore();
  });

  it("returns internal_error for unexpected exceptions", async () => {
    const deps = buildDeps();
    const upsertSpy = vi
      .spyOn(upsertModule, "upsertPlace")
      .mockRejectedValueOnce(new Error("connection refused"));

    const result = await bulkUpsertPlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      places: [makePlaceInput()],
    });

    expect(result.skipped).toBe(1);
    expect(result.results[0]?.error).toBe("internal_error");

    upsertSpy.mockRestore();
  });
});

// ── Performer-review switch (venue-track-record-and-review-switch FR-005) ──
// `bulkUpsertPlaces` delegates every item to the REAL `upsertPlace` (no spy
// here), so the CREATE-only rule on `communityReviewsEnabled` is enforced per
// item: an existing place carrying the field is refused before any read —
// `repos` is deliberately empty, so a read would throw a TypeError instead.
describe("bulkUpsertPlaces — communityReviewsEnabled on an existing place", () => {
  it("refuses the item with INVALID_INPUT and imports nothing", async () => {
    const deps = buildDeps();

    const result = await bulkUpsertPlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      places: [
        makePlaceInput({
          placeId: "33333333-3333-4333-8333-333333333333",
          communityReviewsEnabled: true,
        }),
      ],
    });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.results).toEqual([{ index: 0, error: "INVALID_INPUT" }]);
  });
});
