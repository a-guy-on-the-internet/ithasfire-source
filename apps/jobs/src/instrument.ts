/**
 * Sentry instrumentation for the jobs service.
 *
 * This file MUST be imported before any other modules so the SDK can
 * monkey-patch Node built-ins for automatic instrumentation. Mirrors
 * `apps/api/src/instrument.ts` but kept minimal — the jobs service has no
 * inbound user traffic, so the bot filtering and Fastify request
 * integrations the API carries are unnecessary here.
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
 *
 * NOTE for anyone reading span counts downstream: Sentry records the
 * effective rate on each trace as `client_sample_rate`, so absolute event
 * volume is `observed / client_sample_rate`. Ratios *between* spans in the
 * same transaction are unaffected by sampling and need no correction.
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

    // 100 % in dev, 10 % in production — same convention as the API.
    //
    // Overridable via SENTRY_TRACES_SAMPLE_RATE so a resource-burn
    // investigation can temporarily raise this service to 1.0 and read exact
    // span counts, then dial back. See `[skill:resource-burn]`.
    //
    // Why an override rather than just sampling jobs at 100 % permanently:
    // pinning 1.0 risks trading a Redis quota problem for a Sentry transaction
    // quota problem. Raise it deliberately, for a bounded window, when exact
    // numbers are needed.
    //
    // Measured 2026-07-30: the EFFECTIVE multiplier is ≈1 anyway — observed
    // span counts matched the manifest's cron schedule (3,380 observed vs
    // ~3,591 schedulable runs/day), so counts here already read as true counts
    // despite the 0.1 config. Re-verify with that same known-rate comparison
    // before relying on it; see `docs/ops/resource-burn.md`.
    tracesSampleRate: resolveTracesSampleRate(),
  });
}

export { Sentry };
