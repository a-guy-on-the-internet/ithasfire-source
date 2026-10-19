import {
  Resend,
  type Attachment as ResendAttachment,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
  type ErrorResponse as ResendErrorResponse,
  type ListDomainsResponse,
  type Tag as ResendTag,
} from "resend";

import {
  render as renderTemplate,
  TemplateRenderError,
  type EmailFooterDefaults,
  type TemplateId,
  type TemplateProps,
} from "@th/ui-email";
import {
  mailerSendInputSchema,
  mailerSendBatchInputSchema,
  type MailerPort,
  type MailerSendBatchInput,
  type MailerSendBatchOutput,
  type MailerSendInput,
  type MailerSendOutput,
} from "@th/ports/comms/mailer";
import type { EmailDeliverabilityPort } from "@th/ports/comms/email-deliverability";
import {
  CommsPortError,
  type Attachment,
  type MailerRecipient,
  type SendResult,
} from "@th/ports/comms/index";
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
  runWithIdempotency,
  serializeError,
  successResult,
} from "../utils";
import type { ParseSchema } from "../utils";
import { escapeQuotedString, sanitizeDisplayName } from "./display-name";

const ADAPTER_NAME = "resend";
const VENDOR_NAME = "resend";

/**
 * RFC 2606 / RFC 6761 reserved domains + TLDs that can never reach a real
 * inbox. Seed/test fixtures use these (e.g. `example.com`), so sending to them
 * through a real ESP only produces hard bounces that erode domain sending
 * reputation. When `blockReservedTestDomains` is enabled the adapter skips
 * these recipients instead of handing them to Resend. Real addresses are
 * untouched and still send normally.
 */
const RESERVED_TEST_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
]);
const RESERVED_TEST_TLDS = new Set(["test", "example", "invalid", "localhost"]);

export function isReservedTestEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain) return false;
  if (RESERVED_TEST_DOMAINS.has(domain)) return true;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return RESERVED_TEST_TLDS.has(tld);
}
const DEFAULT_APP_HEADER = "Ithas Fire";
const DEFAULT_BATCH_CONCURRENCY = 4;

const SEND_INPUT_SCHEMA = mailerSendInputSchema as unknown as ParseSchema;
const SEND_BATCH_INPUT_SCHEMA =
  mailerSendBatchInputSchema as unknown as ParseSchema;

export interface ResendMailClient {
  emails: {
    send(
      payload: CreateEmailOptions,
      options?: CreateEmailRequestOptions,
    ): Promise<CreateEmailResponse>;
  };
  domains: {
    list(): Promise<ListDomainsResponse>;
  };
}

export interface ResendMailAdapterOptions {
  apiKey?: string;
  defaultFromEmail: string;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  idempotency?: IdempotencyPort;
  deliverability?: EmailDeliverabilityPort;
  client?: ResendMailClient;
  maxBatchConcurrency?: number;
  appHeaderValue?: string;
  renderer?: typeof renderTemplate;
  /** Resolves platform-level footer defaults (CAN-SPAM) injected at render time. */
  footerDefaultsProvider?: () => Promise<EmailFooterDefaults>;
  /**
   * When true, recipients on RFC-reserved test domains (example.com, .test,
   * .invalid, …) are skipped instead of sent, preventing seed-data hard
   * bounces. Default false. Enabled on the real-ESP path in deployed envs.
   */
  blockReservedTestDomains?: boolean;
}

export class ResendMailAdapter implements MailerPort {
  private readonly client: ResendMailClient;
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly idempotency?: IdempotencyPort;
  private readonly deliverability?: EmailDeliverabilityPort;
  private readonly defaultFrom: string;
  private readonly appHeaderValue: string;
  private readonly maxBatchConcurrency: number;
  private readonly renderer: typeof renderTemplate;
  private readonly footerDefaultsProvider?: () => Promise<EmailFooterDefaults>;
  private readonly blockReservedTestDomains: boolean;

  constructor(options: ResendMailAdapterOptions) {
    if (!options.defaultFromEmail) {
      throw new CommsPortError("invalid_input", "default_from_email_required");
    }
    if (!options.client && !options.apiKey) {
      throw new CommsPortError("invalid_input", "resend_api_key_required");
    }

    this.client = options.client ?? new Resend(options.apiKey);
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.idempotency = options.idempotency;
    this.deliverability = options.deliverability;
    this.defaultFrom = options.defaultFromEmail;
    this.appHeaderValue = options.appHeaderValue ?? DEFAULT_APP_HEADER;
    this.blockReservedTestDomains = options.blockReservedTestDomains ?? false;
    this.maxBatchConcurrency = Math.max(
      1,
      options.maxBatchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
    );
    this.renderer = options.renderer ?? renderTemplate;
    this.footerDefaultsProvider = options.footerDefaultsProvider;
  }

