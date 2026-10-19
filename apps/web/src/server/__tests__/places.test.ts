import { describe, expect, it, vi } from "vitest";

import {
  loadPlacePublic,
  loadPlaceEvents,
  resolvePlaceById,
} from "@/server/places";

vi.mock("@/server/trpc-client", () => {
  const client = {
    places: {
      resolvePlaceById: {
        query: vi.fn(() => ({ placeId: "place-1", redirect: false })),
      },
      getPlacePublic: {
        query: vi.fn(() => ({
          place: {
            placeId: "place-1",
            name: "Test Place",
            formattedAddress: null,
            city: null,
            region: null,
            countryCode: null,
            lat: null,
            lng: null,
            capacity: null,
            status: "ACTIVE",
            verificationStatus: "UNVERIFIED",
          },
        })),
      },
      listPlaceEvents: {
        query: vi.fn(() => ({
          events: [],
          pageInfo: {
            total: 0,
            limit: 12,
            offset: 0,
            count: 0,
            hasMore: false,
          },
        })),
      },
    },
  };

  return {
    getServerTrpcClient: () => client,
  };
});

describe("server/places", () => {
  it("resolves place id", async () => {
    await expect(resolvePlaceById("place-1")).resolves.toMatchObject({
      placeId: "place-1",
    });
  });

  it("loads public place", async () => {
    const payload = await loadPlacePublic("place-1");
    expect(payload?.place.placeId).toBe("place-1");
    expect(payload?.place.status).toBe("ACTIVE");
  });

  it("loads place events with timeWindow", async () => {
    const result = await loadPlaceEvents({
      placeId: "place-1",
      status: "upcoming",
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2026-01-01T00:00:00.000Z"),
      limit: 12,
      offset: 0,
    });

    expect(result?.events).toEqual([]);
  });
});
