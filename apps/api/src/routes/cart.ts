import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { releaseCartHold } from "@th/core/use-cases/orders";
import { createPrismaRepos } from "@th/adapters/db/prisma-repos";
import { withGuardedRepos } from "@th/adapters/decorators/with-dependency-guard";
import { createSystemClock } from "@th/adapters/infra/clock";
import { prisma } from "@th/db";
import { auth } from "../auth/better-auth";

// eventId is optional - kept for logging/debugging but not used by use case
const ReleaseCartHoldBody = z.object({
  orderId: z.string(),
  eventId: z.string().optional(),
});

const plugin: FastifyPluginAsync = async (app) => {
  // Build repos and clock for this route
  const rawRepos = createPrismaRepos(prisma);
  const repos = withGuardedRepos(rawRepos, app.deps.logger);
  const clock = createSystemClock();

  /**
   * POST /api/cart/release
   *
   * Fire-and-forget endpoint for releasing a cart hold when the user leaves the checkout page.
   * Designed to be called via navigator.sendBeacon() which sends as application/x-www-form-urlencoded
   * or text/plain, so we accept both JSON and form data.
   *
   * This is a best-effort release - if it fails, the cron job will eventually release expired holds.
   */
  app.post(
    "/api/cart/release",
    async (
      request: FastifyRequest<{
        Body: z.infer<typeof ReleaseCartHoldBody> | string;
      }>,
      reply,
    ) => {
      const logger = app.deps.logger;

      try {
        // sendBeacon can send as text/plain with JSON string, or as JSON
        let body: unknown;
        if (typeof request.body === "string") {
          try {
            body = JSON.parse(request.body);
          } catch {
            logger.warn("cart_release_invalid_body", { body: request.body });
            return reply.status(400).send({ ok: false, error: "invalid_body" });
          }
        } else {
          body = request.body;
        }

        const parsed = ReleaseCartHoldBody.safeParse(body);
        if (!parsed.success) {
          logger.warn("cart_release_validation_failed", {
            errors: parsed.error.issues,
          });
          return reply.status(400).send({ ok: false, error: "invalid_input" });
        }

        const { orderId, eventId } = parsed.data;

        // Get the session to identify the user
        const session = await auth.api.getSession({
          headers: request.headers as unknown as Headers,
        });

        if (!session?.user) {
          // No session - can't verify ownership, just return success
          // The use case will verify ownership anyway
          logger.info("cart_release_no_session", { orderId, eventId });
          return reply.status(200).send({ ok: true, released: false });
        }

        const humanId = session.user.id;

        // Same gate as tRPC `orders.releaseCartHold` (B2): an unverified
        // account cannot check out, so a held cart on it is a guest's embed
        // checkout attached by email. Releasing it would cancel that guest's
        // payment, so nothing is released until the account proves the inbox.
        if (session.user.emailVerified !== true) {
          logger.info("cart_release_unverified_email", { orderId, eventId });
          return reply.status(200).send({ ok: true, released: false });
        }

        const { released } = await releaseCartHold(
          {
            repos,
            clock,
            logger,
            // REQUIRED in practice. This endpoint is the sendBeacon target,
            // so it fires while the order is PENDING and its PaymentIntent
            // may already be PAID. Without a processor the use case cannot
            // prove the PI is dead and refuses to release anything that
            // carries one — which is safe, but means nothing gets released.
            // It was omitted here until now, so the PI was never cancelled
            // on this path at all.
            payments: app.deps.trpc.payments,
            // The refusal branches swallow, and `logger.warn` is not
            // captured by Sentry's pino integration.
            reportError: app.deps.trpc.reportError,
          },
          { orderId, actorHumanId: humanId },
        );

        // Report the REAL verdict. This used to hardcode `released: true`,
        // which made a refusal (paid PaymentIntent, CAS lost to finalize)
        // indistinguishable in the logs from a release that happened.
        logger.info("cart_release_complete", {
          orderId,
          eventId,
          humanId,
          released,
        });
        return reply.status(200).send({ ok: true, released });
      } catch (err) {
        // Best-effort for the CALLER — sendBeacon cannot read the response
        // and the cart reaper is the backstop — but NOT best-effort for us.
        // `logger.warn` is not captured by Sentry's pino integration
        // (CLAUDE.md), so every failure of the buyer-facing cart release was
        // invisible. Error-level plus an explicit report; the 200 stays.
        logger.error("cart_release_error", { err });
        try {
          app.deps.trpc.reportError?.(err, {
            tags: { area: "checkout", route: "POST /api/cart/release" },
          });
        } catch {
          // A throwing reporter must never change behaviour.
        }
        return reply.status(200).send({ ok: true, released: false });
      }
    },
  );
};

export default fp(plugin as unknown as never) as unknown as never;
