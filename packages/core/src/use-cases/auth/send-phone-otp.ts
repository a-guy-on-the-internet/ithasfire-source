import { randomInt } from "node:crypto";

import { z } from "zod";

import { isUsSmsNumber, type SMSPort } from "@th/ports/comms/sms";
import type { LoggerPort } from "@th/ports/logger";

import { redactedError } from "../../lib/comms/redacted-error";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const sendPhoneOtpInputSchema = z
  .object({
    // US/NANP E.164 only (`isUsSmsNumber`): our sending numbers are
    // registered for the US, and nothing else may be texted.
    toPhoneNumber: z
      .string()
      .trim()
      .max(16)
      .refine(isUsSmsNumber, "must be a US phone number in E.164 form"),
    productName: z.string().trim().min(1),
    // If provided, use this code; otherwise generate one
    verificationCode: z
      .string()
      .trim()
      .regex(/^[0-9]{6}$/, "verification code must be 6 digits")
      .optional(),
  })
  .strict();

export type SendPhoneOtpInput = z.infer<typeof sendPhoneOtpInputSchema>;

export type SendPhoneOtpDeps = {
  sms: SMSPort;
  logger?: LoggerPort;
};

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Sends a phone OTP verification code via SMS.
 * Used by Better Auth's phoneNumber plugin for phone verification.
 *
 * No idempotency needed: OTPs are inherently retriable, short-lived,
 * and not money-moving. Duplicate SMS messages are acceptable.
 */
export async function sendPhoneOtp(
  deps: SendPhoneOtpDeps,
  rawInput: unknown,
): Promise<{ ok: true }> {
  const scopedLogger = deps.logger?.child({ useCase: "auth.sendPhoneOtp" });

  const input = parseInput(sendPhoneOtpInputSchema, rawInput);
  const code = input.verificationCode ?? generateSixDigitCode();

  try {
    // Sent from the registered US number (10DLC or toll-free) for
    // passcodes; one number in both variables is the expected setup. The
    // body matches the sample message in that registration. Expiry is owned by
    // Better Auth and not known here, so the text does not state one.
    await deps.sms.send({
      purpose: "otp",
      to: { toE164: input.toPhoneNumber },
      body: `${input.productName}: your verification code is ${code}. Don't share it with anyone.`,
    });

    scopedLogger?.info("phone_otp_sent", {
      phoneNumberLast4: input.toPhoneNumber.slice(-4),
    });

    return { ok: true };
  } catch (error) {
    // Provider text can echo the destination number: log the redacted
    // copy (number and code scrubbed), never the raw error.
    scopedLogger?.warn("phone_otp_send_failed", {
      phoneNumberLast4: input.toPhoneNumber.slice(-4),
      error: redactedError(error, [code]).message,
    });
    throw fail("SMS_SEND_FAILED");
  }
}
