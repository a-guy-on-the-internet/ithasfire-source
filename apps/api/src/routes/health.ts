import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import {
  APPLY_MIGRATIONS_HINT,
  listPendingMigrations,
  type MigrationDriftMonitor,
} from "@th/adapters/infra/migration-drift";

export type HealthPluginOptions = {
  /**
   * Migration-drift monitor built in `createApp()`.
   *
   * Caching is asymmetric (see `createMigrationDriftMonitor`): an `ok` verdict
   * is permanent so the probe stays free, while `drift`/`unknown` are
   * re-queried on a short interval so a container that booted during a
   * mid-deploy migration window recovers instead of replaying a stale 503 for
   * its whole startup budget.
   *
   * Omitted, or an `unknown` verdict, means "could not determine", which is
   * deliberately reported as HEALTHY. Only a CONFIRMED and ENFORCED drift
   * blocks.
   */
  migrationDrift?: MigrationDriftMonitor;
};

/**
 * Liveness/startup probe.
 *
 * Returns 503 when the running image contains migrations the database has not
 * applied AND the drift verdict is enforced (deployed environments only — see
 * `shouldBlockOnDrift`). On Cloud Run the startup probe hits this path, so a
 * revision deployed onto a stale schema fails its probe and is never promoted
 * to serve traffic — making the "P2022: column does not exist" class of outage
 * structurally impossible regardless of how the deploy happened.
 *
 * Unenforced drift — a developer's laptop, or the `MIGRATION_DRIFT_ENFORCE`
 * break-glass — still logs loudly and reports to Sentry at boot, but keeps
 * returning 200: `scripts/human-dev.cjs`'s `waitForApi` gates the entire local
 * stack on this endpoint and hard-exits after its 90s budget, so a 503 there
 * would kill API, jobs, Stripe and web with a misleading timeout message.
 *
 * The 503 body deliberately does NOT contain `"ok":true`: the Cloud Monitoring
 * uptime check (infra/terraform/monitoring.tf) asserts on that substring, so
 * drift also trips the existing alert without any infra change.
 */
const plugin: FastifyPluginAsync<HealthPluginOptions> = async (app, opts) => {
  const monitor = opts.migrationDrift;

  app.get("/health", async (_request, reply) => {
    const drift = await monitor?.get();

    if (drift?.status === "drift" && drift.enforced) {
      return reply.code(503).send({
        ok: false,
        error: "migration_drift",
        message:
          "Database is missing migrations this build requires. Apply them " +
          `(\`${APPLY_MIGRATIONS_HINT}\`), then redeploy.`,
        pendingCount: drift.pending.length,
        // Bounded: an empty database yields ~100 names, and this body is
        // fetched by every probe. The full list is in the boot log.
        pendingMigrations: listPendingMigrations(drift.pending),
      });
    }

    return { ok: true };
  });
};

export default fp(plugin);
