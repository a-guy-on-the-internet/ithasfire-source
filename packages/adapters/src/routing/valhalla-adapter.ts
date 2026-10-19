import {
  createRoutingError,
  routeRequestSchema,
  type RouteRequest,
  type RouteResult,
  type RoutingHealthStatus,
  type RoutingPort,
} from "@th/ports/routing.port";
import type { LoggerPort } from "@th/ports/logger";

// ── Valhalla response shapes (subset we care about) ─────────────────────────

interface ValhallaLeg {
  summary: {
    time: number; // seconds
    length: number; // kilometres
  };
  shape?: string;
}

interface ValhallaRouteResponse {
  trip: {
    legs: ValhallaLeg[];
    summary: {
      time: number;
      length: number;
    };
    status: number;
    status_message: string;
  };
}

interface ValhallaStatusResponse {
  version?: string;
  tileset_last_modified?: number;
  has_tiles?: boolean;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface CreateRoutingAdapterOptions {
  /** Full base URL of the Valhalla service, e.g. "http://localhost:8002". */
  valhallaUrl?: string;
  logger?: LoggerPort;
  /** Request timeout in milliseconds (default: 5 000). */
  timeoutMs?: number;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

const VALHALLA_COSTING: Record<string, string> = {
  auto: "auto",
  bicycle: "bicycle",
  pedestrian: "pedestrian",
};

export class ValhallaRoutingAdapter implements RoutingPort {
  private readonly baseUrl: string | null;
  private readonly logger?: LoggerPort;
  private readonly timeoutMs: number;

  constructor(options: CreateRoutingAdapterOptions = {}) {
    this.baseUrl = options.valhallaUrl?.replace(/\/+$/, "") ?? null;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async getRoute(request: RouteRequest): Promise<RouteResult | null> {
    if (!this.baseUrl) {
      this.logger?.warn(
        "RoutingPort: VALHALLA_URL not configured, returning null",
      );
      return null;
    }

    const parsed = routeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw createRoutingError("invalid_input", parsed.error.message);
    }

    const { origin, destination, mode } = parsed.data;
    const costing = VALHALLA_COSTING[mode] ?? "auto";

    const body = {
      locations: [
        { lat: origin.lat, lon: origin.lng },
        { lat: destination.lat, lon: destination.lng },
      ],
      costing,
      directions_options: { units: "kilometers" },
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(`${this.baseUrl}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        this.logger?.warn("Valhalla /route returned non-2xx", {
          status: response.status,
          body: text.slice(0, 300),
        });
        return null;
      }

      const data = (await response.json()) as ValhallaRouteResponse;
      const trip = data.trip;

      return {
        timeSeconds: Math.round(trip.summary.time),
        distanceMeters: Math.round(trip.summary.length * 1_000), // km → m
        geometry: trip.legs[0]?.shape ?? undefined,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.logger?.warn("Valhalla /route timed out", {
          timeoutMs: this.timeoutMs,
        });
      } else {
        this.logger?.warn("Valhalla /route fetch error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }

  async health(): Promise<RoutingHealthStatus> {
    if (!this.baseUrl) {
      return {
        ok: false,
        reason: "VALHALLA_URL not configured",
        backend: "valhalla",
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);

      const response = await fetch(`${this.baseUrl}/status`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        return {
          ok: false,
          reason: `status endpoint returned ${response.status}`,
          backend: "valhalla",
        };
      }

      const data = (await response.json()) as ValhallaStatusResponse;
      return {
        ok: data.has_tiles !== false,
        reason: data.has_tiles === false ? "no tiles loaded" : undefined,
        backend: "valhalla",
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        backend: "valhalla",
      };
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a RoutingPort backed by Valhalla.
 *
 * When `VALHALLA_URL` is not set the adapter still instantiates but every
 * `getRoute` call returns `null` — the feature degrades silently.
 */
export function createRoutingAdapter(
  options: CreateRoutingAdapterOptions = {},
): RoutingPort {
  const valhallaUrl = options.valhallaUrl ?? process.env.VALHALLA_URL;
  return new ValhallaRoutingAdapter({ ...options, valhallaUrl });
}
