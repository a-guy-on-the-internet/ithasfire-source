/**
 * Audio Transcoder Service Entry Point
 *
 * A minimal Fastify service that transcodes audio files from MP3 to HLS.
 *
 * Routes:
 * - GET  /health          - Health check (includes FFmpeg availability)
 * - GET  /health/detailed - Detailed health with FFmpeg version
 * - POST /pubsub/push     - Pub/Sub push handler (primary trigger)
 * - POST /transcode       - Direct invoke (for testing)
 *
 * Triggered by:
 * - Pub/Sub push subscription (production)
 * - Direct HTTP calls (testing/debugging)
 */

// Mark as ES module for top-level await
export {};

const isProd = process.env.NODE_ENV === "production";

if (!isProd) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: ".env.local", override: true });
    dotenv.config({
      path: "../../.env.local",
      override: !process.env.DATABASE_URL,
    });
  } catch {
    // dotenv is optional in prod
  }
}

const { createApp } = await import("./app");
const { env } = await import("./lib/env");

const port = env.PORT;
const host = env.HOST;

async function main() {
  const { app, container } = await createApp();
  const logger = container.logger;

  const shutdown = async (signal: string) => {
    logger.warn("transcoder_shutdown_requested", { signal });
    try {
      await app.close();
      logger.info("transcoder_shutdown_complete", { signal });
    } catch (err) {
      logger.error("transcoder_shutdown_failed", { err, signal });
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
    // Log FFmpeg availability at startup
    const ffmpegAvailable = await container.transcoder.isAvailable();
    if (!ffmpegAvailable) {
      logger.error("ffmpeg_not_available", {
        hint: "FFmpeg is required for transcoding. Install it or check FFMPEG_PATH env var.",
      });
    } else {
      const version = await container.transcoder.getVersion();
      logger.info("ffmpeg_available", { version });
    }

    await app.listen({ port, host });
    logger.info("transcoder_server_started", { port, host });
  } catch (err) {
    logger.error("transcoder_server_failed", { err });
    process.exit(1);
  }
}

main();
