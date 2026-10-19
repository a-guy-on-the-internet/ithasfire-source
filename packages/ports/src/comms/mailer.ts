import { z } from "zod";

import {
  arrayOrSingleSchema,
  Attachment,
  attachmentSchema,
  BatchResult,
  createBatchResultSchema,
  EmailAddress,
  emailAddressSchema,
  HealthStatus,
  healthStatusSchema,
  idempotencyKeySchema,
  Localization,
  localizationSchema,
  Metadata,
  metadataSchema,
  RateLimitHint,
  rateLimitHintSchema,
  SendResult,
  sendResultSchema,
  Tags,
  tagsSchema,
  TemplateRef,
  templateRefSchema,
} from "./schemas";

const mailerSendInputSchemaBase = z
  .object({
    to: arrayOrSingleSchema(emailAddressSchema),
    from: emailAddressSchema.optional(),
    /** Override Reply-To header independently of From. When set, both SMTP and SES adapters use this instead of falling back to `from`. */
    replyTo: emailAddressSchema.optional(),
    subject: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    template: templateRefSchema.optional(),
    attachments: z.array(attachmentSchema).nonempty().optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    metadata: metadataSchema.optional(),
    tags: tagsSchema.optional(),
    rateLimit: rateLimitHintSchema.optional(),
    localization: localizationSchema.optional(),
    /** Arbitrary MIME headers to inject (e.g. List-Unsubscribe). */
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasTemplate = Boolean(value.template);
    const hasRawContent = Boolean(value.text || value.html);

    if (!hasTemplate && !hasRawContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either template or raw content (text/html) is required",
        path: ["text"],
      });
    }
  });

export const mailerSendInputSchema = mailerSendInputSchemaBase;
export type MailerSendInput = z.input<typeof mailerSendInputSchema>;

export const mailerSendOutputSchema = z
  .object({
    result: sendResultSchema,
  })
  .strict();

export type MailerSendOutput = z.infer<typeof mailerSendOutputSchema>;

export const mailerSendBatchInputSchema = z.array(mailerSendInputSchema).min(1);
export type MailerSendBatchInput = z.input<typeof mailerSendBatchInputSchema>;

export const mailerSendBatchOutputSchema =
  createBatchResultSchema(sendResultSchema);
export type MailerSendBatchOutput = BatchResult<SendResult>;

export const mailerHealthOutputSchema = healthStatusSchema;

export interface MailerPort {
  send(input: MailerSendInput): Promise<MailerSendOutput>;
  sendBatch(inputs: MailerSendBatchInput): Promise<MailerSendBatchOutput>;
  health(): Promise<HealthStatus>;
}

export type MailerAttachments = Attachment[];
export type MailerMetadata = Metadata;
export type MailerTags = Tags;
export type MailerRateLimitHint = RateLimitHint;
export type MailerLocalization = Localization;
export type MailerRecipient = EmailAddress;
export type MailerContentTemplate = TemplateRef;
