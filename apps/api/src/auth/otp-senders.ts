/**
 * Auth OTP sender dependencies for Better Auth plugins.
 *
 * These are thin wrappers that adapt Better Auth's plugin callbacks
 * to our use-case layer with proper dependency injection.
 */
import { APIError } from "better-auth/api";

import { isUsSmsNumber, type SMSPort } from "@th/ports/comms/sms";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { SmsConsentRepo } from "@th/ports/repos/sms-consent";

import { sendPhoneOtp } from "@th/core/use-cases/auth/send-phone-otp";
import { sendTwoFactorOtp } from "@th/core/use-cases/auth/send-two-factor-otp";

import { redactedError } from "@th/core/lib/comms/redacted-error";

import type {
  OtpSmsBudget,
  OtpSmsPerUserCap,
  OtpSmsPerUserGate,
} from "./otp-sms-budget";
import { sessionUserIdOf } from "./second-factor-bypass";

/**
 * Report without ever becoming the failure.
 *
 * The composition root already wraps its reporter in `safeReporter`, but these
 * two senders are the LAST line before Better Auth — the entire reason they
 * catch is that a delivery failure must not throw into the plugin. A reporter
 * that threw here would turn a swallowed OTP failure into exactly the thrown
 * error the catch exists to prevent, so the guard is duplicated on purpose
 * rather than trusted from a caller this module cannot see.
 * `CLAUDE.md`: "guarded so a throwing reporter never changes behaviour."
 */
function reportQuietly(
  reportError: ReporterPort | undefined,
  logger: LoggerPort,
  error: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    reportError?.(error, context);
  } catch (reporterError) {
    logger.warn("auth_otp_reporter_failed", { error: reporterError });
  }
}

/** Machine-readable code on the 503 the phone OTP sender throws without SMS. */
export const SMS_UNAVAILABLE_CODE = "SMS_UNAVAILABLE";

/**
 * Better Auth's own error type, so the router answers it as-is (status +
 * `{ code, message }` body) instead of a bare 500, and `onAPIError` keeps it
 * out of Sentry.
 */
function smsUnavailableError(
  message = "Text messages aren't available yet.",
): APIError {
  return new APIError("SERVICE_UNAVAILABLE", {
    code: SMS_UNAVAILABLE_CODE,
    message,
  });
}

/** Machine-readable code on the 429 when the global passcode-text cap is spent. */
export const SMS_RATE_LIMITED_CODE = "SMS_RATE_LIMITED";

/** Machine-readable code on the 400 for a number we never text. */
export const SMS_NUMBER_NOT_SUPPORTED_CODE = "SMS_NUMBER_NOT_SUPPORTED";

function smsRateLimitedError(): APIError {
  return new APIError("TOO_MANY_REQUESTS", {
    code: SMS_RATE_LIMITED_CODE,
    message: "We can't send a code right now. Try again later.",
  });
}

/** Machine-readable code on the 429 when one account asked for too many 2FA texts. */
export const TWO_FACTOR_OTP_RATE_LIMITED_CODE = "TWO_FACTOR_OTP_RATE_LIMITED";

function twoFactorOtpRateLimitedError(): APIError {
  return new APIError("TOO_MANY_REQUESTS", {
    code: TWO_FACTOR_OTP_RATE_LIMITED_CODE,
    message: "Too many codes requested. Try again in a few minutes.",
  });
}

function smsNumberNotSupportedError(): APIError {
  return new APIError("BAD_REQUEST", {
    code: SMS_NUMBER_NOT_SUPPORTED_CODE,
    message: "We can only text US phone numbers.",
  });
}

export type AuthOtpSenderDeps = {
  sms?: SMSPort;
  mailer: MailerPort;
  logger: LoggerPort;
  productName: string;
  /**
   * Both senders below catch a delivery failure and report it — the shape
   * `CLAUDE.md` says MUST report (a `logger.warn` alone is invisible to
   * Sentry). The 2FA sender then swallows (the use case has already tried
   * email); the phone sender then refuses with SMS_UNAVAILABLE, since email
   * can't prove control of a phone. Optional and guarded, so a throwing
   * reporter can never change behaviour.
   */
  reportError?: ReporterPort;
  /**
   * Global hourly cap on passcode texts (`otp-sms-budget.ts`), charged only
   * for a text about to be sent. Each sender gets its own pool: phone
   * verification the anonymous one, 2FA the post-password one, so
   * anonymous traffic cannot push 2FA codes to email. Absent = no global
   * cap (tests, dev).
   */
  smsBudget?: OtpSmsBudget;
  /**
   * Per-account cap on 2FA texts (`otp-sms-budget.ts`), charged by the 2FA
   * sender before `smsBudget` so one account cannot drain the shared pool.
   * Over it, NO code is sent, not even by email (email would let the holder
   * of the password and the mailbox skip the phone factor). The 429 itself
   * comes from `guardTwoFactorSendOtp`; this charge only catches requests
   * that raced past that check. Absent = no per-account cap.
   */
  perUserSmsCap?: OtpSmsPerUserCap;
  /**
   * SMS consent ledger, read by the 2FA sender: a number that replied STOP
   * gets its code by email. Absent = no consent check.
   */
  smsConsent?: Pick<SmsConsentRepo, "getByPhone">;
};

