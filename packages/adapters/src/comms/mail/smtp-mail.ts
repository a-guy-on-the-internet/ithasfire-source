import {
  createTransport,
  type SendMailOptions,
  type Transporter,
} from "nodemailer";
import SMTPTransport from "nodemailer/lib/smtp-transport";

type NodemailerAttachment = NonNullable<SendMailOptions["attachments"]>[number];

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
  ensureArray,
  parseInput,
  runWithIdempotency,
  recordLatency,
  successResult,
  errorResult,
  buildBatchResult,
  mapWithConcurrency,
  serializeError,
} from "../utils";
import type { ParseSchema } from "../utils";
import { escapeQuotedString, sanitizeDisplayName } from "./display-name";

const ADAPTER_NAME = "smtp";
const VENDOR_NAME = "smtp";
const DEFAULT_APP_HEADER = "Ithas Fire";
const DEFAULT_BATCH_CONCURRENCY = 4;

const SEND_INPUT_SCHEMA = mailerSendInputSchema as unknown as ParseSchema;
const SEND_BATCH_INPUT_SCHEMA =
  mailerSendBatchInputSchema as unknown as ParseSchema;

export type NodemailerTransport = Transporter<SMTPTransport.SentMessageInfo>;

export interface SMTPMailAdapterOptions {
  host: string;
  port: number;
  secure?: boolean;
  username?: string;
  password?: string;
  defaultFromEmail: string;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  idempotency?: IdempotencyPort;
  pool?: boolean;
  /**
   * Nodemailer option: when true, prevents upgrading connections via STARTTLS.
   * Useful for local SMTP sinks like Mailpit (plain-text on 1025).
   */
  ignoreTLS?: boolean;
  /**
   * Nodemailer option: when true, requires STARTTLS upgrade.
   * (We typically keep this false for local dev/test sinks.)
   */
  requireTLS?: boolean;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
  greetingTimeoutMs?: number;
  maxBatchConcurrency?: number;
  transporter?: NodemailerTransport;
  appHeaderValue?: string;
  tls?: SMTPTransport.Options["tls"];
  renderer?: typeof renderTemplate;
  /** Resolves platform-level footer defaults (CAN-SPAM) injected at render time. */
  footerDefaultsProvider?: () => Promise<EmailFooterDefaults>;
}

export class SMTPMailAdapter implements MailerPort {
  private readonly transport: NodemailerTransport;
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly idempotency?: IdempotencyPort;
  private readonly defaultFrom: string;
  private readonly appHeaderValue: string;
  private readonly maxBatchConcurrency: number;
  private readonly renderer: typeof renderTemplate;
  private readonly footerDefaultsProvider?: () => Promise<EmailFooterDefaults>;