  async send(input: MailerSendInput): Promise<MailerSendOutput> {
    const parsed = parseInput<MailerSendInput>(SEND_INPUT_SCHEMA, input);
    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "send");
    const metricTags = composeMetricTags("mail", {
      templateKey: parsed.template?.key,
    });

    try {
      const result = await recordLatency(
        () => this.sendInternal(parsed, logger, metricTags),
        {
          metrics: this.metrics,
          metricName: CHANNEL_METRICS.mail.latency,
          tags: metricTags,
        },
      );
      return { result };
    } catch (error) {
      const mapped = mapResendError(error);
      this.metrics?.increment(
        CHANNEL_METRICS.mail.error,
        composeMetricTags("mail", {
          errorCode: mapped.code,
          templateKey: parsed.template?.key,
        }),
      );
      logger?.error("resend.send.failed", {
        ...serializeError(mapped),
        idem: parsed.idempotencyKey ?? null,
      });
      throw mapped;
    }
  }

  async sendBatch(
    inputs: MailerSendBatchInput,
  ): Promise<MailerSendBatchOutput> {
    const parsed = parseInput<MailerSendBatchInput>(
      SEND_BATCH_INPUT_SCHEMA,
      inputs,
    );

    const results = await mapWithConcurrency(
      parsed,
      this.maxBatchConcurrency,
      async (item) => {
        const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "send");
        const metricTags = composeMetricTags("mail", {
          templateKey: item.template?.key,
        });
        try {
          return await recordLatency(
            () => this.sendInternal(item, logger, metricTags),
            {
              metrics: this.metrics,
              metricName: CHANNEL_METRICS.mail.latency,
              tags: metricTags,
            },
          );
        } catch (error) {
          const mapped = mapResendError(error);
          this.metrics?.increment(
            CHANNEL_METRICS.mail.error,
            composeMetricTags("mail", {
              errorCode: mapped.code,
              templateKey: item.template?.key,
            }),
          );
          logger?.error("resend.send.failed", {
            ...serializeError(mapped),
            idem: item.idempotencyKey ?? null,
          });
          return this.errorResultFromError(mapped);
        }
      },
    );

    return buildBatchResult(results);
  }

  async health() {
    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "health");
    const startedAt = Date.now();
    try {
      const response = await this.client.domains.list();
      if (response.error) {
        throw response.error;
      }

      return {
        ok: true,
        vendor: VENDOR_NAME,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const mapped = mapResendError(error);
      this.metrics?.increment(
        CHANNEL_METRICS.mail.error,
        composeMetricTags("mail", { errorCode: mapped.code }),
      );
      logger?.error("resend.health.failed", serializeError(mapped));
      return {
        ok: false,
        vendor: VENDOR_NAME,
        latencyMs: Date.now() - startedAt,
        message: mapped.message,
      };
    }
  }

  private async sendInternal(
    input: MailerSendInput,
    logger?: LoggerPort,
    metricTags?: Record<string, string>,
  ): Promise<SendResult> {
    const to = ensureArray(input.to);
    if (to.length === 0) {
      throw new CommsPortError("invalid_input", "recipient_required");
    }

    // Skip RFC-reserved test domains (seed/fixture addresses like
    // `example.com`) before hitting Resend — they only hard-bounce and hurt
    // sending reputation. Mirrors the suppression skip below. All-or-nothing:
    // if any recipient is a test address, the whole send is skipped (sends in
    // this app are single-recipient).
    if (this.blockReservedTestDomains) {
      const testRecipients = to.filter((recipient) =>
        isReservedTestEmail(recipient.to),
      );
      if (testRecipients.length > 0) {
        logger?.info("resend.send.skipped_reserved_test_domain", {
          recipientCount: testRecipients.length,
          idem: input.idempotencyKey ?? null,
          template: input.template?.key ?? null,
        });
        this.metrics?.increment(
          "comms.mail.skipped_test_domain",
          metricTags ?? composeMetricTags("mail"),
        );
        return errorResult("conflict", "recipient_reserved_test_domain", {
          testDomainRecipientCount: testRecipients.length,
        });
      }
    }

    const suppressed = await this.findSuppressedRecipients(to);
    if (suppressed.length > 0) {
      logger?.warn("resend.send.suppressed", {
        suppressedRecipientCount: suppressed.length,
        statuses: Array.from(
          new Set(suppressed.map((recipient) => recipient.status)),
        ),
        authUserIds: Array.from(
          new Set(
            suppressed
              .map((recipient) => recipient.authUserId)
              .filter((id): id is string => Boolean(id)),
          ),
        ),
        idem: input.idempotencyKey ?? null,
        template: input.template?.key ?? null,
      });
      this.metrics?.increment(
        "comms.mail.suppressed",
        metricTags ?? composeMetricTags("mail"),
      );
      return errorResult("conflict", "recipient_suppressed", {
        suppressedRecipients: suppressed,
      });
    }

    const from = this.resolveFromAddress(input.from);

    try {
      const idem = await runWithIdempotency({
        key: input.idempotencyKey,
        idempotency: this.idempotency,
        logger,
        run: async () => {
          const email = await this.buildEmail({ input, from, to });
          const requestOptions = input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : undefined;
          const response = await this.client.emails.send(email, requestOptions);

          if (response.error) {
            throw mapResendError(response.error);
          }

          const messageId = response.data?.id;
          if (!messageId) {
            throw new CommsPortError(
              "dependency_failed",
              "resend_missing_message_id",
            );
          }

          logger?.info("resend.send.success", {
            messageId,
            recipients: to.length,
            idem: input.idempotencyKey ?? null,
            template: input.template?.key ?? null,
          });

          if (metricTags) {
            this.metrics?.increment(CHANNEL_METRICS.mail.sent, metricTags);
          }

          return {
            result: successResult({ id: messageId }),
            vendorMessageId: messageId,
            metadata: {
              headers: response.headers ?? null,
            },
          };
        },
      });

      if (!idem.fresh) {
        logger?.info("resend.send.replay", {
          idem: input.idempotencyKey ?? null,
        });
      }

      return idem.result.result;
    } catch (error) {
      throw mapResendError(error);
    }
  }

  private async buildEmail(params: {
    input: MailerSendInput;
    from: string;
    to: MailerRecipient[];
  }): Promise<CreateEmailOptions> {
    const { input, from, to } = params;
    let subject = input.subject;
    let html = input.html;
    let text = input.text;

    if (input.template?.key) {
      const templateId = input.template.key as TemplateId;
      const templateProps = (input.template.variables ??
        {}) as TemplateProps<TemplateId>;

      try {
        const footer = this.footerDefaultsProvider
          ? await this.footerDefaultsProvider()
          : undefined;
        const rendered = await this.renderer({
          templateId,
          props: templateProps,
          locale: input.localization?.locale,
          footer,
        });
        subject = subject ?? rendered.subject;
        html = html ?? rendered.html;
        text = text ?? rendered.text;
      } catch (error) {
        if (error instanceof TemplateRenderError) {
          throw new CommsPortError("invalid_input", error.message, {
            code: error.code,
            details: error.details,
          });
        }
        throw error;
      }
    }

    if (!subject) {
      throw new CommsPortError("invalid_input", "email_subject_required");
    }

    if (!html && !text) {
      throw new CommsPortError("invalid_input", "email_body_required");
    }

    const attachments = (input.attachments ?? []).map((attachment) =>
      this.mapAttachment(attachment),
    );
    const headers = this.buildHeaders(input);
    const tags = this.buildTags(input);
    const replyToAddr = input.replyTo ?? input.from;
    const baseEmail = {
      from,
      to: to.map(formatEmailAddress),
      subject,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: replyToAddr ? formatEmailAddress(replyToAddr) : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      tags: tags.length > 0 ? tags : undefined,
    };

    if (html && text) {
      return {
        ...baseEmail,
        html,
        text,
      };
    }

    if (html) {
      return {
        ...baseEmail,
        html,
      };
    }

    return {
      ...baseEmail,
      text: text!,
    };
  }

  private resolveFromAddress(from?: MailerRecipient): string {
    if (!from) {
      return this.defaultFrom;
    }
    if (!from.to) {
      throw new CommsPortError("invalid_input", "from_address_invalid");
    }
    return formatEmailAddress(from);
  }

  private buildHeaders(input: MailerSendInput): Record<string, string> {
    const headers: Record<string, string> = {
      "X-App": this.appHeaderValue,
    };

    if (input.template?.key) {
      headers["X-Template"] = input.template.key;
    }
    if (input.template?.version) {
      headers["X-Template-Version"] = input.template.version;
    }
    if (input.idempotencyKey) {
      headers["X-Idempotency-Key"] = input.idempotencyKey;
    }
    if (input.tags && input.tags.length > 0) {
      headers["X-Tags"] = input.tags.join(",");
    }
    if (input.metadata) {
      for (const [key, value] of Object.entries(input.metadata)) {
        const sanitized = sanitizeHeaderKey(key);
        if (sanitized && value) {
          headers[`X-Meta-${sanitized}`] = value;
        }
      }
    }
    if (input.headers) {
      for (const [key, value] of Object.entries(input.headers)) {
        if (key && value) {
          headers[key] = value;
        }
      }
    }

    return headers;
  }

  private buildTags(input: MailerSendInput): ResendTag[] {
    const tags: ResendTag[] = [];

    if (input.metadata) {
      for (const [key, value] of Object.entries(input.metadata)) {
        const name = sanitizeTagPart(`meta_${key}`);
        const tagValue = sanitizeTagPart(value);
        if (name && tagValue) {
          tags.push({ name, value: tagValue });
        }
      }
    }

    for (const tag of input.tags ?? []) {
      const name = sanitizeTagPart(`tag_${tag}`);
      if (name) {
        tags.push({ name, value: "1" });
      }
    }

    return tags;
  }

  private mapAttachment(attachment: Attachment): ResendAttachment {
    return {
      filename: attachment.filename,
      content: Buffer.from(attachment.bytesBase64, "base64"),
      contentType: attachment.mime,
    };
  }

  private errorResultFromError(error: CommsPortError): SendResult {
    return errorResult(error.code, error.message, error.details);
  }

  private async findSuppressedRecipients(to: MailerRecipient[]) {
    if (!this.deliverability) return [];

    const suppressed: Array<{
      email: string;
      status: "BOUNCED" | "COMPLAINED";
      statusAt: Date | null;
      statusRef: string | null;
      authUserId: string | null;
    }> = [];

    for (const recipient of to) {
      const record = await this.deliverability.getByEmail(recipient.to);
      if (record?.status === "BOUNCED" || record?.status === "COMPLAINED") {
        suppressed.push({
          email: recipient.to,
          status: record.status,
          statusAt: record.statusAt,
          statusRef: record.statusRef,
          authUserId: record.authUserId,
        });
      }
    }

    return suppressed;
  }
}

