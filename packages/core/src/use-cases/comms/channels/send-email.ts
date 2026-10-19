import { z } from "zod";

import type { MailerPort } from "@th/ports/comms/mailer";
import { CommsPortError } from "@th/ports/comms/schemas";
import type { LoggerPort } from "@th/ports/logger";
import type { HumanWithIdentity } from "@th/ports/repos/humans";

import { notificationCategorySchema } from "../categories";
import {
  buildTags,
  emailResultSchema,
  normalizeTemplateRef,
  sanitizeMetadata,
  scopeKey,
  scopeSchema,
  type EmailResult,
} from "../shared";
import type { EmailChannelPayload } from "../renderers";

export type SendEmailDeps = {
  mailer?: MailerPort;
  logger?: LoggerPort;
};

export const sendEmailInputSchema = z
  .object({
    human: z.custom<HumanWithIdentity>(),
    variant: z.string().min(1),
    category: notificationCategorySchema,
    scope: scopeSchema,
    payload: z.custom<EmailChannelPayload | undefined>(),
    enabled: z.boolean(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

export type SendEmailInput = z.infer<typeof sendEmailInputSchema>;

/**
 * Defense-in-depth subject sanitizer for email header injection: collapse
 * CR/LF/tab/form-feed/vertical-tab runs to a single space, drop any remaining
 * C0/C1 control chars, then trim. A subject with no control chars is unchanged.
 */
export function sanitizeSubject(
  subject: string | null | undefined,
): string | undefined {
  if (subject === null || subject === undefined) {
    return undefined;
  }
  return subject
    .replace(/[\r\n\t\f\v]+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

export async function sendEmail(
  deps: SendEmailDeps,
  rawInput: SendEmailInput,
): Promise<EmailResult> {
  const input = sendEmailInputSchema.parse(rawInput);

  if (!input.enabled) {
    return { status: "skipped", reason: "channel_disabled" } as const;
  }

  if (!input.payload) {
    return { status: "skipped", reason: "renderer_omitted" } as const;
  }

  if (!deps.mailer) {
    return { status: "skipped", reason: "port_unavailable" } as const;
  }

  const { human, identity } = input.human;

  if (!identity.email) {
    return { status: "skipped", reason: "no_recipient" } as const;
  }

  if (!identity.emailVerified) {
    return { status: "skipped", reason: "unverified" } as const;
  }

  const tags = buildTags(input.payload.tags, input.category, input.variant);
  const metadata = sanitizeMetadata({
    ...input.payload.metadata,
    variant: input.variant,
    category: input.category,
    scope: scopeKey(input.scope),
  });

  const template = normalizeTemplateRef(input.payload.template ?? null);

  // Defense-in-depth against email header injection: strip CR/LF/tab/form-feed
  // and any C0/C1 control chars and collapse to a single line, so no
  // notification subject can smuggle header bytes regardless of upstream
  // sanitization or which mailer adapter is wired. Legit subjects (no control
  // chars) are unaffected.
  const subject = sanitizeSubject(input.payload.subject);

  try {
    const sendOutput = await deps.mailer.send({
      to: {
        to: identity.email,
        name: human.name ?? undefined,
      },
      replyTo: input.payload.replyTo ?? undefined,
      subject,
      text: input.payload.text ?? undefined,
      html: input.payload.html ?? undefined,
      template,
      metadata,
      tags,
      idempotencyKey: input.idempotencyKey,
    });

    if (!sendOutput.result.success) {
      deps.logger?.warn("comms.email.port_error", {
        code: sendOutput.result.errorCode ?? null,
        message: sendOutput.result.errorMessage ?? null,
      });

      return emailResultSchema.parse({
        status: "failed",
        reason: "port_error",
      });
    }

    return emailResultSchema.parse({
      status: "sent",
      vendorMessageId: sendOutput.result.id ?? undefined,
    });
  } catch (error) {
    if (error instanceof CommsPortError) {
      deps.logger?.warn("comms.email.port_error", {
        code: error.code,
        message: error.message,
      });
    } else {
      deps.logger?.warn("comms.email.port_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return emailResultSchema.parse({
      status: "failed",
      reason: "port_error",
    });
  }
}
