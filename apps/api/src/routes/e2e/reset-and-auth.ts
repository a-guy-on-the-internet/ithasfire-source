/**
 * E2E reset + auth helper routes.
 *
 * - POST /e2e/reset           — wipe all test data
 * - POST /e2e/auth/verify-email — mark a user as email-verified
 * - POST /e2e/seed/auth-user   — create a simple auth user
 */
import type { FastifyPluginAsync } from "fastify";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@th/db";
import { assertE2eAuthorized, formatError } from "./_helpers.js";

const resetAndAuth: FastifyPluginAsync = async (app) => {
  // ── Reset ──────────────────────────────────────────────────────────────
  app.post("/e2e/reset", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { preserveEmail?: string };
    const preserveEmail =
      typeof body.preserveEmail === "string" && body.preserveEmail
        ? body.preserveEmail
        : null;

    let preserveAuthUserId: string | null = null;
    let preserveHumanId: string | null = null;
    if (preserveEmail) {
      const authUser = await prisma.authUser
        .findUnique({ where: { email: preserveEmail } })
        .catch(() => null);
      preserveAuthUserId = authUser?.id ?? null;
      preserveHumanId = authUser?.humanId ?? null;
    }

    try {
      // Domain / money-flow tables (newest → oldest / most-dependent → least).
      await prisma.payoutItemSettlement.deleteMany({}).catch(() => undefined);
      await prisma.payoutItem.deleteMany({}).catch(() => undefined);
      await prisma.payout.deleteMany({}).catch(() => undefined);
      await prisma.settlementLine.deleteMany({}).catch(() => undefined);
      await prisma.settlement.deleteMany({}).catch(() => undefined);

      await prisma.orderSplit.deleteMany({}).catch(() => undefined);
      await prisma.orderItem.deleteMany({}).catch(() => undefined);
      await prisma.order.deleteMany({}).catch(() => undefined);

      await prisma.ticket.deleteMany({}).catch(() => undefined);
      await (prisma as any).seatHold?.deleteMany?.({}).catch(() => undefined);
      await (prisma as any).seat?.deleteMany?.({}).catch(() => undefined);

      await prisma.promoHold.deleteMany({}).catch(() => undefined);
      await prisma.promo.deleteMany({}).catch(() => undefined);

      await prisma.payoutTermsLine.deleteMany({}).catch(() => undefined);
      await prisma.payoutTerms.deleteMany({}).catch(() => undefined);
      await prisma.feePolicy.deleteMany({}).catch(() => undefined);

      await prisma.payee.deleteMany({}).catch(() => undefined);
      await prisma.ticketType.deleteMany({}).catch(() => undefined);
      await prisma.event.deleteMany({}).catch(() => undefined);

      await prisma.placeOwnership.deleteMany({}).catch(() => undefined);
      await prisma.placeSlugHistory.deleteMany({}).catch(() => undefined);
      await prisma.placeLayout.deleteMany({}).catch(() => undefined);
      await prisma.place.deleteMany({}).catch(() => undefined);

      await prisma.orgMember.deleteMany({}).catch(() => undefined);
      await prisma.organization.deleteMany({}).catch(() => undefined);
      await prisma.entityPage.deleteMany({}).catch(() => undefined);
      await prisma.human
        .deleteMany({
          where: preserveHumanId ? { id: { not: preserveHumanId } } : {},
        })
        .catch(() => undefined);
      await prisma.apiKey.deleteMany({}).catch(() => undefined);

      // Better Auth tables — preserve the Playwright test user's session.
      await prisma.authSession.deleteMany({
        where: preserveAuthUserId
          ? { userId: { not: preserveAuthUserId } }
          : {},
      });
      await prisma.authAccount.deleteMany({
        where: preserveAuthUserId
          ? { userId: { not: preserveAuthUserId } }
          : {},
      });
      await prisma.authVerification.deleteMany({});
      await prisma.authUser.deleteMany({
        where: preserveAuthUserId ? { id: { not: preserveAuthUserId } } : {},
      });
    } catch (err) {
      const message = formatError(err);
      return reply.status(500).send({
        ok: false,
        error: "e2e_reset_failed",
        message,
      });
    }

    return reply.send({ ok: true });
  });

  // ── Verify email ──────────────────────────────────────────────────────
  app.post("/e2e/auth/verify-email", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    if (!body.email || typeof body.email !== "string") {
      return reply.status(400).send({ ok: false, error: "invalid_input" });
    }

    const user = await prisma.authUser.findUnique({
      where: { email: body.email },
    });
    if (!user) {
      return reply
        .status(404)
        .send({ ok: false, error: "auth_user_not_found" });
    }

    await prisma.authUser.update({
      where: { email: body.email },
      data: { emailVerified: true },
    });

    await prisma.authVerification
      .deleteMany({ where: { identifier: body.email } })
      .catch(() => undefined);

    return reply.send({ ok: true });
  });

  // ── Seed auth user ────────────────────────────────────────────────────
  app.post("/e2e/seed/auth-user", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
    };

    const email = body.email ?? `e2e-user-${Date.now()}@example.com`;
    const name = body.name ?? "E2E Test User";
    const now = new Date();

    try {
      const human = await prisma.human.create({
        data: { status: "ACTIVE", roles: ["USER"] },
      });

      await prisma.authUser.create({
        data: {
          id: human.id,
          humanId: human.id,
          email,
          emailVerified: true,
          name,
          createdAt: now,
          updatedAt: now,
        },
      });

      return reply.send({
        ok: true,
        seed: { email, humanId: human.id, name },
      });
    } catch (err) {
      const message = formatError(err);
      app.log.error({ err }, "e2e_seed_auth_user_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_auth_user_failed",
        message,
      });
    }
  });
};

export default resetAndAuth;
