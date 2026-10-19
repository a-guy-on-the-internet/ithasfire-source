import { randomUUID } from "node:crypto";

import {
  SESv2Client,
  SendEmailCommand,
  GetAccountCommand,
  type SendEmailCommandInput,
  type MessageTag,
  type SESv2ServiceException,
} from "@aws-sdk/client-sesv2";

import {
  mailerSendInputSchema,
  mailerSendBatchInputSchema,
  type MailerPort,
  type MailerSendInput,
  type MailerSendOutput,
  type MailerSendBatchInput,
  type MailerSendBatchOutput,
} from "@th/ports/comms/mailer";
import {
  CommsPortError,
  type SendResult,
  type MailerRecipient,
  type Attachment,
} from "@th/ports/comms/index";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { IdempotencyPort } from "@th/ports/idempotency";

import {
  CHANNEL_METRICS,
  composeMetricTags,
  createAdapterLogger,
  parseInput,
  ensureArray,
  runWithIdempotency,
  withRetries,
  recordLatency,
  successResult,
  errorResult,
  buildBatchResult,
  chunkArray,
} from "../utils";
import type { ParseSchema } from "../utils";
import { escapeQuotedString, sanitizeDisplayName } from "./display-name";

const ADAPTER_NAME = "ses";
const VENDOR_NAME = "aws-ses";
const MAX_BATCH_SIZE = 50;
const RETRYABLE_CODES: Array<CommsPortError["code"]> = [
  "rate_limited",
  "transient",
];

const SEND_INPUT_SCHEMA = mailerSendInputSchema as unknown as ParseSchema;
const SEND_BATCH_INPUT_SCHEMA =
  mailerSendBatchInputSchema as unknown as ParseSchema;

type SesClient = SESv2Client;

export interface SESMailerAdapterOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultFromEmail: string;
  configurationSetName?: string;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  idempotency?: IdempotencyPort;
  client?: SesClient;
  maxBatchSize?: number;
}

export class SESMailerAdapter implements MailerPort {
  private readonly client: SesClient;
  private readonly defaultFrom: string;
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly idempotency?: IdempotencyPort;
  private readonly configurationSetName?: string;
  private readonly maxBatchSize: number;

  constructor(options: SESMailerAdapterOptions) {
    this.defaultFrom = options.defaultFromEmail;
    if (!this.defaultFrom) {
      throw new CommsPortError("invalid_input", "default_from_email_required");
    }

    this.logger = options.logger;
    this.metrics = options.metrics;
    this.idempotency = options.idempotency;
    this.configurationSetName = options.configurationSetName;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? MAX_BATCH_SIZE);

