import type SMTPTransport from "nodemailer/lib/smtp-transport";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { EmailDeliverabilityPort } from "@th/ports/comms/email-deliverability";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { EmailFooterDefaults } from "@th/ui-email";

import { ResendMailAdapter, type ResendMailClient } from "./resend-mailer";
import { SMTPMailAdapter, type NodemailerTransport } from "./smtp-mail";

export interface CreateMailerOptions {
  resendApiKey?: string;
  defaultFromEmail?: string;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  idempotency?: IdempotencyPort;
  deliverability?: EmailDeliverabilityPort;
  appHeaderValue?: string;
  resendClient?: ResendMailClient;
  resendMaxBatchConcurrency?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpPool?: boolean;
  plainSmtp?: boolean;
  smtpIgnoreTLS?: boolean;
  smtpRequireTLS?: boolean;
  smtpConnectionTimeoutMs?: number;
  smtpSocketTimeoutMs?: number;
  smtpGreetingTimeoutMs?: number;
  smtpMaxBatchConcurrency?: number;
  smtpTransporter?: NodemailerTransport;
  smtpTls?: SMTPTransport.Options["tls"];
  /** Resolves platform-level footer defaults (CAN-SPAM) injected at render time. */
  footerDefaultsProvider?: () => Promise<EmailFooterDefaults>;
  /**
   * Skip sends to RFC-reserved test domains (example.com, .test, …) on the
   * real-ESP (Resend) path so seed-data addresses don't hard-bounce. Has no
   * effect on the SMTP/Mailpit path, which is a local sink that should still
   * show every email.
   */
  blockReservedTestDomains?: boolean;
}

export function createMailerFromConfig(
  options: CreateMailerOptions,
): MailerPort | null {
  if (
    options.plainSmtp === true &&
    options.smtpHost &&
    options.smtpPort &&
    options.defaultFromEmail
  ) {
    return new SMTPMailAdapter({
      host: options.smtpHost,
      port: options.smtpPort,
      secure: false,
      ignoreTLS: true,
      requireTLS: false,
      tls: {
        ...(options.smtpTls ?? {}),
        rejectUnauthorized: false,
      },
      username: options.smtpUsername,
      password: options.smtpPassword,
      defaultFromEmail: options.defaultFromEmail,
      pool: options.smtpPool,
      logger: options.logger,
      metrics: options.metrics,
      idempotency: options.idempotency,
      appHeaderValue: options.appHeaderValue,
      transporter: options.smtpTransporter,
      connectionTimeoutMs: options.smtpConnectionTimeoutMs,
      socketTimeoutMs: options.smtpSocketTimeoutMs,
      greetingTimeoutMs: options.smtpGreetingTimeoutMs,
      maxBatchConcurrency: options.smtpMaxBatchConcurrency,
      footerDefaultsProvider: options.footerDefaultsProvider,
    });
  }

  if (options.resendApiKey && options.defaultFromEmail) {
    return new ResendMailAdapter({
      apiKey: options.resendApiKey,
      defaultFromEmail: options.defaultFromEmail,
      logger: options.logger,
      metrics: options.metrics,
      idempotency: options.idempotency,
      deliverability: options.deliverability,
      appHeaderValue: options.appHeaderValue,
      client: options.resendClient,
      maxBatchConcurrency: options.resendMaxBatchConcurrency,
      footerDefaultsProvider: options.footerDefaultsProvider,
      blockReservedTestDomains: options.blockReservedTestDomains,
    });
  }

  if (options.smtpHost && options.smtpPort && options.defaultFromEmail) {
    return new SMTPMailAdapter({
      host: options.smtpHost,
      port: options.smtpPort,
      secure: options.smtpSecure,
      ignoreTLS: options.smtpIgnoreTLS,
      requireTLS: options.smtpRequireTLS,
      tls: options.smtpTls,
      username: options.smtpUsername,
      password: options.smtpPassword,
      defaultFromEmail: options.defaultFromEmail,
      pool: options.smtpPool,
      logger: options.logger,
      metrics: options.metrics,
      idempotency: options.idempotency,
      appHeaderValue: options.appHeaderValue,
      transporter: options.smtpTransporter,
      connectionTimeoutMs: options.smtpConnectionTimeoutMs,
      socketTimeoutMs: options.smtpSocketTimeoutMs,
      greetingTimeoutMs: options.smtpGreetingTimeoutMs,
      maxBatchConcurrency: options.smtpMaxBatchConcurrency,
      footerDefaultsProvider: options.footerDefaultsProvider,
    });
  }

  return null;
}
