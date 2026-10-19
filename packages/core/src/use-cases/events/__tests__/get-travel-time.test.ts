import { describe, expect, it, vi } from "vitest";

import type { RoutingPort } from "@th/ports/routing.port";

import { getTravelTime } from "../get-travel-time";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeRouting(overrides: Partial<RoutingPort> = {}): RoutingPort {
  return {
    getRoute: vi.fn().mockResolvedValue({
      timeSeconds: 1800,
      distanceMeters: 25_000,
      geometry: "encoded_shape",
    }),
    health: vi.fn().mockResolvedValue({ ok: true, backend: "valhalla" }),
    ...overrides,
  };
}

const ORIGIN = { lat: 40.7128, lng: -74.006 };
const DESTINATION = { lat: 40.758, lng: -73.9855 };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getTravelTime", () => {
  it("returns travel time and distance when routing is available", async () => {
    const routing = fakeRouting();

    const result = await getTravelTime(
      { routing },
      { origin: ORIGIN, destination: DESTINATION },
    );

    expect(result).toEqual({
      available: true,
      timeSeconds: 1800,
      distanceMeters: 25_000,
      mode: "auto",
    });

    expect(routing.getRoute).toHaveBeenCalledWith({
      origin: ORIGIN,
      destination: DESTINATION,
      mode: "auto",
    });
  });

  it("defaults to auto mode", async () => {
    const routing = fakeRouting();

    const result = await getTravelTime(
      { routing },
      { origin: ORIGIN, destination: DESTINATION },
    );

    expect(result.mode).toBe("auto");
  });

  it("supports bicycle mode", async () => {
    const routing = fakeRouting();

    const result = await getTravelTime(
      { routing },
      { origin: ORIGIN, destination: DESTINATION, mode: "bicycle" },
    );

    expect(result.available).toBe(true);
    expect(result.mode).toBe("bicycle");
    expect(routing.getRoute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "bicycle" }),
    );
  });

  it("supports pedestrian mode", async () => {
    const routing = fakeRouting();

    const result = await getTravelTime(
      { routing },
      { origin: ORIGIN, destination: DESTINATION, mode: "pedestrian" },
    );

    expect(result.available).toBe(true);
    expect(result.mode).toBe("pedestrian");
  });

  it("returns available: false when routing port is null", async () => {
    const result = await getTravelTime(
      { routing: null },
      { origin: ORIGIN, destination: DESTINATION },
    );

    expect(result).toEqual({
      available: false,
      timeSeconds: null,
      distanceMeters: null,
      mode: "auto",
    });
  });

  it("returns available: false when routing port is undefined", async () => {
    const result = await getTravelTime(
      {},
      { origin: ORIGIN, destination: DESTINATION, mode: "bicycle" },
    );

    expect(result).toEqual({
      available: false,
      timeSeconds: null,
      distanceMeters: null,
      mode: "bicycle",
    });
  });

  it("returns available: false when getRoute returns null (service down)", async () => {
    const routing = fakeRouting({
      getRoute: vi.fn().mockResolvedValue(null),
    });

    const result = await getTravelTime(
      { routing },
      { origin: ORIGIN, destination: DESTINATION },
    );

    expect(result).toEqual({
      available: false,
      timeSeconds: null,
      distanceMeters: null,
      mode: "auto",
    });
  });

  it("throws on invalid input (lat out of range)", async () => {
    const routing = fakeRouting();

    await expect(
      getTravelTime(
        { routing },
        { origin: { lat: 999, lng: -74.006 }, destination: DESTINATION },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws on missing destination", async () => {
    const routing = fakeRouting();

    await expect(
      getTravelTime({ routing }, { origin: ORIGIN }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
