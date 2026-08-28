/**
 * E2E seed: Platform Tables fixtures.
 *
 * POST /e2e/seed/platform-tables
 *
 * Promotes the test user to ADMIN, creates an org with events, orders,
 * tickets, and a place with a PENDING verification request + documents so
 * the platform orders/tickets/places pages can be exercised end-to-end.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
} from "./_helpers.js";
import { SEED_TICKET_CODES } from "./_seed-codes.js";

const seedPlatformTables: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/platform-tables", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    const email = body.email ?? "playwright-setup@example.com";
    const now = new Date();

    try {
      // ── Resolve authenticated human ────────────────────────────────
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      // ── Promote to platform staff ──────────────────────────────────
      await prisma.human.update({
        where: { id: humanId },
        data: { roles: ["USER", "ADMIN"] },
      });

      // ── Org + Membership ───────────────────────────────────────────
      const orgSlug = `e2e-platform-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Platform Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      // ── Places ─────────────────────────────────────────────────────
      const placePending = await prisma.place.create({
        data: {
          name: "E2E Pending Venue",
          slug: `e2e-pending-venue-${Date.now()}`,
          address: "100 Pending Ave, Testville, TS 00010",
          addrLine1: "100 Pending Ave",
          city: "Testville",
          region: "TS",
          postcode: "00010",
          country: "US",
          capacity: 300,
          lat: 37.77,
          lng: -122.41,
          status: "ACTIVE",
          verification: "PENDING",
        },
      });

      const placeVerified = await prisma.place.create({
        data: {
          name: "E2E Verified Hall",
          slug: `e2e-verified-hall-${Date.now()}`,
          address: "200 Verified Blvd, Testville, TS 00020",
          addrLine1: "200 Verified Blvd",
          city: "Testville",
          region: "TS",
          postcode: "00020",
          country: "US",
          capacity: 800,
          lat: 37.78,
          lng: -122.42,
          status: "ACTIVE",
          verification: "VERIFIED",
        },
      });

      await prisma.placeOwnership.createMany({
        data: [
          {
            placeId: placePending.id,
            ownerType: "ORGANIZATION",
            ownerId: org.id,
          },
          {
            placeId: placeVerified.id,
            ownerType: "ORGANIZATION",
            ownerId: org.id,
          },
        ],
      });

      // ── Verification request + documents ───────────────────────────
      const verificationRequest = await prisma.placeVerificationRequest.create({
        data: {
          placeId: placePending.id,
          orgId: org.id,
          submittedById: humanId,
          status: "PENDING",
        },
      });

      const doc1 = await prisma.placeVerificationDocument.create({
        data: {
          requestId: verificationRequest.id,
          storageKey: `e2e/docs/${Date.now()}/lease.pdf`,
          fileName: "lease-agreement.pdf",
          contentType: "application/pdf",
          sizeBytes: 245_000,
        },
      });

      const doc2 = await prisma.placeVerificationDocument.create({
        data: {
          requestId: verificationRequest.id,
          storageKey: `e2e/docs/${Date.now()}/photo.jpg`,
          fileName: "venue-photo.jpg",
          contentType: "image/jpeg",
          sizeBytes: 1_200_000,
        },
      });

      // ── Fee policy + payout terms ──────────────────────────────────
      const feePolicy = await seedFeePolicy({
        createdBy: humanId,
        now,
        notes: "e2e-platform-tables",
      });

      const payoutTerms = await prisma.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          version: 1,
          isDefault: true,
          settlementCurrency: "usd",
          status: "ACTIVE",
          feePolicyId: feePolicy.id,
        },
      });

      // ── Event ──────────────────────────────────────────────────────
      const event = await prisma.event.create({
        data: {
          title: "E2E Platform Concert",
          orgId: org.id,
          humanId: null,
          placeId: placeVerified.id,
          startsAt: new Date(now.getTime() + 7 * 86_400_000),
          endsAt: new Date(now.getTime() + 7 * 86_400_000 + 3_600_000),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          payoutTermsId: payoutTerms.id,
          slug: `e2e-platform-concert-${Date.now()}`,
          addressText: "200 Verified Blvd, Testville, TS 00020",
        },
      });

      // ── Ticket type ────────────────────────────────────────────────
      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "General Admission",
          status: "ACTIVE",
          priceCents: 3000,
          capacity: 100,
        },
      });

      // ── Buyer ──────────────────────────────────────────────────────
      const buyer = await prisma.human.create({
        data: { status: "ACTIVE", roles: ["USER"] },
      });

      const buyerEmail = `e2e-platform-buyer-${Date.now()}@example.com`;
      await prisma.authUser.create({
        data: {
          id: buyer.id,
          humanId: buyer.id,
          email: buyerEmail,
          emailVerified: true,
          name: "E2E Platform Buyer",
          createdAt: now,
          updatedAt: now,
        },
      });

      // ── Orders ─────────────────────────────────────────────────────
      const feePolicySnapshot = {
        buyerFeePct: "0.03",
        minFeeCents: 20,
        maxFeeCents: null,
        maxPlatformFeeCents: 500,
        feeMode: "PASS_THROUGH",
        processorFeePct: "0.029",
        processorFixedCents: 30,
      };

      const orderSucceeded = await prisma.order.create({
        data: {
          eventId: event.id,
          buyerHumanId: buyer.id,
          status: "SUCCEEDED",
          currency: "usd",
          amountGrossCents: 3000,
          feesPlatformCents: 195,
          feePolicySnapshot,
          occurredAt: new Date(now.getTime() - 86_400_000),
          stripePaymentIntentId: `pi_e2e_platform_${Date.now()}`,
        },
      });

      const succeededOrderItem = await prisma.orderItem.create({
        data: {
          orderId: orderSucceeded.id,
          ticketTypeId: ticketType.id,
          kind: "ticket",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          status: "CONFIRMED",
        },
      });

      const orderPending = await prisma.order.create({
        data: {
          eventId: event.id,
          buyerHumanId: buyer.id,
          status: "PENDING",
          currency: "usd",
          amountGrossCents: 6000,
          feesPlatformCents: 390,
          feePolicySnapshot,
          occurredAt: now,
        },
      });

      await prisma.orderItem.createMany({
        data: [
          {
            orderId: orderPending.id,
            ticketTypeId: ticketType.id,
            kind: "ticket",
            qty: 1,
            unitPriceCents: 3000,
            amountCents: 3000,
            status: "HELD",
          },
          {
            orderId: orderPending.id,
            ticketTypeId: ticketType.id,
            kind: "ticket",
            qty: 1,
            unitPriceCents: 3000,
            amountCents: 3000,
            status: "HELD",
          },
        ],
      });

      // ── Tickets (for succeeded order) ──────────────────────────────
      // Hardcoded code: stable across reseeds so dev can pre-print QR
      // codes and e2e tests can assert without reading the response.
      await prisma.ticket.deleteMany({
        where: { code: { in: [...SEED_TICKET_CODES.PLATFORM_CONCERT] } },
      });
      const ticket = await prisma.ticket.create({
        data: {
          eventId: event.id,
          ticketTypeId: ticketType.id,
          orderId: orderSucceeded.id,
          orderItemId: succeededOrderItem.id,
          ownerHumanId: buyer.id,
          code: SEED_TICKET_CODES.PLATFORM_CONCERT[0]!,
          status: "VALID",
          issuedAt: new Date(now.getTime() - 86_400_000),
        },
      });

      return reply.send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          placePendingId: placePending.id,
          placeVerifiedId: placeVerified.id,
          verificationRequestId: verificationRequest.id,
          docIds: [doc1.id, doc2.id],
          eventId: event.id,
          eventSlug: event.slug,
          eventTitle: event.title,
          orderSucceededId: orderSucceeded.id,
          orderPendingId: orderPending.id,
          ticketId: ticket.id,
          ticketCode: ticket.code,
          buyerHumanId: buyer.id,
          buyerEmail,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_platform_tables_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_platform_tables_failed",
        message,
      });
    }
  });
};

export default seedPlatformTables;
