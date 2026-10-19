import { z } from "zod";
import { describe, expect, beforeEach, it } from "vitest";

import { createUseCaseContext } from "#test/factories/use-case-context";
import { IthasFireError } from "#core/interfaces/error";
import { createIdempotencyKey } from "#core/lib/idempotency";
import { NoRandomEventAvailableError } from "#core/interfaces/error";
import { nullable } from "#core/lib/schema";
import { getRandomEvent } from "#core/use-cases/events/get-random-event";
import { IthasFireDate } from "#core/lib/date";

const inputSchema = z.object({
  humanCountryCode: z.string(),
  humanRegionCode: nullable(z.string()),
  humanCityGeoHash: nullable(z.string()),
  offsetKm: z.number(),
  maxDistanceKm: z.number(),
  timeWindow: z.object({
    from: z.string(),
    to: z.string(),
  }),
  now: nullable(z.string()),
});

describe("getRandomEvent", () => {
  const ctx = createUseCaseContext();
  const tenKmInMeters = 10 * 1000;
  const fiveKmInMeters = 5 * 1000;

  beforeEach(() => {
    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async () => [],
    });

    ctx.fakeIdempotency.setPrototypes({
      get: async () => null,
      set: async () => undefined,
    });

    ctx.fakeGeo.setPrototypes({
      randomPoint: async () => ({ lat: 0, lng: 0 }),
      expandBounds: async () => ({
        northEast: { lat: 0.1, lng: 0.1 },
        southWest: { lat: -0.1, lng: -0.1 },
      }),
      distanceBetween: async () => tenKmInMeters,
      haversineDistance: () => tenKmInMeters,
    });

    ctx.fakeSearch.setPrototypes({
      searchEvents: async () => ({ items: [], nextCursor: undefined }),
    });

    ctx.fakeMetrics!.increment.mockReset();
    ctx.fakeLogger.debug.mockReset();
  });

  it("returns an event from idempotency cache when available", async () => {
    const event = { id: "event-1" } as const;
    ctx.fakeIdempotency.setPrototypes({
      get: async () => ({ status: "success", value: event }),
    });

    const result = await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "some-client-key",
      input: {
        humanCountryCode: "US",
        humanRegionCode: null,
        humanCityGeoHash: "9q8yy",
        offsetKm: 0,
        maxDistanceKm: 50,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 30 }).toISO(),
        },
        now: IthasFireDate.utc().toISO(),
      },
    });

    expect(result).toEqual(event);
    expect(
      ctx.fakeRepos.eventsRepo.getCalls().searchActivePublishedEvents,
    ).toBeUndefined();
    expect(ctx.fakeMetrics!.increment).not.toHaveBeenCalled();
  });

  it("returns an event from search when idempotency cache is empty", async () => {
    const event = { id: "event-2" } as const;
    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async () => [event],
    });

    const result = await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "client-key",
      input: {
        humanCountryCode: "US",
        humanRegionCode: "CA",
        humanCityGeoHash: null,
        offsetKm: 10,
        maxDistanceKm: 50,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 30 }).toISO(),
        },
        now: null,
      },
    });

    expect(result).toEqual(event);
    expect(ctx.fakeMetrics!.increment).toHaveBeenCalledWith(
      "events.random.success",
    );
    expect(ctx.fakeIdempotency.getCalls().set![0]).toMatchObject({
      key: createIdempotencyKey({
        scope: "get-random-event",
        idempotencyKey: "client-key",
      }),
    });
  });

  it("stores NoRandomEventAvailableError in idempotency cache", async () => {
    const result = await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "missing",
      input: {
        humanCountryCode: "US",
        humanRegionCode: null,
        humanCityGeoHash: null,
        offsetKm: 0,
        maxDistanceKm: 100,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 14 }).toISO(),
        },
        now: null,
      },
    }).catch((error: IthasFireError) => error);

    expect(result).toBeInstanceOf(NoRandomEventAvailableError);
    expect(ctx.fakeMetrics!.increment).toHaveBeenCalledWith(
      "events.random.missing",
    );

    expect(ctx.fakeIdempotency.getCalls().set![0]).toMatchObject({
      key: createIdempotencyKey({
        scope: "get-random-event",
        idempotencyKey: "missing",
      }),
      data: {
        status: "error",
        error: {
          type: "NoRandomEventAvailableError",
        },
      },
    });
  });

  it("requests events from geo bounds when human city is provided", async () => {
    ctx.fakeGeo.setPrototypes({
      randomPoint: async ({ bounds, offsetKm }) => {
        expect(bounds).toEqual({
          northEast: { lat: 0.1, lng: 0.1 },
          southWest: { lat: -0.1, lng: -0.1 },
        });
        expect(offsetKm).toBe(10);
        return { lat: 0.05, lng: 0.05 };
      },
      expandBounds: async ({ geoHash, maxDistanceKm }) => {
        expect(geoHash).toBe("9q8yy");
        expect(maxDistanceKm).toBe(50);
        return {
          northEast: { lat: 0.1, lng: 0.1 },
          southWest: { lat: -0.1, lng: -0.1 },
        };
      },
      distanceBetween: async ({ from, to }) => {
        expect(from).toEqual({ lat: 0.05, lng: 0.05 });
        expect(to).toEqual({ lat: 0.25, lng: 0.25 });
        return fiveKmInMeters;
      },
      haversineDistance: () => fiveKmInMeters,
    });

    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async ({
        origin,
        maxDistanceMeters,
        maxResults,
      }) => {
        expect(origin).toEqual({ lat: 0.05, lng: 0.05 });
        expect(maxDistanceMeters).toBe(50 * 1000 + fiveKmInMeters);
        expect(maxResults).toBe(15);
        return [];
      },
    });

    await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "client-key",
      input: {
        humanCountryCode: "US",
        humanRegionCode: "CA",
        humanCityGeoHash: "9q8yy",
        offsetKm: 10,
        maxDistanceKm: 50,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 30 }).toISO(),
        },
        now: IthasFireDate.utc().toISO(),
      },
    }).catch(() => undefined);
  });

  it("falls back to search port when no events found", async () => {
    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async () => [],
    });

    ctx.fakeSearch.setPrototypes({
      searchEvents: async ({ limit, filters }) => {
        expect(limit).toBe(20);
        expect(filters?.countryCodes).toEqual(["US"]);
        return {
          items: [
            {
              id: "event-3",
              name: "Event 3",
              startDate: IthasFireDate.utc().plus({ days: 3 }).toISO(),
              endDate: IthasFireDate.utc().plus({ days: 3, hours: 2 }).toISO(),
              venue: {
                location: {
                  lat: 0.01,
                  lng: 0.01,
                },
                countryCode: "US",
              },
            },
          ],
          nextCursor: undefined,
        };
      },
    });

    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async () => [],
    });

    const event = await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "fallback",
      input: {
        humanCountryCode: "US",
        humanRegionCode: null,
        humanCityGeoHash: null,
        offsetKm: 0,
        maxDistanceKm: 20,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 14 }).toISO(),
        },
        now: IthasFireDate.utc().toISO(),
      },
    });

    expect(event).toMatchObject({ id: "event-3" });
    expect(ctx.fakeMetrics!.increment).toHaveBeenCalledWith(
      "events.random.success",
    );
  });

  it("throws NoRandomEventAvailableError when no events found anywhere", async () => {
    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async () => [],
    });

    ctx.fakeSearch.setPrototypes({
      searchEvents: async () => ({ items: [], nextCursor: undefined }),
    });

    const result = await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "none",
      input: {
        humanCountryCode: "US",
        humanRegionCode: null,
        humanCityGeoHash: null,
        offsetKm: 0,
        maxDistanceKm: 20,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 14 }).toISO(),
        },
        now: IthasFireDate.utc().toISO(),
      },
    }).catch((error: IthasFireError) => error);

    expect(result).toBeInstanceOf(NoRandomEventAvailableError);
    expect(ctx.fakeMetrics!.increment).toHaveBeenCalledWith(
      "events.random.missing",
    );
  });

  it("validates input using schema", async () => {
    const schema = getRandomEvent(ctx.dependencies).schema.input;

    expect(schema).toBeInstanceOf(z.ZodType);
    await expect(
      schema.parseAsync({
        humanCountryCode: "US",
        humanRegionCode: "CA",
        humanCityGeoHash: null,
        offsetKm: 0,
        maxDistanceKm: 20,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 14 }).toISO(),
        },
        now: null,
      }),
    ).resolves.toBeTruthy();
  });

  it("ensures standard error wrapping with use-case factory", async () => {
    ctx.fakeRepos.eventsRepo.setPrototypes({
      searchActivePublishedEvents: async () => {
        throw new Error("boom");
      },
    });

    const result = await getRandomEvent(ctx.dependencies)({
      idempotencyKey: "error",
      input: {
        humanCountryCode: "US",
        humanRegionCode: null,
        humanCityGeoHash: null,
        offsetKm: 0,
        maxDistanceKm: 20,
        timeWindow: {
          from: IthasFireDate.utc().toISO(),
          to: IthasFireDate.utc().plus({ days: 14 }).toISO(),
        },
        now: IthasFireDate.utc().toISO(),
      },
    }).catch((error: IthasFireError) => error);

    expect(result).toBeInstanceOf(IthasFireError);
    expect(result.code).toBe("internal_error");
  });

  it("creates deterministic idempotency key", () => {
    const key = createIdempotencyKey({
      scope: "get-random-event",
      idempotencyKey: "client-key",
    });

    expect(key).toBe("get-random-event:client-key");
  });
});
