import fs from "node:fs";

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { POOL_TUNING } from "./pool-config";

export { POOL_TUNING } from "./pool-config";

type PrismaEventClient = PrismaClient & {
  $on(event: "query", cb: (event: Prisma.QueryEvent) => void): void;
  $on(event: "error" | "warn", cb: (event: Prisma.LogEvent) => void): void;
};

let prismaSingleton: PrismaClient | null = null;

export const getPrisma = (): PrismaClient => {
  if (!prismaSingleton) {
    const debugQueries = process.env.DEBUG_PRISMA_QUERIES === "1";
    const debugQueryParams = process.env.DEBUG_PRISMA_QUERY_PARAMS === "1";

    // Prisma 5+/7+ can run in a "client" (driver adapter) engine mode.
    // If that mode is enabled (e.g. via env / build), Prisma requires an
    // explicit adapter. Without it, Better Auth will 500 during sign-up.
    //
    // We always have a DATABASE_URL in the API. For E2E/local runs, create
    // a pg Pool and hand Prisma a pg adapter.
    const rawDatabaseUrl = process.env.DATABASE_URL;
    if (!rawDatabaseUrl) {
      throw new Error("DATABASE_URL is required to initialize Prisma");
    }

    // `pg` is picky about the password type: it must be a string.
    // Some environments (or redacted env injection) can end up with
    // an undefined password, which triggers:
    //   SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
    // Normalizing via URL parsing keeps behavior consistent across runtimes.
    type PoolConfig = NonNullable<ConstructorParameters<typeof Pool>[0]>;
    let poolConfig: PoolConfig = { connectionString: rawDatabaseUrl };
    try {
      const u = new URL(rawDatabaseUrl);
      const sslMode = u.searchParams.get("sslmode");

      // Build SSL config that actually validates certificates by default.
      // - sslmode=require / verify-ca / verify-full → SSL on, verify certs.
      // - DATABASE_SSL_REJECT_UNAUTHORIZED=0 → opt-out escape hatch for
      //   environments where self-signed certs are expected (dev proxies, etc.).
      // - DATABASE_SSL_CA_PATH → optional path to a PEM CA bundle for
      //   managed Postgres providers (Neon, RDS, Cloud SQL).
      let ssl: PoolConfig["ssl"] | undefined;
      if (sslMode && sslMode !== "disable" && sslMode !== "prefer") {
        const rejectUnauthorized =
          process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "0";
        const caPath = process.env.DATABASE_SSL_CA_PATH;
        ssl = {
          rejectUnauthorized,
          ...(caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {}),
        };
      }

      poolConfig = {
        host: u.hostname,
        port: u.port ? Number.parseInt(u.port, 10) : undefined,
        database: u.pathname?.replace(/^\//, "") || undefined,
        user: u.username || undefined,
        password: String(u.password ?? ""),
        ssl,
      };
    } catch {
      // Fall back to connectionString behavior.
    }

    // `allowExitOnIdle` matters here and not in the long-lived services.
    // `getPrisma()` also backs one-shot CLI work (seed scripts, backfills),
    // and node-postgres keeps both the idle socket and its expiry timer
    // ref'd — so without this a finished script would sit for the full
    // `idleTimeoutMillis` before Node's event loop drained. Servers are
    // unaffected: their listening socket keeps the process alive regardless.
    const pool = new Pool({
      ...poolConfig,
      ...POOL_TUNING,
      allowExitOnIdle: true,
    });
    const adapter = new PrismaPg(pool);

    // Allow callers (e.g. seed scripts targeting remote Neon) to raise the
    // interactive transaction timeout beyond the 5 000 ms default.
    const txTimeout = process.env.PRISMA_TX_TIMEOUT
      ? Number.parseInt(process.env.PRISMA_TX_TIMEOUT, 10)
      : undefined;

    prismaSingleton = new PrismaClient({
      errorFormat: "minimal",
      adapter,
      ...(txTimeout
        ? { transactionOptions: { timeout: txTimeout, maxWait: txTimeout } }
        : {}),
      log: debugQueries
        ? [
            { emit: "event", level: "query" },
            { emit: "event", level: "error" },
            { emit: "event", level: "warn" },
          ]
        : undefined,
    });

    if (debugQueries) {
      const prismaLogger = prismaSingleton as PrismaEventClient;
      prismaLogger.$on("query", (e) => {
        // Intentionally use console.* so this shows up in detached logs.
        // eslint-disable-next-line no-console
        console.log("[prisma][query]", {
          query: e.query,
          params: debugQueryParams ? e.params : "[hidden]",
          durationMs: e.duration,
        });
      });
      prismaLogger.$on("error", (e) => {
        // eslint-disable-next-line no-console
        console.error("[prisma][error]", e);
      });
      prismaLogger.$on("warn", (e) => {
        // eslint-disable-next-line no-console
        console.warn("[prisma][warn]", e);
      });
    }
  }
  return prismaSingleton;
};

// Backwards-compatible export for existing imports.
//
// Important: this *does not* eagerly construct PrismaClient, because Next.js
// may evaluate server modules during `next build` (page data collection) even
// when no DB is configured.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return Reflect.get(getPrisma(), prop);
  },
});
