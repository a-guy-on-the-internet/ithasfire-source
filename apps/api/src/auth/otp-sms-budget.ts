/**
 * Global ceiling on passcode texts, across every caller.
 *
 * The per-IP and per-number buckets (`rate-limit-rules.ts`,
 * `atomic-rate-limit.ts`) bound one attacker host and one victim number. SMS
 * pumping spreads requests over many IPs AND many numbers, so neither bucket
 * ever fills; what it costs us is the total number of texts. This bucket
 * counts that total: one token per OTP text actually about to be sent, keyed
 * on nothing but the purpose.
 *
 * Why here and not in the atomic pre-limiter: the pre-limiter charges every
 * request to a path before Better Auth runs, including the ones
 * `phoneNumberValidator` then refuses (non-US numbers) and the 2FA sends that
 * go by email. Charging those would let anyone drain the shared budget for
 * free with requests that never cost a text. Charging inside the OTP senders
 * counts only real sends.
 *
 * A global bucket is a lockout lever by construction: whoever fills it
 * blocks passcode texts for everyone until the window rolls. That is the
 * trade for bounding fraud spend. So there are two pools, one key each:
 *
 * - `phone`: phone verification (`send-otp`), reachable anonymously. Over
 *   the cap it answers 429.
 * - `2fa`: second-factor codes, sent only after a correct password for a
 *   real account. Over the cap the code goes by email.
 *
 * Anonymous traffic fills only its own pool, so it can never push 2FA codes
 * to email. Each pool is capped at `AUTH_OTP_SMS_MAX_PER_HOUR` (default
 * 300); size it well above normal traffic.
 *
 * FAIL OPEN on a Redis error, matching the other auth limiters: an outage
 * must not stop sign-in. Both the fail-open branch and a denial report, each
 * through its own throttled reporter: at most one event per branch per pool
 * every 5 minutes while it lasts, since a tripped cap means either an attack
 * or a cap set too low, and both need a human.
 */
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";

import { AUTH_ATOMIC_KEY_NAMESPACE } from "./atomic-rate-limit";

export const OTP_SMS_BUDGET_WINDOW_SECONDS = 60 * 60;

/** Which passcode texts a budget counts; each pool has its own key. */
export type OtpSmsBudgetPool = "phone" | "2fa";

export const OTP_SMS_BUDGET_KEYS: Record<OtpSmsBudgetPool, string> = {
  phone: `${AUTH_ATOMIC_KEY_NAMESPACE}:global:otp-sms`,
  "2fa": `${AUTH_ATOMIC_KEY_NAMESPACE}:global:otp-sms:2fa`,
};

const REPORT_THROTTLE_MS = 5 * 60 * 1000;

/** True when one more passcode text may go out now (and charges for it). */
export type OtpSmsBudget = () => Promise<boolean>;

export type OtpSmsBudgetDeps = {
  /**
   * Resolved lazily on each charge: the auth Redis client is created on
   * first use, and its construction can throw (bad `REDIS_URL`), which must
   * land in the fail-open branch rather than escape.
   */
  getRateLimit: () => Pick<RateLimitPort, "consume">;
  pool: OtpSmsBudgetPool;
  maxPerHour: number;
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  reportError?: ReporterPort;
};

export function createOtpSmsBudget(deps: OtpSmsBudgetDeps): OtpSmsBudget {
  const key = OTP_SMS_BUDGET_KEYS[deps.pool];
  // One throttle per branch: an ongoing Redis outage must not hide a
  // tripped cap, nor the reverse.
  const reportFailOpen = quiet(
    createThrottledReporter(deps.reportError, REPORT_THROTTLE_MS),
  );
  const reportExhausted = quiet(
    createThrottledReporter(deps.reportError, REPORT_THROTTLE_MS),
  );

  return async () => {
    let allowed: boolean;
    try {
      const result = await deps
        .getRateLimit()
        .consume(key, deps.maxPerHour, OTP_SMS_BUDGET_WINDOW_SECONDS);
      allowed = result.allowed;
    } catch (err) {
      deps.logger.warn("auth_otp_sms_budget_unavailable", {
        pool: deps.pool,
        error: err instanceof Error ? err.message : String(err),
      });
      reportFailOpen(err, {
        tags: {
          area: "auth_otp_sms_budget",
          branch: "fail_open",
          pool: deps.pool,
        },
      });
      return true;
    }

    if (!allowed) {
      deps.logger.warn("auth_otp_sms_budget_exhausted", {
        pool: deps.pool,
        maxPerHour: deps.maxPerHour,
      });
      reportExhausted(new Error("otp_sms_global_cap_reached"), {
        tags: {
          area: "auth_otp_sms_budget",
          branch: "exhausted",
          pool: deps.pool,
        },
        extra: { maxPerHour: deps.maxPerHour },
      });
    }
    return allowed;
  };
}