    this.client =
      options.client ??
      new SESv2Client({
        region: options.region,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      });
  }

  async send(input: MailerSendInput): Promise<MailerSendOutput> {
    const parsed = parseInput<MailerSendInput>(SEND_INPUT_SCHEMA, input);
    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "send");
    const result = await recordLatency(
      () => this.sendInternal(parsed, logger),
      {
        metrics: this.metrics,
        metricName: CHANNEL_METRICS.mail.latency,
        tags: composeMetricTags("mail", {
          templateKey: parsed.template?.key,
        }),
      },
    );

    return { result };
  }

  async sendBatch(
    inputs: MailerSendBatchInput,
  ): Promise<MailerSendBatchOutput> {
    const parsedBatch = parseInput<MailerSendBatchInput>(
      SEND_BATCH_INPUT_SCHEMA,
      inputs,
    );
    const batches = chunkArray(parsedBatch, this.maxBatchSize);
    const results: SendResult[] = [];

    for (const batch of batches) {
      const settled = await Promise.all(
        batch.map(async (item) => {
          try {
            const logger = createAdapterLogger(
              this.logger,
              ADAPTER_NAME,
              "send",
            );
            return await recordLatency(() => this.sendInternal(item, logger), {
              metrics: this.metrics,
              metricName: CHANNEL_METRICS.mail.latency,
              tags: composeMetricTags("mail", {
                templateKey: item.template?.key,
              }),
            });
          } catch (error) {
            return this.errorResultFromError(error);
          }
        }),
      );
      results.push(...settled);
    }

    return buildBatchResult(results);
  }

  async health() {
    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "health");
    const start = Date.now();
    try {
      await this.client.send(new GetAccountCommand({}));
      const latencyMs = Date.now() - start;
      return {
        ok: true,
        vendor: VENDOR_NAME,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      logger?.error("ses.health.failed", serializeForLog(error));
      this.metrics?.increment(
        CHANNEL_METRICS.mail.error,
        composeMetricTags("mail", { errorCode: "dependency_failed" }),
      );
      return {
        ok: false,
        vendor: VENDOR_NAME,
        latencyMs,
        message: (error as Error)?.message ?? "unknown",
      };
    }
  }

  private async sendInternal(
    input: MailerSendInput,
    logger?: LoggerPort,
  ): Promise<SendResult> {
    const to = ensureArray(input.to);
    if (to.length === 0) {
      throw new CommsPortError("invalid_input", "recipient_required");
    }
    if (input.attachments && input.attachments.length > 0 && input.template) {
      throw new CommsPortError(
        "invalid_input",
        "template_with_attachments_not_supported",
      );
    }

    const from = this.resolveFromAddress(input.from);
    const tags = composeMetricTags("mail", {
      templateKey: input.template?.key,
    });

    try {
      const idemResult = await runWithIdempotency<SendResult>({
        key: input.idempotencyKey,
        idempotency: this.idempotency,
        run: async () => {
          const response = await withRetries(
            async () => {
              try {
                return await this.client.send(
                  this.buildSendCommand({ input, from, to }),
                );
              } catch (error) {
                throw mapSesError(error);
              }
            },
            {
              operation: "ses.send",
              logger,
              shouldRetry: (error) => isRetryableCommsError(error),
              onGiveUp: ({ error }) => {
                this.metrics?.increment(
                  CHANNEL_METRICS.mail.error,
                  composeMetricTags("mail", { errorCode: "transient" }),
                );
                logger?.error("ses.send.giveup", serializeForLog(error));
              },
            },
          );

          const messageId = response.MessageId ?? undefined;
          logger?.info("ses.send.success", {
            messageId: messageId ?? null,
            recipients: to.length,
            idem: input.idempotencyKey ?? null,
            template: input.template?.key ?? null,
          });

          this.metrics?.increment(CHANNEL_METRICS.mail.sent, tags);

          return {
            result: successResult({ id: messageId }),
            vendorMessageId: messageId,
            metadata: {
              requestId: response.$metadata?.requestId ?? null,
            },
          };
        },
      });

      return idemResult.result.result;
    } catch (error) {
      const mapped = mapSesError(error);
      this.metrics?.increment(
        CHANNEL_METRICS.mail.error,
        composeMetricTags("mail", { errorCode: mapped.code }),
      );
      logger?.error("ses.send.failed", {
        ...serializeForLog(mapped),
        idem: input.idempotencyKey ?? null,
      });
      throw mapped;
    }
  }

  private resolveFromAddress(from?: MailerRecipient): string {
    if (!from || !from.to) {
      return this.defaultFrom;
    }
    if (!from.name) {
      return from.to;
    }
    return formatEmailAddress(from);
  }

  private buildSendCommand(params: {
    input: MailerSendInput;
    from: string;
    to: MailerRecipient[];
  }): SendEmailCommand {
    const { input, from, to } = params;
    const destination = {
      ToAddresses: to.map((recipient) => recipient.to),
    };

    const metadata = input.metadata ?? {};
    const tagList = input.tags ?? [];
    const messageTags = createMessageTags(metadata, tagList);

    const content = this.buildContent({ input, from, to });

    const replyToAddr = input.replyTo ?? input.from;

    const commandInput: SendEmailCommandInput = {
      FromEmailAddress: from,
      Destination: destination,
      EmailTags: messageTags,
      Content: content,
      ConfigurationSetName: this.configurationSetName,
      ReplyToAddresses: replyToAddr ? [replyToAddr.to] : undefined,
    };

    return new SendEmailCommand(commandInput);
  }

  private buildContent(params: {
    input: MailerSendInput;
    from: string;
    to: MailerRecipient[];
  }): SendEmailCommandInput["Content"] {
    const { input, from, to } = params;
    const hasCustomHeaders =
      input.headers && Object.keys(input.headers).length > 0;

    if (input.attachments && input.attachments.length > 0) {
      const raw = buildRawMessage({
        from,
        to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        attachments: input.attachments,
        headers: input.headers,
      });
      return {
        Raw: {
          Data: Buffer.from(raw, "utf-8"),
        },
      };
    }

    // SES Simple content doesn't support arbitrary headers (e.g.
    // List-Unsubscribe). Fall back to Raw when custom headers are present.
    if (hasCustomHeaders) {
      const raw = buildRawMessage({
        from,
        to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        attachments: [],
        headers: input.headers,
      });
      return {
        Raw: {
          Data: Buffer.from(raw, "utf-8"),
        },
      };
    }

    if (input.template) {
      const templateVersion = input.template.version;
      const templateArn =
        templateVersion && templateVersion.startsWith("arn:")
          ? templateVersion
          : undefined;
      const templateData = {
        ...input.template.variables,
        ...(templateVersion && !templateArn
          ? { _version: templateVersion }
          : {}),
      };
      return {
        Template: {
          TemplateName: input.template.key,
          TemplateArn: templateArn,
          TemplateData: JSON.stringify(templateData),
        },
      };
    }

    const simpleContent = {
      Body: {
        Text: input.text
          ? {
              Data: input.text,
            }
          : undefined,
        Html: input.html
          ? {
              Data: input.html,
            }
          : undefined,
      },
      Subject: input.subject
        ? {
            Data: input.subject,
          }
        : undefined,
    };

    if (!simpleContent.Body.Text && !simpleContent.Body.Html) {
      throw new CommsPortError("invalid_input", "email_body_required");
    }

    return {
      Simple: simpleContent,
    };
  }

  private errorResultFromError(error: unknown): SendResult {
    const mapped = mapSesError(error);
    return errorResult(mapped.code, mapped.message, mapped.details);
  }
}

