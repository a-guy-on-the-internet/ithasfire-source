import { z } from "zod";

import { redactPhoneNumbers, type SMSPort } from "@th/ports/comms/sms";
import { isCommsPortError } from "@th/ports/comms/schemas";
import type { LoggerPort } from "@th/ports/logger";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type { HumanWithIdentity } from "@th/ports/repos/humans";
import type { SmsConsentRepo } from "@th/ports/repos/sms-consent";

import { normalizePhoneE164 } from "../../../lib/comms/phone";
import { redactedError } from "../../../lib/comms/redacted-error";
import {
  isSmsAllowedForCategory,
  notificationCategorySchema,
} from "../categories";
import {
  buildTags,
  normalizeTemplateRef,
  sanitizeMetadata,
  scopeKey,
  scopeSchema,
  smsResultSchema,
  type SmsResult,
} from "../shared";
import type { SmsChannelPayload } from "../renderers";

export type SendSmsDeps = {
  sms?: SMSPort;
  /**
   * Consent gate (FR-011 / TCPA): required so a preference row that says
   * "enabled" can never override a revoked consent (STOP reply, support
   * opt-out) recorded in the SMS consent ledger.
   */
  smsConsent: Pick<SmsConsentRepo, "getByPhone">;
  logger?: LoggerPort;
  /**
   * Reports the swallowed failures below (consent lookup error, provider
   * refusal, provider throw): each returns a skipped/failed result instead
   * of throwing, so without this they reach no error tracker.
   */
  reportError?: ReporterPort;
};

export const sendSmsInputSchema = z
  .object({
    human: z.custom<HumanWithIdentity>(),
    variant: z.string().min(1),
    category: notificationCategorySchema,
    scope: scopeSchema,
    payload: z.custom<SmsChannelPayload | undefined>(),
    enabled: z.boolean(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

export type SendSmsInput = z.infer<typeof sendSmsInputSchema>;

export async function sendSms(
  deps: SendSmsDeps,
  rawInput: SendSmsInput,
): Promise<SmsResult> {
  const input = sendSmsInputSchema.parse(rawInput);

  if (!input.enabled) {
    return { status: "skipped", reason: "channel_disabled" } as const;
  }

  // Only categories our sending numbers are registered for may be texted,
  // whatever the stored preference or the caller's override says.
  if (!isSmsAllowedForCategory(input.category)) {
    return { status: "skipped", reason: "category_not_sms_eligible" } as const;
  }

  if (!input.payload) {
    return { status: "skipped", reason: "renderer_omitted" } as const;
  }

  if (!deps.sms) {
    return { status: "skipped", reason: "port_unavailable" } as const;
  }

  const { identity } = input.human;

  if (!identity.phone) {
    return { status: "skipped", reason: "no_recipient" } as const;
  }

  if (!identity.phoneVerified) {
    return { status: "skipped", reason: "unverified" } as const;
  }

  // Consent gate (FR-011): a verified phone captured through the phone-capture
  // + consent flow is the affirmative opt-in; the smsConsent ledger records
  // later revocations (STOP replies, support opt-outs). An enabled preference
  // row must never override a revoked consent, so check the ledger last.
  // Absence of a ledger row is NOT blocking — the ledger is an opt-out record
  // (mirrors ensureSmsDeliverable's model in ../ensure-sms-deliverable.ts).
  const report = deps.reportError ? safeReporter(deps.reportError) : undefined;
  const reportTags = {
    useCase: "comms.sendSms",
    swallowed: "true",
    category: input.category,
    variant: input.variant,
  };

  const consentPhone = normalizePhoneE164(identity.phone) ?? identity.phone;
  try {
    const consent = await deps.smsConsent.getByPhone(consentPhone);
    if (consent?.status === "OPTED_OUT") {
      return { status: "skipped", reason: "opted_out" } as const;
    }
  } catch (error) {
    // Fail closed: if we cannot read the consent ledger we refuse to send
    // rather than risk texting a number that revoked consent.
    deps.logger?.error("comms.sms.consent_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    report?.(error, {
      tags: { ...reportTags, stage: "consent_check" },
    });
    return { status: "skipped", reason: "consent_unavailable" } as const;
  }

  const tags = buildTags(input.payload.tags, input.category, input.variant);
  const metadata = sanitizeMetadata({
    ...input.payload.metadata,
    variant: input.variant,
    category: input.category,
    scope: scopeKey(input.scope),
  });

  const template = normalizeTemplateRef(input.payload.template ?? null);
  const body =
    typeof input.payload.body === "string" ? input.payload.body : undefined;

  try {
    const sendOutput = await deps.sms.send({
      // Sent from the registered US number (10DLC or toll-free) for
      // notifications; one number in both variables is the expected setup.
      purpose: "notification",
      to: { toE164: identity.phone },
      body,
      template,
      metadata,
      tags,
      idempotencyKey: input.idempotencyKey,
    });

    if (!sendOutput.result.success) {
      // Provider text can echo the destination number: redacted before it
      // reaches a log line or the error tracker.
      const errorMessage =
        sendOutput.result.errorMessage === undefined
          ? null
          : redactPhoneNumbers(sendOutput.result.errorMessage);
      deps.logger?.error("comms.sms.port_error", {
        code: sendOutput.result.errorCode ?? null,
        message: errorMessage,
      });
      report?.(
        new Error(
          `sms send refused: ${sendOutput.result.errorCode ?? "unknown"}`,
        ),
        {
          tags: {
            ...reportTags,
            stage: "send_result",
            errorCode: sendOutput.result.errorCode ?? undefined,
          },
          extra: { errorMessage },
        },
      );

      return smsResultSchema.parse({
        status: "failed",
        reason: "port_error",
      });
    }

    return smsResultSchema.parse({
      status: "sent",
      vendorMessageId: sendOutput.result.id ?? undefined,
    });
  } catch (error) {
    if (isCommsPortError(error)) {
      deps.logger?.error("comms.sms.port_error", {
        code: error.code,
        message: redactPhoneNumbers(error.message),
      });
    } else {
      deps.logger?.error("comms.sms.port_error", {
        error: redactPhoneNumbers(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
    report?.(redactedError(error), {
      tags: {
        ...reportTags,
        stage: "send_threw",
        errorCode: isCommsPortError(error) ? error.code : undefined,
      },
    });

    return smsResultSchema.parse({
      status: "failed",
      reason: "port_error",
    });
  }
}
