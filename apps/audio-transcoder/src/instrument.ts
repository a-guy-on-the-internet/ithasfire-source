/**
 * Sentry instrumentation for the audio-transcoder service.
 *
 * This file MUST be imported before any other module so the SDK can
 * monkey-patch Node built-ins for automatic instrumentation. Mirrors
 * `apps/jobs/src/instrument.ts` — like jobs, this service has no inbound user
 * traffic (Pub/Sub push and a direct-invoke debug route), so the bot filtering
 * and Fastify request integrations the API carries are unnecessary here.
 *
 * NOTE on local dev: `src/index.ts` loads `.env.local` via dotenv AFTER this
 * module has already run (static imports hoist above the dynamic ones). That is
 * correct for production — Cloud Run puts SENTRY_DSN in the real environment
 * before the process starts — but it means a DSN that lives only in
 * `.env.local` will not be picked up locally. Export it in your shell if you
 * need to exercise Sentry against a local transcoder.
 */
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

/**
 * Effective traces sample rate.
 *
 * Precedence: `SENTRY_TRACES_SAMPLE_RATE` (when a finite number in [0, 1]) →
 * environment default (0.1 in production, 1.0 elsewhere). An unparseable or
 * out-of-range value falls back to the default rather than throwing —
 * instrumentation must never be the reason a service fails to boot.
 */
export function resolveTracesSampleRate(): number {
  const fallback = process.env.NODE_ENV === "production" ? 0.1 : 1.0;
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

if (dsn) {
  Sentry.init({
    dsn,

    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",

    integrations: [
      // `CLAUDE.md` states that `logger.error(msg, { err })` rides the pino
      // backstop. That was only ever true for the API, which is the sole
      // service that configured this integration — so in THIS service every
      // `logger.error` was dark. That is not a theoretical gap: it covers
      // `db_update_failed` in transcode-audio.ts (HLS uploaded, DB row never
      // updated, upload stuck in TRANSCODING forever, route still returns 200),
      // plus `pubsub_decode_failed` and `pubsub_validation_failed`, which each
      // drop a message permanently at 400 with no retry and no DLQ.
      //
      // The container's logger is pino (`createPinoLoggerAdapter`), so this
      // makes the documented contract actually true here.
      Sentry.pinoIntegration({
        error: { levels: ["error", "fatal"], handled: true },
      }),
    ],

    // 100 % in dev, 10 % in production — same convention as the API and jobs.
    //
    // Transcode volume is low (one span per upload, not per request), so the
    // production rate is conservative rather than load-driven. Raise it via
    // SENTRY_TRACES_SAMPLE_RATE for a bounded window when exact counts are
    // needed; see `[skill:resource-burn]`.
    tracesSampleRate: resolveTracesSampleRate(),
  });
}

export { Sentry };