const formatEmailAddress = (recipient: MailerRecipient): string => {
  const name = recipient.name ? sanitizeDisplayName(recipient.name) : "";
  return name
    ? `"${escapeQuotedString(name)}" <${recipient.to}>`
    : recipient.to;
};

const sanitizeHeaderKey = (key: string): string =>
  key
    .trim()
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

const sanitizeTagPart = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 256);

const mapResendError = (error: unknown): CommsPortError => {
  if (error instanceof CommsPortError) {
    return error;
  }
  if (error instanceof TemplateRenderError) {
    return new CommsPortError("invalid_input", error.message, {
      code: error.code,
      details: error.details,
    });
  }

  const err = error as Partial<ResendErrorResponse> & {
    message?: string;
    name?: string;
    statusCode?: number | null;
  };
  const message =
    err.message ?? (error as Error | undefined)?.message ?? "resend_error";
  const vendorCode =
    err.name ?? (error as Error | undefined)?.name ?? "resend_error";
  const vendorStatus =
    typeof err.statusCode === "number" ? err.statusCode : null;

  if (vendorStatus === 400 || /validation/i.test(vendorCode)) {
    return new CommsPortError("invalid_input", message, {
      vendorCode,
      vendorStatus,
    });
  }
  if (
    vendorStatus === 401 ||
    vendorStatus === 403 ||
    /forbidden|unauthor/i.test(vendorCode)
  ) {
    return new CommsPortError("unauthorized", message, {
      vendorCode,
      vendorStatus,
    });
  }
  if (vendorStatus === 404 || /not[_-]?found/i.test(vendorCode)) {
    return new CommsPortError("not_found", message, {
      vendorCode,
      vendorStatus,
    });
  }
  if (vendorStatus === 409 || /conflict/i.test(vendorCode)) {
    return new CommsPortError("conflict", message, {
      vendorCode,
      vendorStatus,
    });
  }
  if (
    vendorStatus === 429 ||
    /rate|too[_ -]?many/i.test(`${vendorCode} ${message}`)
  ) {
    return new CommsPortError("rate_limited", message, {
      vendorCode,
      vendorStatus,
    });
  }
  if ((vendorStatus ?? 0) >= 500) {
    return new CommsPortError("transient", message, {
      vendorCode,
      vendorStatus,
    });
  }

  return new CommsPortError("dependency_failed", message, {
    vendorCode,
    vendorStatus,
  });
};
