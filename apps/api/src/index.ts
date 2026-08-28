// Sentry must be imported before any other modules for auto-instrumentation.
import "./instrument";
// Same already-initialized client (side-effecting import above stays first);
// used to capture + flush fatal boot failures before the process exits.
import { Sentry } from "./instrument";

const isProd = process.env.NODE_ENV === "production";

async function main(createApp: typeof import("./app").createApp, env: typeof import("./lib/env").env) {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  const app = await createApp();
  const logger = app.deps.logger;
  // NOTE: E2E sign-up request logging lives in createApp() so it can run
  // after raw-body parsing and use the app's request logger.

  const shutdown = async (
    signal: NodeJS.Signals | "unhandledRejection" | "uncaughtException",
  ) => {
    logger.warn("api_shutdown_requested", { signal });
    try {
      await app.close();
      logger.info("api_shutdown_complete", { signal });
    } catch (err) {
      logger.error("api_shutdown_failed", { err, signal });
      throw err;
    }
  };

  const exitOn = (signal: NodeJS.Signals) => {
    process.on(signal, () => {
      void (async () => {
        try {
          await shutdown(signal);
          process.exit(0);
        } catch {
          process.exit(1);
        }
      })();
    });
  };

  exitOn("SIGINT");
  exitOn("SIGTERM");

  process.on("unhandledRejection", (err) => {
    logger.error("api_unhandled_rejection", { err });
  });

  process.on("uncaughtException", (err) => {
    logger.error("api_uncaught_exception", { err });
  });

  await app.listen({ port, host });
  logger.info("api_listening", { port, host, baseUrl: env.APP_BASE_URL });
}

/**
 * Single fatal-boot entrypoint. This wraps BOTH top-level module
 * initialization (non-prod dotenv loading + the dynamic `./app` / `./lib/env`
 * imports, either of which can throw — e.g. env zod parse fails at module
 * load) AND `main()` itself, so there is exactly ONE `.catch` covering every
 * boot-time failure. Without this, a throw during the top-level `import(...)`
 * would be an unhandled top-level-await rejection that kills the process
 * before anything is reported to Sentry.
 */
async function bootstrap() {
  if (!isProd) {
    try {
      const dotenv = await import("dotenv");
      // Repo convention: the *repo root* `.env.local` is the primary local env file.
      // However, `pnpm -F api dev` runs with CWD = apps/api, so we load both:
      // - apps/api/.env.local (API-only overrides)
      // - ../../.env.local (shared local defaults, including DATABASE_URL)
      //
      // NOTE: Use override:true for API local env so it takes precedence over
      // empty/stale shell env vars (e.g. STRIPE_WEBHOOK_SECRET="" from global shell config).
      // This is safe because the file is local-only and explicitly overrides shell env.
      dotenv.config({ path: ".env.local", override: true });
      dotenv.config({
        path: "../../.env.local",
        override: !process.env.DATABASE_URL,
      });
    } catch {
      // Optional dependency for local development; ignore if unavailable.
    }
  }

  // These imports run module-init side effects: `./lib/env` parses
  // `process.env` at load, so a bad/missing env var throws HERE and is caught
  // by the `.catch` below (not by the old `main().catch`, which never saw it).
  const [{ createApp }, { env }] = await Promise.all([
    import("./app"),
    import("./lib/env"),
  ]);

  await main(createApp, env);
}

bootstrap().catch(async (err) => {
  console.error("API failed to start", err);
  try {
    Sentry.captureException(err, { level: "fatal", tags: { phase: "boot" } });
    await Sentry.flush(2000);
  } catch {
    // Never let the reporting path make shutdown worse; fall through to exit.
  }
  process.exit(1);
});