/**
 * Sanitized (control characters out, line breaks collapsed) and quote-escaped
 * so a name can neither break a header line nor close the quoted string and
 * add a mailbox. Same rules as the Resend and SMTP adapters.
 */
const formatEmailAddress = (recipient: MailerRecipient): string => {
  const name = recipient.name ? sanitizeDisplayName(recipient.name) : "";
  return name
    ? `"${escapeQuotedString(name)}" <${recipient.to}>`
    : recipient.to;
};

/**
 * Header-injection hardening: strip CR/LF from a value before it is
 * interpolated into a raw MIME header line, so it can't smuggle extra headers.
 */
const stripHeaderNewlines = (value: string): string =>
  value.replace(/[\r\n]/g, " ");

/** {@link formatEmailAddress} with CR/LF stripped from the name and address. */
const formatSafeEmailAddress = (recipient: MailerRecipient): string => {
  const name = recipient.name ? sanitizeDisplayName(recipient.name) : "";
  const address = stripHeaderNewlines(recipient.to);
  return name ? `"${escapeQuotedString(name)}" <${address}>` : address;
};

const createMessageTags = (
  metadata: Record<string, string>,
  tags: string[],
): MessageTag[] => {
  const messageTags: MessageTag[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (key && value) {
      messageTags.push({ Name: sanitizeTagName(key), Value: value });
    }
  }
  tags.forEach((tag) => {
    const trimmed = tag.trim();
    if (trimmed.length > 0) {
      messageTags.push({ Name: sanitizeTagName(`tag:${trimmed}`), Value: "1" });
    }
  });
  return messageTags.slice(0, 50);
};

const sanitizeTagName = (name: string): string =>
  name.replace(/[^A-Za-z0-9_.:/=+@-]/g, "_").slice(0, 256);

