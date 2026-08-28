/**
 * E2E seed: Cart Recovery fixtures.
 *
 * POST /e2e/seed/cart-recovery
 *
 * Creates an event, buyer, and optionally a PENDING order with held items
 * so the cart-recovery flows can be exercised end-to-end.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  seedFeePolicy,
  seedPayoutTerms,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";

const seedCartRecovery: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/cart-recovery", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      currency?: string;
      priceCents?: number;
      holdTtlSeconds?: number;
      createPendingOrder?: boolean;
    };

    const email = body.email ?? `e2e-cart-recovery-${Date.now()}@example.com`;
    const password = body.password ?? "Test-Account-2026!";
    const currency = body.currency ?? "usd";
    const priceCents =
      typeof body.priceCents === "number" ? body.priceCents : 2500;
    const holdTtlSeconds =
      typeof body.holdTtlSeconds === "number" ? body.holdTtlSeconds : 900;
    const createPendingOrder = body.createPendingOrder !== false;
    const now = new Date();

    try {
      // ── Buyer human + auth user ────────────────────────────────────
      const human = await prisma.human.create({
        data: { status: "ACTIVE", roles: ["USER"] },
      });

      await prisma.authUser.create({
        data: {
          id: human.id,
          humanId: human.id,
          email,
          emailVerified: true,
          name: "E2E Cart Recovery Buyer",
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      // ── Org ────────────────────────────────────────────────────────
      const org = await prisma.organization.create({
        data: {
          name: "E2E Cart Recovery Org",
          slug: `e2e-cart-recovery-org-${Date.now()}`,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      // ── Fee policy + payout terms ──────────────────────────────────
      const feePolicy = await seedFeePolicy({
        notes: "e2e-cart-recovery",
        createdBy: human.id,
      });

      const { agreement } = await seedPayoutTerms({
        feePolicyId: feePolicy.id,
        orgId: org.id,
        currency,
      });

      // ── Event ──────────────────────────────────────────────────────
      const startsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const event = await prisma.event.create({
        data: {
          title: "E2E Cart Recovery Event",
          orgId: org.id,
          humanId: null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          slug: `e2e-cart-recovery-event-${Date.now()}`,
        },
      });

      // ── Ticket types ───────────────────────────────────────────────
      const ticketTypes = await Promise.all([
        prisma.ticketType.create({
          data: {
            eventId: event.id,
            name: "General Admission",
            status: "ACTIVE",
            priceCents,
            capacity: 100,
            seatSectionId: null,
          },
        }),
        prisma.ticketType.create({
          data: {
            eventId: event.id,
            name: "VIP",
            status: "ACTIVE",
            priceCents: priceCents * 2,
            capacity: 50,
            seatSectionId: null,
          },
        }),
      ]);

      // ── Optional pending order ─────────────────────────────────────
      let orderId: string | null = null;
      let holdExpiresAt: Date | null = null;

      if (createPendingOrder) {
        holdExpiresAt = new Date(now.getTime() + holdTtlSeconds * 1000);

        const order = await prisma.order.create({
          data: {
            eventId: event.id,
            buyerHumanId: human.id,
            status: "PENDING",
            currency,
            amountGrossCents: priceCents * 2,
            feesPlatformCents: 0,
            feePolicySnapshot: {},
          },
        });

        await prisma.orderItem.createMany({
          data: [
            {
              orderId: order.id,
              kind: "ticket",
              ticketTypeId: ticketTypes[0].id,
              qty: 1,
              amountCents: priceCents,
              unitPriceCents: priceCents,
              meta: {
                seatIds: [],
                seatHoldExpiresAt: holdExpiresAt.toISOString(),
              },
            },
            {
              orderId: order.id,
              kind: "ticket",
              ticketTypeId: ticketTypes[0].id,
              qty: 1,
              amountCents: priceCents,
              unitPriceCents: priceCents,
              meta: {
                seatIds: [],
                seatHoldExpiresAt: holdExpiresAt.toISOString(),
              },
            },
          ],
        });

        orderId = order.id;
      }

      return reply.send({
        ok: true,
        seed: {
          email,
          password,
          humanId: human.id,
          orgId: org.id,
          eventId: event.id,
          eventSlug: event.slug,
          ticketTypeIds: ticketTypes.map((t) => t.id),
          ticketTypes: ticketTypes.map((t) => ({
            id: t.id,
            name: t.name,
            priceCents: t.priceCents,
          })),
          orderId,
          holdExpiresAt: holdExpiresAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_cart_recovery_failed",
        message,
      });
    }
  });
};

export default seedCartRecovery;