/** A throwing reporter must never change the allow/deny answer. */
function quiet(report: ReporterPort): ReporterPort {
  return (error, context) => {
    try {
      report(error, context);
    } catch {
      // Swallowed on purpose; see above.
    }
  };
}

/**
 * Per-account ceiling on 2FA passcode texts.
 *
 * The per-IP rule on `/two-factor/send-otp` (`rate-limit-rules.ts`) slows one
 * host, but one account behind several IPs could still spend the shared
 * hourly `2fa` pool above and push everyone else's codes to email. The 2FA
 * sender knows the account, so it charges this bucket BEFORE the global
 * pool.
 *
 * Over it, NO code is sent, not even by email: falling back would let anyone
 * holding the password and the mailbox skip the phone factor with six
 * requests. `createOtpSmsPerUserGate` below refuses the request with a 429
 * before a code is minted; the sender's own charge only catches requests
 * that raced past that read.
 *
 * Keyed on the auth user id (an opaque id, not a phone number). Fails open
 * on a Redis error like the global pool, reported through a throttled
 * reporter. A denial is an expected outcome for that one account, so it is
 * logged, not reported.
 */
export const OTP_SMS_PER_USER_WINDOW_SECONDS = 15 * 60;
export const OTP_SMS_PER_USER_MAX = 5;

export function otpSmsPerUserKey(userId: string): string {
  return `${AUTH_ATOMIC_KEY_NAMESPACE}:user:otp-sms:2fa:${userId}`;
}

/** True when this account may have one more 2FA text now (and charges it). */
export type OtpSmsPerUserCap = (userId: string) => Promise<boolean>;

export type OtpSmsPerUserCapDeps = {
  getRateLimit: () => Pick<RateLimitPort, "consume">;
  max?: number;
  windowSeconds?: number;
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  reportError?: ReporterPort;
};

export function createOtpSmsPerUserCap(
  deps: OtpSmsPerUserCapDeps,
): OtpSmsPerUserCap {
  const max = deps.max ?? OTP_SMS_PER_USER_MAX;
  const windowSeconds = deps.windowSeconds ?? OTP_SMS_PER_USER_WINDOW_SECONDS;
  const reportFailOpen = quiet(
    createThrottledReporter(deps.reportError, REPORT_THROTTLE_MS),
  );

  return async (userId) => {
    try {
      const result = await deps
        .getRateLimit()
        .consume(otpSmsPerUserKey(userId), max, windowSeconds);
      if (!result.allowed) {
        deps.logger.warn("auth_otp_sms_per_user_cap_reached", {
          userId,
          max,
          windowSeconds,
        });
      }
      return result.allowed;
    } catch (err) {
      deps.logger.warn("auth_otp_sms_per_user_cap_unavailable", {
        error: err instanceof Error ? err.message : String(err),
      });
      reportFailOpen(err, {
        tags: {
          area: "auth_otp_sms_budget",
          branch: "fail_open",
          pool: "2fa_per_user",
        },
      });
      return true;
    }
  };
}

/**
 * Read-only check of the per-account bucket, for the `/two-factor/send-otp`
 * before-hook: true while the account is under its cap. Uses `peek`, so the
 * check itself spends nothing; only a real text charges the bucket (in the
 * sender). Fails open on a Redis error, reported through a throttled
 * reporter, like every other auth limiter.
 */
export type OtpSmsPerUserGate = (userId: string) => Promise<boolean>;

export type OtpSmsPerUserGateDeps = {
  getRateLimit: () => Pick<RateLimitPort, "peek">;
  max?: number;
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  reportError?: ReporterPort;
};

export function createOtpSmsPerUserGate(
  deps: OtpSmsPerUserGateDeps,
): OtpSmsPerUserGate {
  const max = deps.max ?? OTP_SMS_PER_USER_MAX;
  const reportFailOpen = quiet(
    createThrottledReporter(deps.reportError, REPORT_THROTTLE_MS),
  );

  return async (userId) => {
    try {
      const [used = 0] = await deps
        .getRateLimit()
        .peek([otpSmsPerUserKey(userId)]);
      return used < max;
    } catch (err) {
      deps.logger.warn("auth_otp_sms_per_user_gate_unavailable", {
        error: err instanceof Error ? err.message : String(err),
      });
      reportFailOpen(err, {
        tags: {
          area: "auth_otp_sms_budget",
          branch: "fail_open",
          pool: "2fa_per_user_gate",
        },
      });
      return true;
    }
  };
}
