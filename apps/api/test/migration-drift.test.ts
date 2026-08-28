import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import health from "../src/routes/health";
import {
  staticMigrationDriftMonitor,
  type MigrationDriftResult,
} from "@th/adapters/infra/migration-drift";

/**
 * The drift CHECK itself lives in `@th/adapters/infra/migration-drift` and is
 * unit-tested there (packages/adapters/src/infra/__tests__/migration-drift.test.ts)
 * because both `apps/api` and `apps/jobs` consume it. What is tested here is the
 * API's own wiring: how `/health` translates a verdict into a status code.
 */
async function healthApp(
  migrationDrift?: MigrationDriftResult,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    health,
    migrationDrift
      ? { migrationDrift: staticMigrationDriftMonitor(migrationDrift) }
      : {},
  );
  await app.ready();
  return app;
}

describe("api /health route", () => {
  it("returns 200 {ok:true} when there is no drift", async () => {
    const app = await healthApp({ status: "ok" });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it("returns 503 naming the pending migrations when drift is confirmed AND enforced", async () => {
    const app = await healthApp({
      status: "drift",
      pending: ["20260724120000_attendee_review_community_and_place_optin"],
      enforced: true,
    });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "migration_drift",
      pendingMigrations: [
        "20260724120000_attendee_review_community_and_place_optin",
      ],
    });
    expect(response.json().message).toContain("pnpm db:migrate:deploy");
    // The Cloud Monitoring uptime check matches on the `"ok":true` substring —
    // the drift body must not contain it.
    expect(response.body).not.toContain('"ok":true');
    await app.close();
  });

  it("stays 200 on unenforced drift so the local dev stack is not torn down", async () => {
    // scripts/human-dev.cjs's waitForApi() only accepts 200-399 and hard-exits
    // the whole stack after 90s. A dev whose local DB is one migration behind
    // must still get a working `pnpm dev` — they get the loud boot log instead.
    const app = await healthApp({
      status: "drift",
      pending: ["20260726120000_pos_readers"],
      enforced: false,
    });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it.each([
    "migrations_dir_missing",
    "migrations_table_missing",
    "query_failed",
  ] as const)(
    "stays healthy when the check was indeterminate (%s)",
    async (reason) => {
      const app = await healthApp({ status: "unknown", reason });
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      await app.close();
    },
  );

  it("stays healthy when no drift verdict was supplied at all", async () => {
    const app = await healthApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
