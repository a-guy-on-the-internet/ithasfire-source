/**
 * Shared dependency factory for auth-related use cases.
 *
 * Centralizes the creation of adapters (logger, mailer, sms)
 * so they can be reused across Better Auth hooks and callbacks.
 */
import { SNSClient } from "@aws-sdk/client-sns";

import { createMailerFromConfig } from "@th/adapters/comms/mail";
import { createPrismaEmailDeliverabilityAdapter } from "@th/adapters/db/prisma-email-deliverability-adapter";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { SnsSmsAdapter } from "@th/adapters/comms/sns-sms";
import { prisma } from "@th/db";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { SMSPort } from "@th/ports/comms/sms";

import { env } from "../lib/env";

export type AuthDeps = {
  logger: LoggerPort;
  mailer: MailerPort | null;
  sms: SMSPort | null;
  productName: string;
};

/**
 * Creates auth dependencies for OTP sending.
 *
 * No idempotency needed: OTPs are inherently retriable, short-lived,
 * and not money-moving. If a user gets a duplicate SMS/email, that's fine.
 */
export function createAuthDeps(): AuthDeps {
  const logger = createPinoLoggerAdapter();
  const productName = env.PRODUCT_NAME;

  // Mailer (optional)
  const isPlaywrightE2E = process.env.PLAYWRIGHT_E2E === "1";
  const isPlainSmtp = isPlaywrightE2E || env.SMTP_SECURE === false;
  const mailer: MailerPort | null = createMailerFromConfig({
    resendApiKey: env.RESEND_API_KEY,
    defaultFromEmail: env.SMTP_DEFAULT_FROM_EMAIL,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecure: env.SMTP_SECURE,
    smtpUsername: env.SMTP_USERNAME,
    smtpPassword: env.SMTP_PASSWORD,
    appHeaderValue: env.SMTP_APP_HEADER,
    plainSmtp: isPlainSmtp,
    logger,
    deliverability: createPrismaEmailDeliverabilityAdapter(prisma),
    // Never send to RFC-reserved test domains (seed fixtures use example.com).
    // Only affects the Resend path; local Mailpit still shows everything.
    blockReservedTestDomains: true,
  });

  // SMS (optional)
  let sms: SMSPort | null = null;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    const snsClient = new SNSClient({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    sms = new SnsSmsAdapter({
      client: snsClient,
      logger,
      defaultSmsType: "Transactional",
      defaultSenderId: env.AWS_SNS_SENDER_ID,
    });
  }

  return {
    logger,
    mailer,
    sms,
    productName,
  };
}
