import { describe, expect, it, vi } from "vitest";

import { resolveTimezone } from "../resolve-timezone";

/**
 * `places.resolveTimezone` — the read-only lat/lng → IANA lookup the event
 * editor uses to adopt a freeform address's zone (venue-hierarchy FR-004).
 *
 * It must never throw for a caller: every degraded path (no port, no answer,
 * a throwing library) returns `{ timezone: null }` so the UI keeps whatever
 * zone it already has instead of being handed a wrong one.
 */
describe("resolveTimezone", () => {
  it("returns the port's answer for resolvable coordinates", async () => {
    const timezoneLookup = vi.fn(() => "America/New_York");

    await expect(
      resolveTimezone({ timezoneLookup }, { lat: 40.7182, lng: -73.9884 }),
    ).resolves.toEqual({ timezone: "America/New_York" });
    expect(timezoneLookup).toHaveBeenCalledWith(40.7182, -73.9884);
  });

  it("returns null when the lookup has no answer", async () => {
    await expect(
      resolveTimezone({ timezoneLookup: () => null }, { lat: 0, lng: -160 }),
    ).resolves.toEqual({ timezone: null });
  });

  it("returns null when no port is wired", async () => {
    await expect(
      resolveTimezone({ timezoneLookup: null }, { lat: 40.7, lng: -73.9 }),
    ).resolves.toEqual({ timezone: null });
  });

  it("swallows a THROWING lookup, reports it, and still answers null", async () => {
    const boom = new Error("invalid latitude");
    const reportError = vi.fn();

    await expect(
      resolveTimezone(
        {
          timezoneLookup: () => {
            throw boom;
          },
          reportError,
        },
        { lat: 40.7, lng: -73.9 },
      ),
    ).resolves.toEqual({ timezone: null });

    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "resolveTimezone", stage: "timezone_lookup" },
      }),
    );
  });

  it("survives a throwing reporter", async () => {
    await expect(
      resolveTimezone(
        {
          timezoneLookup: () => {
            throw new Error("invalid latitude");
          },
          reportError: () => {
            throw new Error("sentry is down");
          },
        },
        { lat: 40.7, lng: -73.9 },
      ),
    ).resolves.toEqual({ timezone: null });
  });

  it("rejects out-of-range coordinates at the boundary", async () => {
    await expect(
      resolveTimezone({ timezoneLookup: () => "X" }, { lat: 991, lng: -73.9 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown keys (strict input)", async () => {
    await expect(
      resolveTimezone(
        { timezoneLookup: () => "America/New_York" },
        { lat: 40.7, lng: -73.9, placeId: "nope" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
