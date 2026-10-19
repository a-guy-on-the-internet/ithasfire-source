import { randomInt } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "@th/db";
import { auth } from "../../auth/better-auth";
import {
  createAccountIdentifierHasher,
  resolveLimiterIp,
} from "../../auth/atomic-rate-limit";
import { env } from "../../lib/env";
import { isEmailAllowedForAccount } from "../../auth/ban-gate";
import {
  isUnprovenEmailMoveRefused,
  prismaUnprovenEmailMoveLookup,
  VERIFY_CURRENT_EMAIL_FIRST,
} from "../../auth/unproven-email-move";
import {
  createNetworkIdentityHasher,
  isUsableNetworkIdentitySecret,
} from "@th/core/lib/security/network-identity";

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
  // Ban-gate hasher, built once per process (HKDF), not per request.
  const identitySecret = app.deps.trpc.identityHashSecret ?? null;
  const identityHasher = isUsableNetworkIdentitySecret(identitySecret)
    ? createNetworkIdentityHasher(identitySecret)
    : null;

  // Recipient buckets key on an HMAC of the address, never the raw email, for
  // the reason spelled out on `createAccountIdentifierHasher` (PII in the
  // Redis keyspace). Same key + fallback as `plugins/auth-rate-limit.ts`.
  const hashRecipient = createAccountIdentifierHasher(
    env.BETTER_AUTH_SECRET ?? "dev-only-auth-rate-limit-identifier-key",
  );

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

      // Three buckets, 3/60s each (2026-09-29 review). Per USER alone let one
      // attacker rotate throwaway accounts to mail any inbox; per IP stops
      // one host, per RECIPIENT stops a botnet aiming at one inbox. Checked
      // IP → user → recipient and short-circuited, so a request already being
      // refused never spends the victim's recipient token (same ordering
      // rationale as the atomic auth limiter).
      const ip = resolveLimiterIp(
        request.headers,
        request.raw.socket?.remoteAddress,
      );
      const buckets = [
        ...(ip ? [`account-email-change:ip:${ip}`] : []),
        `account-email-change:${session.user.id}`,
        `account-email-change:to:${hashRecipient(newEmail)}`,
      ];
      let rateLimit: Awaited<
        ReturnType<typeof app.deps.trpc.rateLimit.consume>
      > | null = null;
      for (const key of buckets) {
        rateLimit = await app.deps.trpc.rateLimit.consume(
          key,
          CHANGE_EMAIL_OTP_MAX_REQUESTS,
          CHANGE_EMAIL_OTP_WINDOW_SECONDS,
        );
        if (!rateLimit.allowed) break;
      }

      if (rateLimit && !rateLimit.allowed) {
        return reply
          .header("Retry-After", String(rateLimit.retryAfterSeconds))
          .status(429)
          .send({
            ok: false,
            error: "rate_limited",
            message: "Too many verification code requests. Try again shortly.",
          });
      }

      // B2: an unverified account that holds email-attached rows (orders,
      // tickets, coordinator seats, lineup links) proves its CURRENT address
      // first. They were attached to it by email, and the
      // change would verify the new address with them still on it. No code
      // is stored or sent. `/email-otp/change-email` re-checks in the
      // user.update.before hook (a code requested earlier).
      //
      // An explicit 403, not the silent success the ban branch gives
      // (orchestrator, 2026-10-16; pro-social "nobody gets silence"): the
      // legitimate holder needs to know to verify first. What it leaks is
      // that something was bought under an address the caller already typed.
      if (
        await isUnprovenEmailMoveRefused(
          prismaUnprovenEmailMoveLookup(prisma),
          session.user.id,
        )
      ) {
        logger.info("account_email_change_refused_unproven_holder", {
          authUserId: session.user.id,
        });
        return reply.status(403).send({
          ok: false,
          error: "verify_current_email_first",
          message: VERIFY_CURRENT_EMAIL_FIRST.message,
        });
      }

      // Ban that sticks (2026-09-29): a banned human's mailbox (compared as
      // mail is delivered: case, +tags, Gmail dots) cannot be moved onto an
      // account. The answer is the SAME success an ordinary request gets —
      // no code is stored or sent — so this route is not a ban-status probe
      // (review round 1), exactly like the existing-address branch below.
      // `/email-otp/change-email` re-checks in Better Auth's
      // user.update.before hook, and the session gate refuses the mailbox.
      const allowed = await isEmailAllowedForAccount(
        {
          repos: app.deps.trpc.repos,
          clock: app.deps.trpc.clock,
          identitySecret,
          hasher: identityHasher,
          logger,
          reportError: app.deps.trpc.reportError ?? undefined,
        },
        newEmail,
      );
      if (!allowed) {
        await prisma.authVerification.deleteMany({
          where: { identifier: changeEmailIdentifier(currentEmail, newEmail) },
        });
        logger.info("account_email_change_refused_banned_email", {
          authUserId: session.user.id,
        });
        return acceptedResponse(reply);
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
              purpose: "change-email",
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
