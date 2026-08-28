import { randomInt } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "@th/db";
import { auth } from "../../auth/better-auth";

const RequestEmailChangeBody = z.object({
  newEmail: z.string().trim().email(),
});

const CHANGE_EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const CHANGE_EMAIL_OTP_MAX_REQUESTS = 3;
const CHANGE_EMAIL_OTP_WINDOW_SECONDS = 60;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const createOtp = (): string =>
  randomInt(0, 1_000_000).toString().padStart(6, "0");

const changeEmailIdentifier = (currentEmail: string, newEmail: string): string =>
  `change-email-otp-${normalizeEmail(currentEmail)}-${normalizeEmail(newEmail)}`;

const toHeaders = (headers: FastifyRequest["headers"]): Headers => {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else if (value !== undefined) {
      out.append(key, String(value));
    }
  }
  return out;
};

const sendFailureResponse = (reply: FastifyReply) =>
  reply.status(503).send({
    ok: false,
    error: "email_send_failed",
    message: "Could not send verification code.",
  });

const acceptedResponse = (reply: FastifyReply) =>
  reply.status(200).send({ ok: true });

const plugin: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/account/email-change/request",
    async (
      request: FastifyRequest<{ Body: z.infer<typeof RequestEmailChangeBody> }>,
      reply,
    ) => {
      const logger = app.deps.logger;
      const session = await auth.api.getSession({
        headers: toHeaders(request.headers),
      });

      if (!session?.user?.id || !session.user.email) {
        return reply.status(401).send({ ok: false, error: "unauthorized" });
      }

      const parsed = RequestEmailChangeBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: "invalid_input" });
      }

      const currentEmail = normalizeEmail(session.user.email);
      const newEmail = normalizeEmail(parsed.data.newEmail);

      if (newEmail === currentEmail) {
        return reply.status(400).send({ ok: false, error: "email_same" });
      }

      const rateLimit = await app.deps.trpc.rateLimit.consume(
        `account-email-change:${session.user.id}`,
        CHANGE_EMAIL_OTP_MAX_REQUESTS,
        CHANGE_EMAIL_OTP_WINDOW_SECONDS,
      );

      if (!rateLimit.allowed) {
        return reply
          .header("Retry-After", String(rateLimit.retryAfterSeconds))
          .status(429)
          .send({
            ok: false,
            error: "rate_limited",
            message: "Too many verification code requests. Try again shortly.",
          });
      }

      const identifier = changeEmailIdentifier(currentEmail, newEmail);

      if (!app.deps.mailer) {
        logger.warn("account_email_change_otp_send_skipped", {
          reason: "mailer_not_configured",
          authUserId: session.user.id,
        });
        return sendFailureResponse(reply);
      }

      const existingUser = await prisma.authUser.findFirst({
        where: {
          email: { equals: newEmail, mode: "insensitive" },
          NOT: { id: session.user.id },
        },
        select: { id: true },
      });

      if (existingUser) {
        await prisma.authVerification.deleteMany({ where: { identifier } });
        logger.warn("account_email_change_otp_existing_email", {
          authUserId: session.user.id,
        });
        return acceptedResponse(reply);
      }

      const otp = createOtp();
      const expiresAt = new Date(Date.now() + CHANGE_EMAIL_OTP_TTL_MS);

      await prisma.authVerification.deleteMany({ where: { identifier } });
      await prisma.authVerification.create({
        data: {
          identifier,
          value: `${otp}:0`,
          expiresAt,
        },
      });

      try {
        const sendOutput = await app.deps.mailer.send({
          to: { to: newEmail },
          subject: `Your ${process.env.PRODUCT_NAME ?? "Ithas Fire"} verification code`,
          template: {
            key: "auth.verification_code",
            variables: {
              code: otp,
              expiresMinutes: 10,
              productName: process.env.PRODUCT_NAME ?? "Ithas Fire",
            },
          },
          tags: ["auth", "verification", "email-otp-change-email"],
        });

        if (!sendOutput.result.success) {
          await prisma.authVerification.deleteMany({ where: { identifier } });
          logger.warn("account_email_change_otp_send_unsuccessful", {
            authUserId: session.user.id,
            errorCode: sendOutput.result.errorCode ?? null,
            errorMessage: sendOutput.result.errorMessage ?? null,
          });
          return sendFailureResponse(reply);
        }
      } catch (error) {
        await prisma.authVerification.deleteMany({ where: { identifier } });
        logger.warn("account_email_change_otp_send_failed", {
          authUserId: session.user.id,
          error,
        });
        return sendFailureResponse(reply);
      }

      logger.info("account_email_change_otp_sent", {
        authUserId: session.user.id,
      });
      return acceptedResponse(reply);
    },
  );
};

export default fp(plugin as unknown as never) as unknown as never;