/**
 * Creates the sendOTP callback for Better Auth's phoneNumber plugin.
 */
export function createPhoneOtpSender(deps: AuthOtpSenderDeps) {
  return async ({
    phoneNumber,
    code,
  }: {
    phoneNumber: string;
    code: string;
  }) => {
    const { sms, logger, productName, reportError, smsBudget } = deps;

    if (!sms) {
      logger.warn("auth_phone_otp_skipped", {
        reason: "no_sms_adapter",
        phoneNumberLast4: phoneNumber.slice(-4),
      });
      // In development, log the code for testing
      if (process.env.NODE_ENV === "development") {
        // eslint-disable-next-line no-console
        console.info("[auth] phone OTP (dev mode)", { phoneNumber, code });
      }
      // Refuse rather than pretend. Returning here made Better Auth answer
      // "code sent" while nothing went out (prod has no AWS keys). Clients
      // hide SMS options from `features.getFeatureGates().sms`, so only a
      // stale page or a hand-made request reaches this. An expected refusal,
      // not a failure: thrown, never reported.
      throw smsUnavailableError();
    }

    // `phoneNumberValidator` on the plugin already refuses these; checked
    // again so no route that reaches this sender can text (or spend the
    // global budget on) a non-US number. Expected refusal: not reported.
    if (!isUsSmsNumber(phoneNumber)) {
      logger.warn("auth_phone_otp_refused", {
        reason: "number_not_supported",
      });
      throw smsNumberNotSupportedError();
    }

    if (smsBudget && !(await smsBudget())) {
      // The budget itself reports denials (throttled).
      throw smsRateLimitedError();
    }

    try {
      await sendPhoneOtp(
        { sms, logger },
        {
          toPhoneNumber: phoneNumber,
          productName,
          verificationCode: code,
        },
      );
    } catch (error) {
      // The provider refused or failed (SNS down, the monthly SMS spend cap
      // hit). Swallowing this made Better Auth answer "code sent" for a text
      // that never went out. Email can't prove control of a phone, so there
      // is no fallback: report it, then refuse with the same 503 as a missing
      // adapter, which the web form shows as "Texts aren't available right
      // now". Use case already logs (last 4 digits only, provider text
      // redacted). One failure files two tracker events: the SNS adapter's
      // own `sns.send.failed` error log and this report; accepted, as for
      // 2FA (`send-two-factor-otp.ts`). The error reaching here is the use
      // case's `SMS_SEND_FAILED`, not the provider's text.
      logger.warn("auth_phone_otp_use_case_error", { error });
      reportQuietly(reportError, logger, error, {
        tags: { useCase: "auth.sendPhoneOtp", swallowed: "true" },
      });
      throw smsUnavailableError("Text messages aren't available right now.");
    }
  };
}

/**
 * Creates the sendOTP callback for Better Auth's twoFactor plugin.
 */
export function createTwoFactorOtpSender(deps: AuthOtpSenderDeps) {
  return async (
    {
      user,
      otp,
    }: {
      user: {
        id: string;
        email: string;
        phoneNumber?: string;
        phoneNumberVerified?: boolean;
      };
      otp: string;
    },
    _ctx: unknown,
  ) => {
    const { sms, mailer, logger, productName, reportError, smsBudget } = deps;
    const { perUserSmsCap } = deps;

    // The account's own cap first, then the shared pool. Over the account
    // cap the charge THROWS rather than answering false: false means "send
    // by email", and an account over its cap gets no code at all. The use
    // case charges outside its own try, so this reaches the catch below.
    //
    // Accepted: the account token is spent even when the shared pool then
    // refuses, or the text then fails and the code goes by email. So during
    // an SMS outage the 6th send in 15 minutes is a 429. While the pool is
    // exhausted every code goes by email anyway,
    // and charging the pool first would spend it for over-cap accounts,
    // which is the drain this cap exists to stop.
    const accountCapRefusal = twoFactorOtpRateLimitedError();
    const chargeSmsBudget =
      perUserSmsCap || smsBudget
        ? async () => {
            if (perUserSmsCap && !(await perUserSmsCap(user.id))) {
              throw accountCapRefusal;
            }
            return smsBudget ? await smsBudget() : true;
          }
        : undefined;

    try {
      // The use case charges the 2FA passcode-text budget only once it has
      // decided the code would really go by text (US number, verified, not
      // opted out). Over the shared pool, the code goes by email; over the
      // account cap, nothing is sent (above).
      await sendTwoFactorOtp(
        {
          sms,
          mailer,
          logger,
          smsConsent: deps.smsConsent,
          smsBudget: chargeSmsBudget,
          reportError: reportError
            ? (error, context) =>
                reportQuietly(reportError, logger, error, context)
            : undefined,
        },
        {
          userId: user.id,
          email: user.email,
          phoneNumber: user.phoneNumber,
          phoneNumberVerified: user.phoneNumberVerified ?? false,
          otpCode: otp,
          productName,
          preferSms: true,
        },
      );
    } catch (error) {
      if (error === accountCapRefusal) {
        // Only a request that raced past `guardTwoFactorSendOtp` lands here.
        // Better Auth swallows anything `sendOTP` throws and answers 200, so
        // the 429 cannot be sent from here; the guard is what answers it.
        // An expected refusal: logged, not reported.
        logger.warn("auth_2fa_otp_account_cap_refused", {
          userId: user.id,
          stage: "send",
        });
        return;
      }
      // Swallowed on purpose so Better Auth still answers 200 — an OTP is
      // retriable and not money-moving. But swallowed is NOT silent: this
      // exact branch hid a schema rejection (`phoneNumber: null`) that meant
      // every email-only 2FA user got no code at all, for as long as the
      // feature existed, with nothing in Sentry.
      logger.warn("auth_2fa_otp_use_case_error", { error });
      reportQuietly(reportError, logger, error, {
        tags: { useCase: "auth.sendTwoFactorOtp", swallowed: "true" },
        extra: { userId: user.id },
      });
    }
  };
}

