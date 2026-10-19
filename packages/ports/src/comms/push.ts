import { z } from "zod";

import {
  healthStatusSchema,
  metadataSchema,
  templateRefSchema,
} from "./schemas";

export const pushProviderSchema = z.enum(["expo", "fcm", "apns", "web"]);
export type PushProvider = z.infer<typeof pushProviderSchema>;

export const pushPlatformSchema = z.enum(["ios", "android", "web", "unknown"]);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

export const registerPushDeviceInputSchema = z
  .object({
    humanId: z.string().min(1),
    provider: pushProviderSchema,
    token: z.string().min(1),
    platform: pushPlatformSchema.optional(),
    appId: z.string().min(1).optional(),
  })
  .strict();
export type RegisterPushDeviceInput = z.infer<
  typeof registerPushDeviceInputSchema
>;

export const unregisterPushDeviceInputSchema = z
  .object({
    humanId: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();
export type UnregisterPushDeviceInput = z.infer<
  typeof unregisterPushDeviceInputSchema
>;

const pushNotificationDataSchema = z.record(z.string(), z.unknown());

export const sendPushInputSchema = z
  .object({
    humanId: z.string().min(1).optional(),
    deviceIds: z.array(z.string().min(1)).min(1).optional(),
    topic: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    body: z.string().min(1),
    data: pushNotificationDataSchema.optional(),
    collapseKey: z.string().min(1).optional(),
    metadata: metadataSchema.optional(),
    template: templateRefSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.humanId && !value.deviceIds && !value.topic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "At least one target (humanId, deviceIds, or topic) is required",
        path: ["humanId"],
      });
    }
    if (value.deviceIds && value.deviceIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deviceIds cannot be empty",
        path: ["deviceIds"],
      });
    }
  });
export type SendPushInput = z.infer<typeof sendPushInputSchema>;

export const registerPushDeviceOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type RegisterPushDeviceOutput = z.infer<
  typeof registerPushDeviceOutputSchema
>;

export const unregisterPushDeviceOutputSchema = registerPushDeviceOutputSchema;
export type UnregisterPushDeviceOutput = z.infer<
  typeof unregisterPushDeviceOutputSchema
>;

export const sendPushOutputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
export type SendPushOutput = z.infer<typeof sendPushOutputSchema>;

export const pushHealthOutputSchema = healthStatusSchema;
export type PushHealthOutput = z.infer<typeof pushHealthOutputSchema>;

export const checkPushReceiptsInputSchema = z
  .object({
    /** Provider ticket ids to look up (Expo: push ticket ids). */
    ticketIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CheckPushReceiptsInput = z.infer<
  typeof checkPushReceiptsInputSchema
>;

export const pushReceiptStatusSchema = z.enum([
  /** Delivered to the push provider's downstream service. */
  "ok",
  /**
   * The device can never receive pushes (Expo: DeviceNotRegistered /
   * InvalidCredentials and friends) — callers should disable the device row.
   */
  "invalid_token",
  /** Message-level failure (too big, rate-limited, …); device stays valid. */
  "error",
]);
export type PushReceiptStatus = z.infer<typeof pushReceiptStatusSchema>;

export const checkPushReceiptsOutputSchema = z
  .object({
    /**
     * One entry per ticket id the provider still has a receipt for. Ticket
     * ids absent from this list have no receipt yet (or the provider already
     * pruned it — Expo keeps receipts for ~24h).
     */
    receipts: z.array(
      z
        .object({
          ticketId: z.string().min(1),
          status: pushReceiptStatusSchema,
          /** Provider-native error code (e.g. "DeviceNotRegistered"). */
          errorCode: z.string().nullable(),
          message: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type CheckPushReceiptsOutput = z.infer<
  typeof checkPushReceiptsOutputSchema
>;
export type PushReceiptResult = CheckPushReceiptsOutput["receipts"][number];

export interface PushPort {
  registerDevice(
    input: RegisterPushDeviceInput,
  ): Promise<RegisterPushDeviceOutput>;
  unregisterDevice(
    input: UnregisterPushDeviceInput,
  ): Promise<UnregisterPushDeviceOutput>;
  send(input: SendPushInput): Promise<SendPushOutput>;
  /**
   * Look up delivery receipts for previously issued send tickets, with
   * vendor error codes normalized to {@link PushReceiptStatus}. Optional:
   * only providers with a two-phase ticket→receipt delivery model (Expo)
   * implement it; the receipt-drain use case treats a missing implementation
   * as NOT_CONFIGURED.
   */
  checkReceipts?(
    input: CheckPushReceiptsInput,
  ): Promise<CheckPushReceiptsOutput>;
  health(): Promise<PushHealthOutput>;
}
