import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { SmsProviderOptOutPort } from "@th/ports/comms/sms-opt-out";
import { parseInput } from "../../lib/io";
import { normalizePhoneE164 } from "../../lib/comms/phone";

/**
 * TRANSACTIONAL covers OTP / account-security SMS and is allowed even when a
 * number is opted out of marketing/reminder SMS. REMINDER and ANNOUNCEMENT are
 * suppressible categories that must respect opt-out state.
 */
export const smsCategorySchema = z.enum([
  "TRANSACTIONAL",
  "VOLUNTEER_REMINDER",
  "ANNOUNCEMENT",
]);

export const ensureSmsDeliverableInputSchema = z
  .object({
    phoneNumber: z.string().min(1),
    category: smsCategorySchema,
  })
  .strict();

export const ensureSmsDeliverableOutputSchema = z.discriminatedUnion(
  "deliverable",
  [
    z.object({ deliverable: z.literal(true), phoneE164: z.string() }).strict(),
    z
      .object({
        deliverable: z.literal(false),
        reason: z.enum([
          "invalid_phone",
          "app_opted_out",
          "provider_opted_out",
        ]),
      })
      .strict(),
  ],
);

export type SmsCategory = z.infer<typeof smsCategorySchema>;
export type EnsureSmsDeliverableInput = z.infer<
  typeof ensureSmsDeliverableInputSchema
>;
export type EnsureSmsDeliverableOutput = z.infer<
  typeof ensureSmsDeliverableOutputSchema
>;

export type EnsureSmsDeliverableDeps = {
  repos: Repos;
  /** Optional provider check; when absent the app ledger is authoritative. */
  providerOptOut?: SmsProviderOptOutPort;
  logger?: LoggerPort;
  /** Reports a provider opt-out lookup that failed and was failed closed. */
  reportError?: ReporterPort;
};

/**
 * Shared guard used by reminder and announcement senders before calling
 * SMSPort. Returns whether an SMS of the given category may be sent to the
 * number. TRANSACTIONAL sends bypass opt-out suppression (subject to legal /
 * provider policy upstream); all other categories are blocked when the phone
 * is app-opted-out or provider-opted-out.
 */
export async function ensureSmsDeliverable(
  deps: EnsureSmsDeliverableDeps,
  rawInput: unknown,
): Promise<EnsureSmsDeliverableOutput> {
  const input = parseInput(ensureSmsDeliverableInputSchema, rawInput);

  const phoneE164 = normalizePhoneE164(input.phoneNumber);
  if (!phoneE164) {
    return ensureSmsDeliverableOutputSchema.parse({
      deliverable: false,
      reason: "invalid_phone",
    });
  }

  if (input.category === "TRANSACTIONAL") {
    return ensureSmsDeliverableOutputSchema.parse({
      deliverable: true,
      phoneE164,
    });
  }

  const consent = await deps.repos.smsConsent.getByPhone(phoneE164);
  if (consent?.status === "OPTED_OUT") {
    return ensureSmsDeliverableOutputSchema.parse({
      deliverable: false,
      reason: "app_opted_out",
    });
  }

  if (deps.providerOptOut) {
    let providerOptedOut = false;
    try {
      providerOptedOut = await deps.providerOptOut.isOptedOut(phoneE164);
    } catch (error) {
      // A provider lookup failure must not silently allow a send to a number
      // that may be suppressed, but it also must not hard-fail the whole
      // batch. Fail closed for this number and let the caller skip it.
      deps.logger?.error("sms_consent.provider_check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (deps.reportError) {
        safeReporter(deps.reportError)(error, {
          tags: {
            useCase: "comms.ensureSmsDeliverable",
            swallowed: "true",
            stage: "provider_check",
            category: input.category,
          },
        });
      }
      return ensureSmsDeliverableOutputSchema.parse({
        deliverable: false,
        reason: "provider_opted_out",
      });
    }
    if (providerOptedOut) {
      return ensureSmsDeliverableOutputSchema.parse({
        deliverable: false,
        reason: "provider_opted_out",
      });
    }
  }

  return ensureSmsDeliverableOutputSchema.parse({
    deliverable: true,
    phoneE164,
  });
}
