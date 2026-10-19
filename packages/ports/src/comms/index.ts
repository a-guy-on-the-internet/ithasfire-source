export * from "./mailer";
export * from "./email-deliverability";
export * from "./sms";
export * from "./sms-opt-out";
export * from "./push";

export {
  healthStatusSchema,
  rateLimitHintSchema,
  idempotencyKeySchema,
  localizationSchema,
  emailAddressSchema,
  phoneNumberSchema,
  inAppRecipientSchema,
  templateRefSchema,
  attachmentSchema,
  metadataSchema,
  tagsSchema,
  sendResultSchema,
  createBatchResultSchema,
  arrayOrSingleSchema,
  commsPortErrorCodeSchema,
  CommsPortError,
  isCommsPortError,
} from "./schemas";

export type {
  HealthStatus as CommsHealthStatus,
  RateLimitHint,
  Localization,
  EmailAddress,
  PhoneNumber,
  InAppRecipient,
  TemplateRef,
  Attachment,
  Metadata,
  Tags,
  SendResult,
  BatchResult,
  ArrayOrSingle,
  CommsPortErrorCode,
} from "./schemas";
