/**
 * Auth OTP sender dependencies for Better Auth plugins.
 *
 * These are thin wrappers that adapt Better Auth's plugin callbacks
 * to our use-case layer with proper dependency injection.
 */
import type { SMSPort } from "@th/ports/comms/sms";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";

import { sendPhoneOtp } from "@th/core/use-cases/auth/send-phone-otp";
import { sendTwoFactorOtp } from "@th/core/use-cases/auth/send-two-factor-otp";

export type AuthOtpSenderDeps = {
  sms?: SMSPort;
  mailer: MailerPort;
  logger: LoggerPort;
  productName: string;
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
    const { sms, logger, productName } = deps;

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
      return;
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
      // Use case already logs; just ensure we don't throw to Better Auth
      logger.warn("auth_phone_otp_use_case_error", { error });
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
    const { sms, mailer, logger, productName } = deps;

    try {
      await sendTwoFactorOtp(
        { sms, mailer, logger },
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
      // Use case already logs; just ensure we don't throw to Better Auth
      logger.warn("auth_2fa_otp_use_case_error", { error });
    }
  };
}
