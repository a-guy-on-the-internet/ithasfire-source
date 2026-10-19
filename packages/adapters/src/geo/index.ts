import type { PrismaClient } from "@prisma/client";
import type { Pool } from "pg";
import { createGeoError, GeoPort, isGeoError } from "@th/ports/geo";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import { DbGeoAdapter } from "./db-geo-adapter";
import { PostGISGeoAdapter } from "./postgis-geo-adapter";

export { PostGISGeoAdapter, DbGeoAdapter };

type GeoBackendEnv = "postgis" | "geohash" | "db" | string | undefined;

type GeoPortFactory = () => Promise<GeoPort>;

export interface CreateGeoAdapterOptions {
  db: PrismaClient | Pool;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  backendEnv?: GeoBackendEnv;
  fallbackFactory?: () => GeoPort | Promise<GeoPort>;
}

function isPrismaClient(db: PrismaClient | Pool): db is PrismaClient {
  return typeof (db as PrismaClient).$queryRaw === "function";
}

async function makeDefaultFallback(
  options: CreateGeoAdapterOptions,
): Promise<GeoPort> {
  if (!isPrismaClient(options.db)) {
    throw createGeoError(
      "dependency_failed",
      "DB geo adapter requires a PrismaClient instance",
    );
  }

  return new DbGeoAdapter(options.db, {
    logger: options.logger,
    metrics: options.metrics,
  });
}

export async function createGeoAdapter(
  options: CreateGeoAdapterOptions,
): Promise<GeoPort> {
  const backend = (options.backendEnv ?? "postgis").toLowerCase();
  const fallbackFactory: GeoPortFactory = options.fallbackFactory
    ? async () => await options.fallbackFactory!()
    : () => makeDefaultFallback(options);

  if (backend === "postgis") {
    const adapter = new PostGISGeoAdapter(options.db, {
      logger: options.logger,
      metrics: options.metrics,
    });

    const health = await adapter.health();
    if (health.ok) {
      return adapter;
    }

    // WARN, not error — failing the PostGIS health check is a known soft
    // fallback path; the line below logs the actual decision to switch to
    // the DB backend. Logging as error here would surface every dev/prod
    // cold boot in Sentry (via pinoIntegration) as an exception, even
    // though the service recovers cleanly.
    options.logger?.warn("PostGIS backend failed health check", {
      reason: health.reason,
      backend,
    });

    try {
      options.logger?.warn("Falling back to DB geo backend", {
        backend,
        fallback: "db",
      });
      return await fallbackFactory();
    } catch (fallbackError) {
      options.logger?.error("Geo fallback initialization failed", {
        error: fallbackError,
      });
      if (isGeoError(fallbackError)) {
        throw fallbackError;
      }
      const message =
        (fallbackError as Error)?.message ??
        health.reason ??
        "postgis_unavailable";
      throw createGeoError("dependency_failed", message);
    }
  }

  if (backend === "geohash" || backend === "db") {
    return await fallbackFactory();
  }

  throw createGeoError(
    "dependency_failed",
    `Unsupported GEO_BACKEND '${backend}'`,
  );
}