export type TwoFactorSendOtpGuardDeps = {
  /**
   * The account asking for a code: the signed-in session's user, or the user
   * behind the signed `two_factor` cookie mid sign-in. Null when neither is
   * present (Better Auth then refuses the request itself).
   */
  resolveUserId: () => Promise<string | null>;
  isUnderCap: OtpSmsPerUserGate;
  logger: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Before-hook for `/two-factor/send-otp`: refuses with a 429 once the account
 * has had its quota of 2FA texts, before a code is minted. It has to run
 * here: the twoFactor plugin catches whatever `sendOTP` throws and answers
 * 200, so a refusal from the sender could only ever look like "code sent".
 *
 * The bucket counts only texts, so email-only accounts are never refused.
 * A failed account lookup fails open (reported): the plugin repeats the same
 * lookup and refuses a bad cookie itself.
 */
export async function guardTwoFactorSendOtp(
  deps: TwoFactorSendOtpGuardDeps,
): Promise<void> {
  let userId: string | null;
  try {
    userId = await deps.resolveUserId();
  } catch (error) {
    const safeError = redactedError(error);
    deps.logger.warn("auth_2fa_otp_guard_lookup_failed", {
      error: safeError.message,
    });
    reportQuietly(deps.reportError, deps.logger, safeError, {
      tags: {
        hook: "twoFactor.sendOtpGuard",
        swallowed: "true",
      },
    });
    return;
  }
  if (!userId) return;
  if (await deps.isUnderCap(userId)) return;
  deps.logger.warn("auth_2fa_otp_account_cap_refused", {
    userId,
    stage: "guard",
  });
  throw twoFactorOtpRateLimitedError();
}

export const TWO_FACTOR_SEND_OTP_PATH = "/two-factor/send-otp";

/**
 * The account a `/two-factor/send-otp` request is for, read in a before-hook
 * the way the plugin's own `verifyTwoFactor` reads it (better-auth 1.6.9):
 * the session (bearer-aware and without a refresh, `sessionUserIdOf`), else
 * the signed `two_factor` cookie, whose verification row's value is the user
 * id. Null when neither is present.
 */
export const twoFactorSendOtpUserIdOf = async (
  ctx: unknown,
): Promise<string | null> => {
  const sessionUserId = await sessionUserIdOf(ctx);
  if (sessionUserId) return sessionUserId;
  const c = ctx as {
    context: {
      secret: string;
      createAuthCookie: (name: string) => { name: string };
      internalAdapter: {
        findVerificationValue: (
          identifier: string,
        ) => Promise<{ value: string } | null | undefined>;
      };
    };
    getSignedCookie: (
      name: string,
      secret: string,
    ) => Promise<string | null | false | undefined>;
  };
  const cookie = c.context.createAuthCookie("two_factor");
  const signed = await c.getSignedCookie(cookie.name, c.context.secret);
  if (!signed) return null;
  const row = await c.context.internalAdapter.findVerificationValue(signed);
  return row?.value ?? null;
};

/**
 * The app's `hooks.before` branch for `/two-factor/send-otp`: the account
 * cap's 429 (`guardTwoFactorSendOtp`), a no-op on every other path.
 */
export function createTwoFactorSendOtpGuardHook(
  deps: Omit<TwoFactorSendOtpGuardDeps, "resolveUserId">,
) {
  return async (ctx: { path?: string }): Promise<void> => {
    if (ctx.path !== TWO_FACTOR_SEND_OTP_PATH) return;
    await guardTwoFactorSendOtp({
      ...deps,
      resolveUserId: () => twoFactorSendOtpUserIdOf(ctx),
    });
  };
}
