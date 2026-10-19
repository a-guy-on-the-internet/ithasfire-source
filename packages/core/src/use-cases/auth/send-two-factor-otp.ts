import { z } from "zod";

import { isUsSmsNumber, type SMSPort } from "@th/ports/comms/sms";
import { isCommsPortError } from "@th/ports/comms/schemas";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type { SmsConsentRepo } from "@th/ports/repos/sms-consent";

import { redactedError } from "../../lib/comms/redacted-error";
import { parseInput } from "../../lib/io";

export const sendTwoFactorOtpInputSchema = z
  .object({
    // User info for delivery
    userId: z.string().trim().min(1),
    email: z.string().trim().email(),
    // `.nullish()`, not `.optional()`: Better Auth hands over the user row as
    // stored, and an account with no phone carries `phoneNumber: null`, which
    // `.optional()` (undefined only) rejects. That rejection threw out of
    // `parseInput` before the try below, so every email-only 2FA user got a
    // 200 from send-otp and no email — silently, since the caller logged it
    // at warn. Verified against a live sign-up on 2026-09-07.
    // Format NOT enforced here: this is the stored account number, and
    // rejecting a non-US one would leave its owner with no code at all.
    // Instead only a US number (`isUsSmsNumber`) is texted; any other gets
    // the email fallback below.
    phoneNumber: z.string().trim().min(10).nullish(),
    phoneNumberVerified: z.boolean().default(false),

    // The OTP code (provided by Better Auth)
    otpCode: z
      .string()
      .trim()
      .regex(/^[0-9]{6}$/, "OTP code must be 6 digits"),

    productName: z.string().trim().min(1),

    // Preferred delivery method; falls back based on availability
    preferSms: z.boolean().default(true),
  })
  .strict();

export type SendTwoFactorOtpInput = z.infer<typeof sendTwoFactorOtpInputSchema>;

export type SendTwoFactorOtpDeps = {
  sms?: SMSPort;
  mailer: MailerPort;
  logger?: LoggerPort;
  /**
   * The SMS consent ledger. A number that replied STOP (`OPTED_OUT`) gets
   * its code by email: the text would be refused by the carrier anyway, and
   * the person asked us to stop. Absent = no consent check (tests, dev).
   */
  smsConsent?: Pick<SmsConsentRepo, "getByPhone">;
  /**
   * Charges one passcode text against the 2FA budget and answers whether
   * it may go out. Called last, only when the code would otherwise be
   * texted, so an email send never spends it. False = email instead.
   */
  smsBudget?: () => Promise<boolean>;
  /**
   * Reports a swallowed failure that fell back to email: a consent lookup
   * that failed, or a text that failed to send.
   */
  reportError?: ReporterPort;
};

/**
 * Sends a 2FA OTP code via SMS (preferred) or email (fallback).
 * Used by Better Auth's twoFactor plugin for step-up authentication.
 *
 * No idempotency needed: OTPs are inherently retriable, short-lived,
 * and not money-moving. Duplicate messages are acceptable.
 */
export async function sendTwoFactorOtp(
  deps: SendTwoFactorOtpDeps,
  rawInput: unknown,
): Promise<{ ok: true; method: "sms" | "email" }> {
  const scopedLogger = deps.logger?.child({ useCase: "auth.sendTwoFactorOtp" });

  const input = parseInput(sendTwoFactorOtpInputSchema, rawInput);

  // Determine delivery method
  const canSendSms = Boolean(
    deps.sms &&
    input.phoneNumber &&
    isUsSmsNumber(input.phoneNumber) &&
    input.phoneNumberVerified &&
    input.preferSms,
  );
  const method: "sms" | "email" =
    canSendSms &&
    input.phoneNumber &&
    (await smsConsentAllows(deps, input.phoneNumber, scopedLogger)) &&
    (deps.smsBudget ? await deps.smsBudget() : true)
      ? "sms"
      : "email";

  if (method === "sms" && deps.sms && input.phoneNumber) {
    try {
      // Sent from the registered US number (10DLC or toll-free) for
      // passcodes; one number in both variables is the expected setup. The
      // body matches the sample message in that registration. Expiry is owned by
      // Better Auth and not known here, so the text does not state one.
      await deps.sms.send({
        purpose: "otp",
        to: { toE164: input.phoneNumber },
        body: `${input.productName}: your verification code is ${input.otpCode}. Don't share it with anyone.`,
      });

      scopedLogger?.info("2fa_otp_sent_sms", {
        userId: input.userId,
        phoneNumberLast4: input.phoneNumber.slice(-4),
      });
      return { ok: true, method: "sms" };
    } catch (error) {
      // A failed text (SNS down, the monthly SMS spend cap hit) must not
      // leave the person with no code: the caller swallows our throw and
      // Better Auth tells them "code sent". Send the same code by email
      // instead, and report the swallowed SMS failure, tagged as the
      // fallback. The SNS adapter also logs its own `sns.send.failed` at
      // error, so one failure can reach the tracker twice; this line stays
      // at warn so it adds no third event.
      // Provider text can echo the destination number: only the redacted
      // copy (number and code scrubbed) reaches the log and the report.
      const safeError = redactedError(error, [input.otpCode]);
      scopedLogger?.warn("2fa_otp_sms_send_failed_email_fallback", {
        userId: input.userId,
        phoneNumberLast4: input.phoneNumber.slice(-4),
        error: safeError.message,
      });
      if (deps.reportError) {
        safeReporter(deps.reportError)(safeError, {
          tags: {
            useCase: "auth.sendTwoFactorOtp",
            stage: "sms_send",
            swallowed: "true",
            errorCode: isCommsPortError(error) ? error.code : undefined,
          },
          extra: {
            userId: input.userId,
            phoneNumberLast4: input.phoneNumber.slice(-4),
          },
        });
      }
    }
  }

  try {
    await deps.mailer.send({
      to: { to: input.email },
      template: {
        key: "auth.2fa_otp",
        variables: {
          productName: input.productName,
          otpCode: input.otpCode,
        },
      },
    });

    scopedLogger?.info("2fa_otp_sent_email", {
      userId: input.userId,
    });

    return { ok: true, method: "email" };
  } catch (error) {
    scopedLogger?.warn("2fa_otp_send_failed", {
      userId: input.userId,
      method,
      error,
    });
    // `method` is the channel first chosen, so a text that failed and then an
    // email that failed still answers `sms_send_failed`, as it did before
    // the email fallback existed. The caller reports this throw.
    throw { code: "transient", message: `${method}_send_failed` } as const;
  }
}

/**
 * False when the number replied STOP. A failed lookup also answers false:
 * the code still arrives (by email), and the failure is logged and reported
 * because it is a swallowed error. No phone number in the report.
 */
async function smsConsentAllows(
  deps: SendTwoFactorOtpDeps,
  phoneNumber: string,
  logger: LoggerPort | undefined,
): Promise<boolean> {
  if (!deps.smsConsent) return true;
  try {
    const consent = await deps.smsConsent.getByPhone(phoneNumber);
    return consent?.status !== "OPTED_OUT";
  } catch (error) {
    // A database error can print its arguments, the number among them: only
    // the redacted copy reaches the log and the report.
    const safeError = redactedError(error);
    logger?.error("2fa_otp_sms_consent_lookup_failed", {
      error: safeError.message,
    });
    if (deps.reportError) {
      safeReporter(deps.reportError)(safeError, {
        tags: {
          useCase: "auth.sendTwoFactorOtp",
          swallowed: "true",
          stage: "sms_consent_lookup",
        },
      });
    }
    return false;
  }
}