const mapSesError = (error: unknown): CommsPortError => {
  if (error instanceof CommsPortError) {
    return error;
  }

  const err = error as Partial<SESv2ServiceException> & { message?: string };
  const status = err.$metadata?.httpStatusCode ?? 0;
  const requestId = err.$metadata?.requestId;
  const name = err.name ?? "SESUnknownError";
  const message = err.message ?? name;

  if (status === 400 || name.includes("Validation")) {
    return new CommsPortError("invalid_input", message, {
      requestId,
      vendorStatus: status,
      vendorCode: name,
    });
  }

  if (status === 401 || status === 403 || name.includes("AccessDenied")) {
    return new CommsPortError("unauthorized", message, {
      requestId,
      vendorStatus: status,
      vendorCode: name,
    });
  }

  if (status === 404 || name.includes("NotFound")) {
    return new CommsPortError("not_found", message, {
      requestId,
      vendorStatus: status,
      vendorCode: name,
    });
  }

  if (status === 409 || name.includes("Conflict")) {
    return new CommsPortError("conflict", message, {
      requestId,
      vendorStatus: status,
      vendorCode: name,
    });
  }

  if (status === 429 || /TooManyRequests|Throttl/i.test(name)) {
    return new CommsPortError("rate_limited", message, {
      requestId,
      vendorStatus: status,
      vendorCode: name,
    });
  }

  if (status >= 500) {
    return new CommsPortError("transient", message, {
      requestId,
      vendorStatus: status,
      vendorCode: name,
    });
  }

  return new CommsPortError("dependency_failed", message, {
    requestId,
    vendorStatus: status,
    vendorCode: name,
  });
};

const isRetryableCommsError = (error: unknown): boolean => {
  if (!(error instanceof CommsPortError)) {
    return false;
  }
  return RETRYABLE_CODES.includes(error.code);
};

const serializeForLog = (error: unknown) => ({
  error:
    error instanceof CommsPortError
      ? {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        }
      : {
          name: (error as Error)?.name ?? "Error",
          message: (error as Error)?.message ?? "unknown",
        },
});

const buildRawMessage = (params: {
  from: string;
  to: MailerRecipient[];
  subject?: string;
  text?: string;
  html?: string;
  attachments: Attachment[];
  headers?: Record<string, string>;
}): string => {
  const {
    from,
    to,
    subject,
    text,
    html,
    attachments,
    headers: extraHeaders,
  } = params;
  if (!text && !html) {
    throw new CommsPortError("invalid_input", "raw_email_body_required");
  }
  const boundaryMixed = `mixed_${randomUUID()}`;
  const boundaryAlt = `alt_${randomUUID()}`;
  // Header-injection hardening: any CR/LF folded into a header value would let
  // a caller inject arbitrary headers into the raw MIME. Strip CR/LF (replace
  // with a space) from every value interpolated into a header line — subject,
  // from, and each recipient name/address.
  const safeSubject = subject ? stripHeaderNewlines(subject) : subject;
  const safeFrom = stripHeaderNewlines(from);
  const headers = [
    `From: ${safeFrom}`,
    `To: ${to.map((recipient) => formatSafeEmailAddress(recipient)).join(", ")}`,
    safeSubject ? `Subject: ${safeSubject}` : undefined,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
  ]
    .filter(Boolean)
    .join("\r\n");

  // Append caller-supplied headers (e.g. List-Unsubscribe)
  let extraHeaderBlock = "";
  if (extraHeaders) {
    const lines = Object.entries(extraHeaders)
      .filter(([k, v]) => k && v)
      .map(([k, v]) => `${k}: ${v}`);
    if (lines.length > 0) {
      extraHeaderBlock = "\r\n" + lines.join("\r\n");
    }
  }

  const parts: string[] = [];

  parts.push(`--${boundaryMixed}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
  parts.push("");

  if (text) {
    parts.push(`--${boundaryAlt}`);
    parts.push('Content-Type: text/plain; charset="UTF-8"');
    parts.push("Content-Transfer-Encoding: 7bit");
    parts.push("");
    parts.push(text);
    parts.push("");
  }

  if (html) {
    parts.push(`--${boundaryAlt}`);
    parts.push('Content-Type: text/html; charset="UTF-8"');
    parts.push("Content-Transfer-Encoding: 7bit");
    parts.push("");
    parts.push(html);
    parts.push("");
  }

  parts.push(`--${boundaryAlt}--`);
  parts.push("");

  for (const attachment of attachments) {
    parts.push(`--${boundaryMixed}`);
    parts.push(
      `Content-Type: ${attachment.mime}; name=\"${attachment.filename}\"`,
    );
    parts.push("Content-Disposition: attachment");
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    parts.push(wrapBase64(attachment.bytesBase64));
    parts.push("");
  }

  parts.push(`--${boundaryMixed}--`);
  parts.push("");

  return `${headers}${extraHeaderBlock}\r\n\r\n${parts.join("\r\n")}`;
};

const wrapBase64 = (value: string): string => {
  const chunkSize = 76;
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks.join("\r\n");
};
