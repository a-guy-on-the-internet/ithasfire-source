import {
  SNSClient,
  CheckIfPhoneNumberIsOptedOutCommand,
  ListPhoneNumbersOptedOutCommand,
} from "@aws-sdk/client-sns";

import type { SmsProviderOptOutPort } from "@th/ports/comms/sms-opt-out";
import type { LoggerPort } from "@th/ports/logger";

export interface SnsProviderOptOutAdapterOptions {
  client: SNSClient;
  logger?: LoggerPort;
}

/**
 * Reads AWS SNS provider opt-out state so reconciliation/guard logic can fold
 * carrier STOP suppression into the app-owned SMS consent ledger. Wraps
 * CheckIfPhoneNumberIsOptedOut (single number) and ListPhoneNumbersOptedOut
 * (paginated full list) behind SmsProviderOptOutPort.
 */
export class SnsProviderOptOutAdapter implements SmsProviderOptOutPort {
  private readonly client: SNSClient;
  private readonly logger?: LoggerPort;

  constructor(options: SnsProviderOptOutAdapterOptions) {
    this.client = options.client;
    this.logger = options.logger;
  }

  async isOptedOut(phoneE164: string): Promise<boolean> {
    const res = await this.client.send(
      new CheckIfPhoneNumberIsOptedOutCommand({ phoneNumber: phoneE164 }),
    );
    return res.isOptedOut === true;
  }

  // No production caller, and the sender IAM policy does not grant
  // sns:ListPhoneNumbersOptedOut (a bulk export of numbers if a key leaks).
  async listOptedOut(): Promise<string[]> {
    const numbers: string[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListPhoneNumbersOptedOutCommand(
          nextToken ? { nextToken } : {},
        ),
      );
      for (const n of res.phoneNumbers ?? []) {
        if (n) numbers.push(n);
      }
      nextToken = res.nextToken ?? undefined;
    } while (nextToken);
    this.logger?.info?.("sns_opt_out_list_fetched", {
      count: numbers.length,
    });
    return numbers;
  }
}

export function createSnsProviderOptOutAdapter(
  options: SnsProviderOptOutAdapterOptions,
): SnsProviderOptOutAdapter {
  return new SnsProviderOptOutAdapter(options);
}
