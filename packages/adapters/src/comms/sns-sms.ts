import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

import {
  isUsSmsNumber,
  redactPhoneNumbers,
  smsSendInputSchema,
  smsSendBatchInputSchema,
  type SMSPort,
  type SMSSendInput,
  type SMSSendOutput,
  type SMSSendBatchInput,
  type SMSSendBatchOutput,
} from "@th/ports/comms/sms";
import { CommsPortError, type SendResult } from "@th/ports/comms/index";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";

import {
  CHANNEL_METRICS,
  buildBatchResult,
  composeMetricTags,
  createAdapterLogger,
  ensureArray,
  errorResult,
  mapWithConcurrency,
  parseInput,
  recordLatency,
  redactDeep,
  runWithIdempotency,
  successResult,
  withRetries,
  type ParseSchema,
} from "./utils";

const ADAPTER_NAME = "sns";
const VENDOR_NAME = "aws-sns";

// SNS SMS limits vary by segmentation/encoding; defaulting to something safe and matching prior behavior.
const MAX_TEXT_LENGTH = 1_600;
const DEFAULT_BATCH_CONCURRENCY = 5;

const smsSendInputParseSchema: ParseSchema =
  smsSendInputSchema as unknown as ParseSchema;
const smsSendBatchInputParseSchema: ParseSchema =
  smsSendBatchInputSchema as unknown as ParseSchema;

export type SnsSmsType = "Transactional" | "Promotional";

/**
 * Registered US origination numbers (10DLC or toll-free; E.164 or the
 * phone-number ARN), one per purpose. One number in both variables is the
 * expected setup. US numbers ignore sender IDs; SNS picks the sending number
 * from `AWS.MM.SMS.OriginationNumber`.
 */
export interface SnsSmsOriginationNumbers {
  otp?: string;
  notification?: string;
}

export interface SnsSmsAdapterOptions {
  client: SNSClient;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  idempotency?: IdempotencyPort;
  defaultSmsType?: SnsSmsType;
  originationNumbers?: SnsSmsOriginationNumbers;
  maxBatchConcurrency?: number;
}

/**
 * AWS SNS SMS adapter that conforms to SMSPort. Sends only to US/NANP
 * numbers (`isUsSmsNumber`): anything else is refused before Publish, so no
 * caller (auth, jobs) can make it text a premium or international range.
 */
export class SnsSmsAdapter implements SMSPort {
  private readonly client: SNSClient;
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly idempotency?: IdempotencyPort;
  private readonly defaultSmsType: SnsSmsType;
  private readonly originationNumbers: SnsSmsOriginationNumbers;
  private readonly maxBatchConcurrency: number;

  constructor(options: SnsSmsAdapterOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.idempotency = options.idempotency;
    this.defaultSmsType = options.defaultSmsType ?? "Transactional";
    this.originationNumbers = {
      otp: options.originationNumbers?.otp || undefined,
      notification: options.originationNumbers?.notification || undefined,
    };
    this.maxBatchConcurrency = Math.max(
      1,
      options.maxBatchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
    );
  }

  async send(input: SMSSendInput): Promise<SMSSendOutput> {
    const parsed = parseInput<SMSSendInput>(smsSendInputParseSchema, input);
    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "send");
    const tags = composeMetricTags("sms", { provider: ADAPTER_NAME });

    const result = await recordLatency(
      () => this.sendInternal(parsed, logger),
      {
        metrics: this.metrics,
        metricName: CHANNEL_METRICS.sms.latency,
        tags,
      },
    );

