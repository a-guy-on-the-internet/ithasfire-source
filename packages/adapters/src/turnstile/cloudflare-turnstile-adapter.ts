import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TurnstilePort } from "@th/ports/turnstile";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Hard cap on how long a siteverify round-trip may take. Turnstile
 * verification sits inline on the embed guest-checkout path, so a hanging
 * siteverify would otherwise hold checkout requests open indefinitely. 5s is
 * generous for Cloudflare's edge (typ. <200ms) and matches the other
 * outbound-HTTP adapters (see `ziptax-adapter.ts`).
 */
const SITEVERIFY_TIMEOUT_MS = 5_000;

/**
 * Throttle window for Sentry reports during a sustained siteverify outage —
 * periodic breadcrumbs instead of one event per rejected checkout. Same
 * order of magnitude as `AUTH_RATE_LIMIT_REPORT_THROTTLE_MS` in
 * `apps/api/src/auth/rate-limit-storage.ts`, which handles the same class
 * of "dependency outage must not be invisible" problem.
 */
const SITEVERIFY_REPORT_THROTTLE_MS = 15 * 60 * 1000;

export interface CloudflareTurnstileAdapterOptions {
  secretKey: string;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter (wired to `Sentry.captureException`
   * at the composition root — see `apps/api/src/lib/dep.ts`). Fired,
   * throttled, whenever siteverify itself is unavailable — because this
   * adapter fails CLOSED, a siteverify outage means 100% of embed guest
   * checkouts are rejected, and without the reporter that outage is
   * invisible (the caller maps `false` to a 4xx that never reaches Sentry).
   */
  reportError?: ReporterPort;
  /** Test seam — overrides the 15-minute Sentry report throttle window. */
  reportThrottleMs?: number;
}

/**
 * Verifies Cloudflare Turnstile tokens via the siteverify API.
 *
 * Failure semantics: this adapter fails CLOSED (any siteverify failure ⇒
 * token rejected). That is the opposite of the auth rate limiter's fail-open
 * (`rate-limit-storage.ts`), and deliberate: for bot protection, sacrificing
 * availability of the guest-checkout embed during a Cloudflare outage is
 * acceptable, whereas silently waving bots through is not. The `reportError`
 * hook exists precisely so that availability sacrifice is visible instead of
 * masquerading as ordinary bot-rejection traffic.
 *
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation
 */
export class CloudflareTurnstileAdapter implements TurnstilePort {
  readonly enabled = true;
  private readonly secretKey: string;
  private readonly logger?: LoggerPort;
  private readonly reportFailure: ReporterPort;

  constructor(options: CloudflareTurnstileAdapterOptions) {
    if (!options.secretKey) {
      throw new Error(
        "CloudflareTurnstileAdapter requires a non-empty secret key",
      );
    }
    this.secretKey = options.secretKey;
    this.logger = options.logger;
    this.reportFailure = createThrottledReporter(
      options.reportError,
      options.reportThrottleMs ?? SITEVERIFY_REPORT_THROTTLE_MS,
    );
  }

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    const body: Record<string, string> = {
      secret: this.secretKey,
      response: token,
    };
    if (remoteIp) {
      body.remoteip = remoteIp;
    }

    let res: Response;
    try {
      res = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout — infrastructure failure, fail closed.
      this.reportUnavailable("fetch_failed", err, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (!res.ok) {
      // Non-2xx from siteverify — infrastructure failure, fail closed.
      this.reportUnavailable(
        "http_error",
        new Error(`turnstile_siteverify_unavailable: HTTP ${res.status}`),
        { status: res.status },
      );
      return false;
    }

    let data: { success?: unknown; "error-codes"?: string[] };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      // 2xx but unparseable body — infrastructure failure, fail closed.
      this.reportUnavailable("bad_json", err, {
        status: res.status,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (data.success === true) {
      return true;
    }

    // Genuine token rejection (bad / expired / bot token). This is NORMAL
    // traffic for a bot-protection check — log it for rate visibility, but
    // never report it to Sentry.
    this.logger?.warn("turnstile_token_rejected", {
      errorCodes: data["error-codes"] ?? [],
    });
    return false;
  }

  private reportUnavailable(
    branch: string,
    error: unknown,
    extra: Record<string, unknown>,
  ): void {
    this.logger?.warn("turnstile_siteverify_unavailable", {
      branch,
      ...extra,
    });
    try {
      this.reportFailure(error, {
        tags: { area: "turnstile_fail_closed", branch },
        extra,
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never change
      // the verify() result (the ReporterPort convention says it never
      // throws, but fail-closed correctness must not depend on that).
    }
  }
}
