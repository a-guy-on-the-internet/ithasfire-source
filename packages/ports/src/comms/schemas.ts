import { z } from "zod";

export const healthStatusSchema = z.object({
  ok: z.boolean(),
  vendor: z.string().min(1).optional(),
  latencyMs: z.number().int().min(0).optional(),
  message: z.string().optional(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const rateLimitHintSchema = z
  .object({
    maxPerMinute: z.number().int().min(1).optional(),
    burst: z.number().int().min(1).optional(),
  })
  .strict();

export type RateLimitHint = z.infer<typeof rateLimitHintSchema>;

export const idempotencyKeySchema = z.string().min(1);

export const localizationSchema = z
  .object({
    locale: z.string().min(2).optional(),
    timezone: z.string().min(1).optional(),
  })
  .strict();

export type Localization = z.infer<typeof localizationSchema>;

export const emailAddressSchema = z
  .object({
    to: z.string().email(),
    name: z.string().min(1).optional(),
  })
  .strict();

export type EmailAddress = z.infer<typeof emailAddressSchema>;

export const phoneNumberSchema = z
  .object({
    toE164: z
      .string()
      .regex(/^\+[1-9]\d{1,14}$/u, "must be an E.164 formatted phone number"),
  })
  .strict();

export type PhoneNumber = z.infer<typeof phoneNumberSchema>;

export const inAppRecipientSchema = z
  .object({
    humanId: z.string().min(1),
  })
  .strict();

export type InAppRecipient = z.infer<typeof inAppRecipientSchema>;

export const templateRefSchema = z
  .object({
    key: z.string().min(1),
    version: z.string().min(1).optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type TemplateRef = z.infer<typeof templateRefSchema>;

export const attachmentSchema = z
  .object({
    filename: z.string().min(1),
    mime: z.string().min(1),
    bytesBase64: z
      .string()
      .regex(/^[A-Za-z0-9+/=]+$/u, "must be a base64 encoded string"),
  })
  .strict();

export type Attachment = z.infer<typeof attachmentSchema>;

export const metadataSchema = z.record(z.string(), z.string());
export type Metadata = z.infer<typeof metadataSchema>;

export const tagsSchema = z.array(z.string().min(1));
export type Tags = z.infer<typeof tagsSchema>;

export const commsPortErrorCodeSchema = z.enum([
  "invalid_input",
  "unauthorized",
  "rate_limited",
  "dependency_failed",
  "transient",
  "not_found",
  "conflict",
]);

export type CommsPortErrorCode = z.infer<typeof commsPortErrorCodeSchema>;

export const sendResultSchema = z
  .object({
    success: z.boolean(),
    id: z.string().min(1).optional(),
    idempotentReplay: z.boolean().optional(),
    errorCode: commsPortErrorCodeSchema.optional(),
    errorMessage: z.string().optional(),
    details: z.unknown().optional(),
  })
  .strict();

export type SendResult = z.infer<typeof sendResultSchema>;

export const createBatchResultSchema = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
) =>
  z
    .object({
      results: z.array(schema),
      okCount: z.number().int().min(0),
      errorCount: z.number().int().min(0),
    })
    .strict();

export type BatchResult<T> = {
  results: T[];
  okCount: number;
  errorCount: number;
};

export type ArrayOrSingle<T> = T | T[];

export const arrayOrSingleSchema = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
) => z.union([schema, z.array(schema).min(1)]);

export class CommsPortError extends Error {
  constructor(
    public readonly code: CommsPortErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CommsPortError";
  }
}

export function isCommsPortError(error: unknown): error is CommsPortError {
  return error instanceof CommsPortError;
}
