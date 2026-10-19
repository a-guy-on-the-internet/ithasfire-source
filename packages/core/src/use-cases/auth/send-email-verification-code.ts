import { createHash, randomInt } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 10 * 60;

export const sendEmailVerificationCodeInputSchema = z
  .object({
    toEmail: z.string().trim().email(),
    productName: z.string().trim().min(1),
    verificationCode: z.string().trim().min(4).max(12).optional(),
    expiresMinutes: z.number().int().positive().max(60).default(10),
    clientKey: z.string().trim().min(1),
  })
  .strict();

export type SendEmailVerificationCodeInput = z.infer<
  typeof sendEmailVerificationCodeInputSchema
>;

export type SendEmailVerificationCodeDeps = {
  clock: ClockPort;
  idempotency: IdempotencyPort;
  mailer: MailerPort;
  logger?: LoggerPort;
};

type StoredVerificationEmail = {
  payloadHash: string;
  response: {
    ok: true;
    idempotentReplay?: boolean;
    code: string;
    expiresMinutes: number;
  };
};

const codeSchema = z
  .string()
  .regex(/^[0-9]{6}$/, "verification code must be 6 digits");

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function buildPayloadHash(input: SendEmailVerificationCodeInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function sendEmailVerificationCode(
  deps: SendEmailVerificationCodeDeps,
  rawInput: unknown,
): Promise<{
  ok: true;
  idempotentReplay?: boolean;
  code: string;
  expiresMinutes: number;
}> {
  const scopedLogger = deps.logger?.child({
    useCase: "auth.sendEmailVerificationCode",
  });

  const execute = async () => {
    const input = parseInput(sendEmailVerificationCodeInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `auth:email-verification-code:${input.toEmail}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredVerificationEmail>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return { ...replay.response, idempotentReplay: true };
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const pending =
        await deps.idempotency.get<StoredVerificationEmail>(idempotencyKey);
      if (pending) {
        if (pending.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return { ...pending.response, idempotentReplay: true };
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const code = codeSchema.parse(
        input.verificationCode ?? generateSixDigitCode(),
      );

      await deps.mailer.send({
        to: {
          to: input.toEmail,
        },
        subject: `Your ${input.productName} verification code`,
        template: {
          key: "auth.verification_code",
          variables: {
            code,
            expiresMinutes: input.expiresMinutes,
            productName: input.productName,
          },
        },
        metadata: {
          clientKey: input.clientKey,
          productName: input.productName,
        },
        tags: ["auth", "verification"],
        idempotencyKey,
      });

      const response = {
        ok: true as const,
        code,
        expiresMinutes: input.expiresMinutes,
      };

      await deps.idempotency.commit<StoredVerificationEmail>(idempotencyKey, {
        payloadHash,
        response,
      });

      return response;
    } catch (error) {
      scopedLogger?.warn("auth.sendEmailVerificationCode.failed", {
        error: describeError(error),
        toEmail:
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? (rawInput as any).toEmail
            : null,
      });
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("send_email_verification_code", error);
    }
  };

  return execute();
}