    return { result };
  }

  async sendBatch(inputs: SMSSendBatchInput): Promise<SMSSendBatchOutput> {
    const parsed = parseInput<SMSSendBatchInput>(
      smsSendBatchInputParseSchema,
      inputs,
    );
    const concurrency = Math.min(this.maxBatchConcurrency, parsed.length);

    const results = await mapWithConcurrency(
      parsed,
      concurrency,
      async (item) => {
        const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "send");
        try {
          return await recordLatency(() => this.sendInternal(item, logger), {
            metrics: this.metrics,
            metricName: CHANNEL_METRICS.sms.latency,
            tags: composeMetricTags("sms", { provider: ADAPTER_NAME }),
          });
        } catch (error) {
          return this.errorResultFromError(error);
        }
      },
    );

    return buildBatchResult(results);
  }

  async health() {
    // SNS doesn't expose a lightweight "ping". We'll treat initialization as health.
    // If callers want more, we can optionally call GetSMSAttributes via AWS SDK,
    // but that requires extra permissions.
    return {
      ok: true,
      vendor: VENDOR_NAME,
      message: "ok",
    };
  }

  private async sendInternal(
    input: SMSSendInput,
    logger?: LoggerPort,
  ): Promise<SendResult> {
    const recipients = ensureArray(input.to);
    const tags = composeMetricTags("sms", { provider: ADAPTER_NAME });

    // Our numbers are registered for US delivery only; a non-NANP
    // destination is refused outright (SMS pumping / toll fraud). Thrown
    // before any Publish and before idempotency, and `invalid_input` is
    // never retried.
    if (recipients.some((recipient) => !isUsSmsNumber(recipient.toE164))) {
      this.metrics?.increment(
        CHANNEL_METRICS.sms.error,
        composeMetricTags("sms", {
          provider: ADAPTER_NAME,
          errorCode: "invalid_input",
        }),
      );
      logger?.warn("sns.send.non_us_destination_refused", {
        recipients: recipients.length,
      });
      throw new CommsPortError("invalid_input", "sms_destination_not_us");
    }

    const message = this.buildMessage(input);
    const messageAttributes = this.buildMessageAttributes(input);

    // SNS Publish is one recipient per request; we treat array `to` as one publish per recipient.
    const runOnce = async (): Promise<{
      messageId?: string;
      requestId?: string;
    }> => {
      let lastMessageId: string | undefined;
      let lastRequestId: string | undefined;

      for (const recipient of recipients) {
        const command = new PublishCommand({
          PhoneNumber: recipient.toE164,
          Message: message,
          MessageAttributes: messageAttributes,
        });

        const response = await withRetries(
          async () => {
            return await this.client.send(command);
          },
          {
            operation: "sns.send",
            logger,
            shouldRetry: (error) => isRetryableAwsError(error),
            redact: redactPhoneNumbers,
          },
        );

        lastMessageId = response.MessageId ?? lastMessageId;
        lastRequestId = response.$metadata?.requestId ?? lastRequestId;
      }

      return { messageId: lastMessageId, requestId: lastRequestId };
    };

    try {
      const idem = await runWithIdempotency<SendResult>({
        key: input.idempotencyKey,
        idempotency: this.idempotency,
        logger,
        redact: redactPhoneNumbers,
        run: async () => {
          const { messageId, requestId } = await runOnce();
          this.metrics?.increment(CHANNEL_METRICS.sms.sent, tags);
          logger?.info("sns.send.success", {
            messageId: messageId ?? null,
            recipients: recipients.length,
            requestId: requestId ?? null,
            idem: input.idempotencyKey ?? null,
          });
          return {
            result: successResult({ id: messageId }),
            vendorMessageId: messageId,
            metadata: {
              requestId,
            },
          };
        },
      });

      return idem.result.result;
    } catch (error) {
      const mapped = mapUnknownAwsError(error);
      this.metrics?.increment(
        CHANNEL_METRICS.sms.error,
        composeMetricTags("sms", {
          provider: ADAPTER_NAME,
          errorCode: mapped.code,
        }),
      );
      logger?.error("sns.send.failed", {
        // AWS error text can echo the destination number.
        error: redactPhoneNumbers(mapped.message),
        code: mapped.code,
        details: redactDeep(mapped.details ?? null, redactPhoneNumbers),
        idem: input.idempotencyKey ?? null,
      });
      throw mapped;
    }
  }

  private buildMessage(input: SMSSendInput): string {
    const body = input.body;
    if (typeof body !== "string" || body.length === 0) {
      throw new CommsPortError("invalid_input", "sms_body_required");
    }

    if (body.length <= MAX_TEXT_LENGTH) {
      return body;
    }
    return `${body.slice(0, Math.max(0, MAX_TEXT_LENGTH - 3))}...`;
  }

  private buildMessageAttributes(
    input: SMSSendInput,
  ): Record<string, { DataType: string; StringValue: string }> {
    const attrs: Record<string, { DataType: string; StringValue: string }> = {
      "AWS.SNS.SMS.SMSType": {
        DataType: "String",
        StringValue: this.defaultSmsType,
      },
    };

    const originationNumber = this.originationNumberFor(input);
    if (originationNumber) {
      attrs["AWS.MM.SMS.OriginationNumber"] = {
        DataType: "String",
        StringValue: originationNumber,
      };
    }

    // We currently don't map metadata/tags into SNS message attributes:
    // - SNS SMS attribute count/value limits are tight.
    // - Our metadata can be large/unbounded.
    // If needed later, we can add a safe allowlist.

    return attrs;
  }

  /**
   * The number registered for this purpose; the other one when only one is
   * configured; none when neither is (SNS then picks per account config).
   */
  private originationNumberFor(input: SMSSendInput): string | undefined {
    const { otp, notification } = this.originationNumbers;
    return input.purpose === "otp"
      ? (otp ?? notification)
      : (notification ?? otp);
  }

  private errorResultFromError(error: unknown): SendResult {
    if (error instanceof CommsPortError) {
      return errorResult(error.code, error.message, error.details);
    }
    if (error instanceof Error) {
      return errorResult("dependency_failed", error.message);
    }
    return errorResult("dependency_failed", "unknown_error", { error });
  }
}

function isRetryableAwsError(error: unknown): boolean {
  // AWS SDK v3 errors often include $metadata + name.
  if (typeof error !== "object" || error === null) return false;
  const anyErr = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = anyErr.$metadata?.httpStatusCode;
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const name = anyErr.name ?? "";
  return (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    name === "ServiceUnavailableException" ||
    name === "InternalErrorException"
  );
}

function mapUnknownAwsError(error: unknown): CommsPortError {
  if (error instanceof CommsPortError) return error;
  if (typeof error === "object" && error !== null) {
    const anyErr = error as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number; requestId?: string };
    };
    const status = anyErr.$metadata?.httpStatusCode;
    const code =
      status === 429
        ? "rate_limited"
        : status && status >= 500
          ? "transient"
          : "dependency_failed";
    return new CommsPortError(
      code,
      anyErr.message ?? anyErr.name ?? "sns_error",
      {
        name: anyErr.name ?? null,
        status: status ?? null,
        requestId: anyErr.$metadata?.requestId ?? null,
      },
    );
  }
  return new CommsPortError("dependency_failed", "sns_error", { error });
}
