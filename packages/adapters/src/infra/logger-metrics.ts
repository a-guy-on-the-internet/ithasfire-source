import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";

/**
 * Minimal MetricsPort that bridges `increment` / `record` calls to the
 * structured logger.
 *
 * Why this is good enough for dev + early prod:
 *   - Every call lands as a structured log line, so it flows wherever
 *     logs already go (stdout, GCP Cloud Logging, Sentry breadcrumbs).
 *   - Counters and gauges show up alongside the use-case info logs they
 *     accompany — no separate dashboard needed to verify a code path
 *     fired.
 *   - When we want real metrics (Prometheus, OTel, StatsD), swap this
 *     adapter at `dep.ts` without touching a single use case.
 *
 * Log shape:
 *   info("metric", { name: "pos.cash_sale.recorded", kind: "increment", value: 1, tags: {...} })
 *   info("metric", { name: "ticket.scan.duration_ms", kind: "record", value: 142, tags: {...} })
 *
 * The fixed `metric` message keeps these grep-able and easy to filter
 * out of human-readable log views when noisy.
 */
export class LoggerMetricsAdapter implements MetricsPort {
  constructor(private readonly logger: LoggerPort) {}

  increment(name: string, tags?: Record<string, string>): void {
    this.logger.info("metric", {
      name,
      kind: "increment",
      value: 1,
      ...(tags ? { tags } : {}),
    });
  }

  record(name: string, value: number, tags?: Record<string, string>): void {
    this.logger.info("metric", {
      name,
      kind: "record",
      value,
      ...(tags ? { tags } : {}),
    });
  }
}
