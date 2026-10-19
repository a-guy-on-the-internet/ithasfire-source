import { z } from "zod";

import {
  arrayOrSingleSchema,
  BatchResult,
  createBatchResultSchema,
  HealthStatus,
  healthStatusSchema,
  idempotencyKeySchema,
  Localization,
  localizationSchema,
  Metadata,
  metadataSchema,
  PhoneNumber,
  phoneNumberSchema,
  RateLimitHint,
  rateLimitHintSchema,
  SendResult,
  sendResultSchema,
  Tags,
  tagsSchema,
  TemplateRef,
  templateRefSchema,
} from "./schemas";

/**
 * Why a text is sent. Adapters pick the sending number from this: each
 * purpose maps to a registered US number (10DLC or toll-free); one number in
 * both variables is the expected setup.
 * Adapters treat a missing purpose as "notification".
 */
export const smsPurposeSchema = z.enum(["otp", "notification"]);
export type SMSPurpose = z.infer<typeof smsPurposeSchema>;

/**
 * The only numbers we text: US/NANP E.164 (`+1`, area code and exchange
 * each starting 2-9). Our sending numbers are registered for the US only,
 * and refusing everything else closes SMS pumping to premium and
 * international ranges. One rule, read by the auth plugin validator, the
 * OTP use cases and the SNS adapter.
 */
export const US_SMS_NUMBER_PATTERN = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * Area codes the NANP pattern admits that are not ordinary US lines:
 * `900` premium rate, N11 service codes, the Caribbean/Atlantic NANP
 * countries, and the Pacific territories Guam (671), the Northern Mariana
 * Islands (670) and American Samoa (684). Each is billed as its own country
 * behind a `+1` and is a common pumping target. Puerto Rico (787/939) and
 * the US Virgin Islands (340) stay allowed: they bill as the US.
 */
const NON_US_OR_PREMIUM_AREA_CODES: ReadonlySet<string> = new Set(
  [
    "900",
    "211 311 411 511 611 711 811 911",
    "242 246 264 268 284 345 441 473 649 658",
    "664 721 758 767 784 809 829 849 868 869 876",
    "670 671 684",
  ]
    .join(" ")
    .split(" "),
);

/**
 * Every Canadian area code: geographic in service, non-geographic (600,
 * 622, 633, 644, 655, 677, 688), and those CNAC has reserved for future overlays (273, 387,
 * 460, 487, 537, 568, 871), so a new overlay is refused from its first day.
 * Canada is a separate SMS destination country with its own registration
 * rules; our numbers are registered for the US only.
 * Source: Canadian Numbering Administrator (https://www.cnac.ca, "Area
 * Codes"), cross-checked against the NANP area-code list, 2026-10.
 */
const CANADIAN_AREA_CODES: ReadonlySet<string> = new Set(
  [
    "204 226 236 249 250 257 263 273 289",
    "306 343 354 365 367 368 382 387",
    "403 416 418 428 431 437 438 450 460 468 474 487",
    "506 514 519 537 548 568 579 581 584 587",
    "600 604 613 622 633 639 644 647 655 672 677 683 688",
    "705 709 742 753 778 780 782",
    "807 819 825 867 871 873 879",
    "902 905 942",
  ]
    .join(" ")
    .split(" "),
);

export function isUsSmsNumber(value: string): boolean {
  if (!US_SMS_NUMBER_PATTERN.test(value)) return false;
  const areaCode = value.slice(2, 5);
  return (
    !NON_US_OR_PREMIUM_AREA_CODES.has(areaCode) &&
    !CANADIAN_AREA_CODES.has(areaCode)
  );
}

/**
 * Replace phone-number-looking runs with "[redacted]", including formatted
 * ones ("+1 (615) 555-0100", "615.555.0100"). Provider error text can echo
 * the destination; run it through this before it reaches a log line or an
 * error tracker.
 */
export function redactPhoneNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,20}\d/g, "[redacted]");
}

const smsSendInputSchemaBase = z
  .object({
    purpose: smsPurposeSchema.optional(),
    to: arrayOrSingleSchema(phoneNumberSchema),
    body: z.string().min(1).optional(),
    template: templateRefSchema.optional(),
    mediaUrls: z.array(z.string().url()).nonempty().optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    metadata: metadataSchema.optional(),
    tags: tagsSchema.optional(),
    rateLimit: rateLimitHintSchema.optional(),
    localization: localizationSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.body && !value.template) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either body or template is required",
        path: ["body"],
      });
    }
  });

export const smsSendInputSchema = smsSendInputSchemaBase;
export type SMSSendInput = z.input<typeof smsSendInputSchema>;

export const smsSendOutputSchema = z
  .object({
    result: sendResultSchema,
  })
  .strict();

export type SMSSendOutput = z.infer<typeof smsSendOutputSchema>;

export const smsSendBatchInputSchema = z.array(smsSendInputSchema).min(1);
export type SMSSendBatchInput = z.input<typeof smsSendBatchInputSchema>;

export const smsSendBatchOutputSchema =
  createBatchResultSchema(sendResultSchema);
export type SMSSendBatchOutput = BatchResult<SendResult>;

export const smsHealthOutputSchema = healthStatusSchema;

export interface SMSPort {
  send(input: SMSSendInput): Promise<SMSSendOutput>;
  sendBatch(inputs: SMSSendBatchInput): Promise<SMSSendBatchOutput>;
  health(): Promise<HealthStatus>;
}

export type SMSMetadata = Metadata;
export type SMSTags = Tags;
export type SMSRateLimitHint = RateLimitHint;
export type SMSLocalization = Localization;
export type SMSRecipient = PhoneNumber;
export type SMSTemplateRef = TemplateRef;
