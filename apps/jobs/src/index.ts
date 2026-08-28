/**
 * Jobs Service Entry Point
 *
 * A simple Fastify server that runs background jobs.
 *
 * Routes:
 * - GET  /health          - Health check
 * - GET  /jobs            - List all registered jobs
 * - POST /jobs/:name      - Run a job with the given payload
 *
 * Jobs are triggered by:
 * - Cloud Scheduler (for cron jobs)
 * - Pub/Sub push subscriptions (for queue jobs)
 * - Direct HTTP calls (for testing/debugging)
 */

// Sentry must be imported before any other modules for auto-instrumentation.
import "./instrument";

const isProd = process.env.NODE_ENV === "production";

if (!isProd) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: ".env.local", override: true });
    dotenv.config({
      path: "../../.env.local",
      override: !process.env.DATABASE_URL,
    });
    // Also load apps/api/.env.local for shared keys (STRIPE_SECRET_KEY, etc.)
    // that live in the API env. `override: false` means existing values win.
    dotenv.config({ path: "../api/.env.local", override: false });
  } catch {
    // dotenv is optional in prod
  }
}

const { createApp } = await import("./app");
const { env } = await import("./lib/env");

const port = env.PORT;
const host = process.env.HOST ?? "0.0.0.0";

async function main() {
  const { app, container } = await createApp();
  const logger = container.logger;

  const shutdown = async (signal: string) => {
    logger.warn("jobs_shutdown_requested", { signal });
    try {
      await app.close();
      logger.info("jobs_shutdown_complete", { signal });
    } catch (err) {
      logger.error("jobs_shutdown_failed", { err, signal });
      throw err;
    }
  };

  process.on(
    "SIGINT",
    () => void shutdown("SIGINT").then(() => process.exit(0)),
  );
  process.on(
    "SIGTERM",
    () => void shutdown("SIGTERM").then(() => process.exit(0)),
  );

  try {
    await app.listen({ port, host });
    logger.info("jobs_server_started", { port, host });
  } catch (err) {
    logger.error("jobs_server_failed", { err });
    process.exit(1);
  }
}

main();
