import { afterEach, describe, expect, it, vi } from "vitest";

import { ValhallaRoutingAdapter } from "../valhalla-adapter";

// ── Fake Valhalla responses ──────────────────────────────────────────────────

const ROUTE_RESPONSE = {
  trip: {
    legs: [
      {
        summary: { time: 1234, length: 15.6 },
        shape: "encoded_polyline_here",
      },
    ],
    summary: { time: 1234, length: 15.6 },
    status: 0,
    status_message: "Found route between points",
  },
};

const STATUS_RESPONSE = {
  version: "3.5.1",
  tileset_last_modified: 1710000000,
  has_tiles: true,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE = "http://valhalla-test:8002";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ValhallaRoutingAdapter", () => {
  const adapter = new ValhallaRoutingAdapter({ valhallaUrl: BASE });

  // ── getRoute ─────────────────────────────────────────────────────────

  describe("getRoute", () => {
    it("returns time, distance, and geometry for a valid request", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(ROUTE_RESPONSE)),
      );

      const result = await adapter.getRoute({
        origin: { lat: 40.7128, lng: -74.006 },
        destination: { lat: 40.758, lng: -73.9855 },
        mode: "auto",
      });

      expect(result).not.toBeNull();
      expect(result!.timeSeconds).toBe(1234);
      expect(result!.distanceMeters).toBe(15_600);
      expect(result!.geometry).toBe("encoded_polyline_here");

      // Verify fetch was called with correct URL & method
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe(`${BASE}/route`);
      expect((init as RequestInit).method).toBe("POST");
    });

    it("defaults to 'auto' mode when mode is omitted", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(ROUTE_RESPONSE)),
      );

      const result = await adapter.getRoute({
        origin: { lat: 40.7128, lng: -74.006 },
        destination: { lat: 40.758, lng: -73.9855 },
      });

      expect(result).not.toBeNull();
      expect(result!.timeSeconds).toBe(1234);

      // Should have sent "auto" as costing
      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.costing).toBe("auto");
    });

    it("returns null when the Valhalla service returns an error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ error: "server_error" }, 500)),
      );

      const result = await adapter.getRoute({
        origin: { lat: 40.7128, lng: -74.006 },
        destination: { lat: 40.758, lng: -73.9855 },
      });

      expect(result).toBeNull();
    });

    it("returns null when VALHALLA_URL is not configured", async () => {
      const unconfigured = new ValhallaRoutingAdapter({});
      const result = await unconfigured.getRoute({
        origin: { lat: 40.7128, lng: -74.006 },
        destination: { lat: 40.758, lng: -73.9855 },
      });

      expect(result).toBeNull();
    });

    it("throws on invalid input coordinates", async () => {
      await expect(
        adapter.getRoute({
          origin: { lat: 999, lng: -74.006 },
          destination: { lat: 40.758, lng: -73.9855 },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("supports bicycle and pedestrian modes", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(ROUTE_RESPONSE)),
      );

      for (const mode of ["bicycle", "pedestrian"] as const) {
        const result = await adapter.getRoute({
          origin: { lat: 40.7128, lng: -74.006 },
          destination: { lat: 40.758, lng: -73.9855 },
          mode,
        });
        expect(result).not.toBeNull();
      }
    });

    it("returns null when fetch throws (network error)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const result = await adapter.getRoute({
        origin: { lat: 40.7128, lng: -74.006 },
        destination: { lat: 40.758, lng: -73.9855 },
      });

      expect(result).toBeNull();
    });
  });

  // ── health ───────────────────────────────────────────────────────────

  describe("health", () => {
    it("returns ok when tiles are loaded", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(STATUS_RESPONSE)),
      );

      const status = await adapter.health();
      expect(status).toEqual({
        ok: true,
        reason: undefined,
        backend: "valhalla",
      });
    });

    it("returns not-ok when tiles are missing", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ ...STATUS_RESPONSE, has_tiles: false }),
          ),
      );

      const status = await adapter.health();
      expect(status.ok).toBe(false);
      expect(status.reason).toContain("no tiles");
    });

    it("returns not-ok when the service is unreachable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const status = await adapter.health();
      expect(status.ok).toBe(false);
      expect(status.backend).toBe("valhalla");
    });

    it("returns not-ok when VALHALLA_URL is not configured", async () => {
      const unconfigured = new ValhallaRoutingAdapter({});
      const status = await unconfigured.health();
      expect(status).toEqual({
        ok: false,
        reason: "VALHALLA_URL not configured",
        backend: "valhalla",
      });
    });

    it("returns not-ok when status endpoint returns non-2xx", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ error: "internal" }, 503)),
      );

      const status = await adapter.health();
      expect(status.ok).toBe(false);
      expect(status.reason).toContain("503");
    });
  });
});