  constructor(options: SMTPMailAdapterOptions) {
    if (!options.defaultFromEmail) {
      throw new CommsPortError("invalid_input", "default_from_email_required");
    }

    this.logger = options.logger;
    this.metrics = options.metrics;
    this.idempotency = options.idempotency;
    this.defaultFrom = options.defaultFromEmail;
    this.appHeaderValue = options.appHeaderValue ?? DEFAULT_APP_HEADER;
    this.maxBatchConcurrency = Math.max(
      1,
      options.maxBatchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
    );
    this.renderer = options.renderer ?? renderTemplate;
    this.footerDefaultsProvider = options.footerDefaultsProvider;

    if (options.transporter) {
      this.transport = options.transporter;
    } else {
      const auth =
        options.username && options.password
          ? { user: options.username, pass: options.password }
          : undefined;
      // Nodemailer supports additional options like `pool` beyond the core SMTPTransport.Options type.
      const transportOptions: SMTPTransport.Options & {
        pool?: boolean;
        ignoreTLS?: boolean;
        requireTLS?: boolean;
      } = {
        host: options.host,
        port: options.port,
        secure: options.secure ?? false,
        pool: options.pool ?? false,
        auth,
        // Important for test SMTP sinks:
        // - ignoreTLS=true ensures Nodemailer won't attempt STARTTLS upgrades.
        // - requireTLS=false ensures we don't require STARTTLS.
        ignoreTLS: options.ignoreTLS,
        requireTLS: options.requireTLS,
        connectionTimeout: options.connectionTimeoutMs,
        greetingTimeout: options.greetingTimeoutMs,
        socketTimeout: options.socketTimeoutMs,
        disableFileAccess: true,
        disableUrlAccess: true,
        tls: options.tls,
      };
      this.transport = createTransport(transportOptions);
    }
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
      const mapped = mapSmtpError(error);
      this.metrics?.increment(
        CHANNEL_METRICS.mail.error,
        composeMetricTags("mail", {
          errorCode: mapped.code,
          templateKey: parsed.template?.key,
        }),
      );
      logger?.error("smtp.send.failed", {
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
          const mapped = mapSmtpError(error);
          this.metrics?.increment(
            CHANNEL_METRICS.mail.error,
            composeMetricTags("mail", {
              errorCode: mapped.code,
              templateKey: item.template?.key,
            }),
          );
          logger?.error("smtp.send.failed", {
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
      await this.transport.verify();
      const latencyMs = Date.now() - startedAt;
      return {
        ok: true,
        vendor: VENDOR_NAME,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const mapped = mapSmtpError(error);
      this.metrics?.increment(
        CHANNEL_METRICS.mail.error,
        composeMetricTags("mail", { errorCode: mapped.code }),
      );
      logger?.error("smtp.health.failed", {
        ...serializeError(mapped),
      });
      return {
        ok: false,
        vendor: VENDOR_NAME,
        latencyMs,
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

    const from = this.resolveFromAddress(input.from);

    try {
      const idem = await runWithIdempotency({
        key: input.idempotencyKey,
        idempotency: this.idempotency,
        logger,
        run: async () => {
          const message = await this.buildMessage({ input, from, to });
          let response: SMTPTransport.SentMessageInfo;
          try {
            response = await this.transport.sendMail(message);
          } catch (error) {
            throw mapSmtpError(error);
          }

          const messageId =
            typeof response.messageId === "string"
              ? response.messageId
              : undefined;

          logger?.info("smtp.send.success", {
            messageId: messageId ?? null,
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
              accepted: response.accepted,
              rejected: response.rejected,
              response: response.response,
            },
          };
        },
      });

      if (!idem.fresh) {
        logger?.info("smtp.send.replay", {
          idem: input.idempotencyKey ?? null,
        });
      }

      return idem.result.result;
    } catch (error) {
      throw mapSmtpError(error);
    }
  }

  private async buildMessage(params: {
    input: MailerSendInput;
    from: string;
    to: MailerRecipient[];
  }): Promise<SendMailOptions> {
    const { input, from, to } = params;
    let subject = input.subject;
    let html = input.html;
    let text = input.text;
    const templateKey = input.template?.key;

    if (templateKey) {
      const templateId = templateKey as TemplateId;
      const templateProps = (input.template?.variables ??
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
          const templateError = error as TemplateRenderError;
          throw new CommsPortError("invalid_input", templateError.message, {
            code: templateError.code,
            details: templateError.details,
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

    const replyToAddr = input.replyTo ?? input.from;

    return {
      from,
      to: to.map(formatEmailAddress),
      subject,
      html: html ?? undefined,
      text: text ?? undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: replyToAddr ? formatEmailAddress(replyToAddr) : undefined,
      headers,
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
    // Merge caller-supplied headers (e.g. List-Unsubscribe)
    if (input.headers) {
      for (const [key, value] of Object.entries(input.headers)) {
        if (key && value) {
          headers[key] = value;
        }
      }
    }
    return headers;
  }

  private mapAttachment(attachment: Attachment): NodemailerAttachment {
    return {
      filename: attachment.filename,
      content: Buffer.from(attachment.bytesBase64, "base64"),
      contentType: attachment.mime,
    };
  }

  private errorResultFromError(error: CommsPortError): SendResult {
    return errorResult(error.code, error.message, error.details);
  }
}

const formatEmailAddress = (recipient: MailerRecipient): string => {
  // Sanitized and quote-escaped so a hostile name can neither break the
  // header line nor close the quoted string and append a second mailbox.
  const name = recipient.name ? sanitizeDisplayName(recipient.name) : "";
  return name
    ? `"${escapeQuotedString(name)}" <${recipient.to}>`
    : recipient.to;
};

const sanitizeHeaderKey = (key: string): string => {
  return key
    .trim()
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
};

const mapSmtpError = (error: unknown): CommsPortError => {
  if (error instanceof CommsPortError) {
    return error;
  }
  if (error instanceof TemplateRenderError) {
    const templateError = error as TemplateRenderError;
    return new CommsPortError("invalid_input", templateError.message, {
      code: templateError.code,
      details: templateError.details,
    });
  }

  const err = error as
    | (NodeJS.ErrnoException & {
        responseCode?: number;
        response?: string;
        command?: string;
      })
    | undefined;

  const message = err?.message ?? "smtp_error";
  const code = err?.code ? String(err.code).toUpperCase() : undefined;
  const responseCode =
    typeof err?.responseCode === "number" ? err.responseCode : undefined;

  if (typeof responseCode === "number") {
    if (responseCode >= 500) {
      return new CommsPortError("dependency_failed", message, {
        code,
        responseCode,
        command: err?.command,
        response: err?.response,
      });
    }
    if (responseCode >= 400) {
      return new CommsPortError("invalid_input", message, {
        code,
        responseCode,
        command: err?.command,
        response: err?.response,
      });
    }
  }

  if (code) {
    switch (code) {
      case "ETIMEDOUT":
      case "ETIMEOUT":
      case "ESOCKETTIMEDOUT":
        return new CommsPortError("transient", message, {
          code,
          responseCode,
          timeout: true,
        });
      case "ESOCKET": {
        const lowerMessage = message.toLowerCase();
        if (lowerMessage.includes("timeout")) {
          return new CommsPortError("transient", message, {
            code,
            responseCode,
            timeout: true,
          });
        }
        break;
      }
      case "EAUTH":
      case "EENVELOPE":
      case "EENVELOPEFROM":
      case "EADDRESS":
        return new CommsPortError("invalid_input", message, {
          code,
          responseCode,
        });
      case "ECONNECTION":
      case "ECONNREFUSED":
      case "ECONNRESET":
      case "EPIPE":
      case "ENOTFOUND":
      case "EHOSTUNREACH":
        return new CommsPortError("dependency_failed", message, {
          code,
          responseCode,
        });
      default:
        break;
    }
  }

  return new CommsPortError("transient", message, {
    code,
    responseCode,
    command: err?.command,
    response: err?.response,
  });
};
