// packages/core/src/types/context.ts
import type { Repos } from "@th/ports/repos";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { SMSPort } from "@th/ports/comms/sms";
import type { LoggerPort } from "@th/ports/logger";

export type Deps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  mailer?: MailerPort;
  sms?: SMSPort;
  logger?: LoggerPort;
};
