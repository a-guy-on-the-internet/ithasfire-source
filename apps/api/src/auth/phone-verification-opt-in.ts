/**
 * Better Auth phoneNumber plugin `callbackOnVerification` hook.
 *
 * Completing phone OTP verification is the person's affirmative SMS opt-in
 * (sms-opt-out-sns FR-003), so it is mirrored into the phone-consent ledger.
 * Best-effort: verification must never fail because the ledger write did.
 *
 * Swallowed is NOT silent. Someone who replied STOP and re-verifies to get
 * texts back stays OPTED_OUT if this write fails, and a `logger.warn` alone
 * never reached Sentry, so the failure is reported (`CLAUDE.md`, "Error
 * Reporting Convention"). No phone number in the log or the report.
 */
import { redactedError } from "@th/core/lib/comms/redacted-error";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

export const PHONE_VERIFICATION_OPT_IN_SOURCE = "phone_verification";

export type PhoneVerificationOptInDeps = {
  /** Writes the OPTED_IN ledger row (wired to `recordSmsOptIn`). */
  recordSmsOptIn: (input: {
    phoneNumber: string;
    source: string;
  }) => Promise<unknown>;
  logger: LoggerPort;
  reportError?: ReporterPort;
};

export function createPhoneVerificationOptInHook(
  deps: PhoneVerificationOptInDeps,
) {
  return async ({ phoneNumber }: { phoneNumber: string }): Promise<void> => {
    try {
      await deps.recordSmsOptIn({
        phoneNumber,
        source: PHONE_VERIFICATION_OPT_IN_SOURCE,
      });
    } catch (error) {
      // A database error can print its arguments (a Prisma validation error
      // prints the whole call, phoneE164 included): only the redacted copy
      // reaches the log and the report.
      const safeError = redactedError(error);
      // warn, not error: the report below is the Sentry event, and
      // pinoIntegration would file `logger.error` as a second one.
      deps.logger.warn("phone_verification_sms_opt_in_failed", {
        phoneNumberLast4: phoneNumber.slice(-4),
        error: safeError.message,
      });
      // Guarded here too, not only by the caller's `safeReporter`: a
      // throwing reporter must never turn this swallow into a failed
      // verification.
      try {
        deps.reportError?.(safeError, {
          tags: {
            hook: "phoneNumber.callbackOnVerification",
            swallowed: "true",
          },
          extra: { phoneNumberLast4: phoneNumber.slice(-4) },
        });
      } catch (reporterError) {
        deps.logger.warn("phone_verification_reporter_failed", {
          error: reporterError,
        });
      }
    }
  };
}
