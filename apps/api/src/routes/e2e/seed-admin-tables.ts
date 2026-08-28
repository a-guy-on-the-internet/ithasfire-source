/**
 * E2E seed: Admin Tables fixtures.
 *
 * POST /e2e/seed/admin-tables
 *
 * Creates a fully wired org (with membership), events (PUBLISHED + DRAFT +
 * APPLICATION-gated), places (ACTIVE + ARCHIVED), and orders with various
 * statuses so the admin orders/events/places tables can be exercised e2e.
 */
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";
import { SEED_TICKET_CODES } from "./_seed-codes.js";

const seedAdminTables: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/admin-tables", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
    };

    const email = body.email ?? "playwright-setup@example.com";
    const now = new Date();
    const seedSuffix = `${now.getTime()}-${randomUUID().slice(0, 8)}`;

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

      // ── Org + Membership ───────────────────────────────────────────
      const orgSlug = `e2e-admin-${seedSuffix}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Admin Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      // ── Places ─────────────────────────────────────────────────────
      const placeActive = await prisma.place.create({
        data: {
          name: "E2E Main Venue",
          slug: `e2e-main-venue-${seedSuffix}`,
          address: "123 Main St, Testville, TS 00001",
          addrLine1: "123 Main St",
          city: "Testville",
          region: "TS",
          postcode: "00001",
          country: "US",
          capacity: 500,
          lat: 37.7749,
          lng: -122.4194,
          status: "ACTIVE",
          verification: "UNVERIFIED",
        },
      });

      const placeArchived = await prisma.place.create({
        data: {
          name: "E2E Old Hall",
          slug: `e2e-old-hall-${seedSuffix}`,
          address: "456 Archive Ave, Testville, TS 00002",
          addrLine1: "456 Archive Ave",
          city: "Testville",
          region: "TS",
          postcode: "00002",
          country: "US",
          capacity: 200,
          lat: 37.78,
          lng: -122.42,
          status: "ARCHIVED",
          verification: "VERIFIED",
        },
      });

      await prisma.placeOwnership.createMany({
        data: [
          {
            placeId: placeActive.id,
            ownerType: "ORGANIZATION",
            ownerId: org.id,
          },
          {
            placeId: placeArchived.id,
            ownerType: "ORGANIZATION",
            ownerId: org.id,
            verified: true,
            reviewerHumanId: humanId,
            reviewedAt: now,
          },
        ],
      });

      // ── Feature gate: unlock the freeform entity-page editor ─────────
      // The editor UI is gated behind `feature:entityPageEditor` (default
      // OFF → standard template). Seed the override ON so the entity-page
      // editor e2e spec renders the freeform block canvas.
      await prisma.platformSetting.upsert({
        where: { key: "feature:entityPageEditor" },
        create: { key: "feature:entityPageEditor", value: "true" },
        update: { value: "true" },
      });

      // ── Entity pages ─────────────────────────────────────────────────
      const orgPage = await prisma.entityPage.create({
        data: {
          ownerType: "ORGANIZATION",
          ownerId: org.id,
          displayName: org.name,
          slug: `${orgSlug}-page`,
          bio: "E2E organization page for editor smoke tests",
          visibility: "PUBLIC",
          // Pin a non-standard layout so the editor renders the draggable block
          // canvas (all owner types now default to the "standard" template,
          // which hides the block editor in favour of a live preview).
          theme: { create: { layoutKey: "stack" } },
          blocks: {
            create: [
              {
                kind: "about",
                orderIndex: 0,
                data: {
                  heading: "About",
                  content: "E2E organization about block",
                },
                visible: true,
              },
            ],
          },
        },
      });

      const placePage = await prisma.entityPage.create({
        data: {
          ownerType: "PLACE",
          ownerId: placeArchived.id,
          displayName: placeArchived.name,
          slug: `${placeArchived.slug}-page`,
          bio: "E2E place page for editor smoke tests",
          visibility: "PUBLIC",
          // Pin a non-standard layout so the editor renders the draggable block
          // canvas (the default PLACE "standard" template hides it in favour of
          // an auto-managed preview).
          theme: { create: { layoutKey: "stack" } },
          blocks: {
            create: [
              {
                kind: "about",
                orderIndex: 0,
                data: {
                  heading: "About",
                  content: "E2E place about block",
                },
                visible: true,
              },
            ],
          },
        },
      });

      const legacyCustomPage = await prisma.entityPage.create({
        data: {
          ownerType: "HUMAN",
          ownerId: humanId,
          displayName: "E2E Legacy Custom HTML",
          slug: `e2e-legacy-custom-html-${seedSuffix}`,
          bio: "E2E legacy unsupported block page",
          visibility: "PUBLIC",
          blocks: {
            create: [
              {
                kind: "custom_html_sanitized",
                orderIndex: 0,
                data: {
                  html: "<strong>UNSAFE CUSTOM HTML SHOULD NOT RENDER</strong><img src=x onerror=\"alert('custom-html')\">",
                },
                visible: true,
              },
            ],
          },
        },
      });

      // ── Fee policy + payout terms ──────────────────────────────────
      const feePolicy = await seedFeePolicy({
        createdBy: humanId,
        now,
        notes: "e2e-admin-tables",
      });

      const agreement = await prisma.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          version: 1,
          isDefault: true,
          settlementCurrency: "usd",
          status: "ACTIVE",
          feePolicyId: feePolicy.id,
        },
      });

      // ── Events ─────────────────────────────────────────────────────
      const eventPublished = await prisma.event.create({
        data: {
          title: "E2E Published Concert",
          orgId: org.id,
          humanId: null,
          placeId: placeActive.id,
          startsAt: new Date(now.getTime() + 7 * 86_400_000),
          endsAt: new Date(now.getTime() + 7 * 86_400_000 + 3_600_000),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          slug: `e2e-published-concert-${seedSuffix}`,
          addressText: "123 Main St, Testville, TS 00001",
        },
      });

      const eventDraft = await prisma.event.create({
        data: {
          title: "E2E Draft Workshop",
          orgId: org.id,
          humanId: null,
          startsAt: new Date(now.getTime() + 14 * 86_400_000),
          endsAt: new Date(now.getTime() + 14 * 86_400_000 + 7_200_000),
          status: "DRAFT",
          visibility: "PUBLIC",
          gateType: "NONE",
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          slug: `e2e-draft-workshop-${seedSuffix}`,
          addressText: "456 Archive Ave, Testville, TS 00002",
        },
      });

      // ── Application-gated event ────────────────────────────────────
      const eventAppGated = await prisma.event.create({
        data: {
          title: "E2E Application-Gated Showcase",
          orgId: org.id,
          humanId: null,
          placeId: placeActive.id,
          startsAt: new Date(now.getTime() + 21 * 86_400_000),
          endsAt: new Date(now.getTime() + 21 * 86_400_000 + 3_600_000),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "APPLICATION",
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          slug: `e2e-app-gated-showcase-${seedSuffix}`,
          addressText: "123 Main St, Testville, TS 00001",
        },
      });

      const appForm = await prisma.eventApplicationForm.create({
        data: { eventId: eventAppGated.id },
      });

      await prisma.eventApplicationQuestion.createMany({
        data: [
          {
            formId: appForm.id,
            label: "Why do you want to attend?",
            type: "LONG_TEXT",
            isRequired: true,
            order: 0,
          },
          {
            formId: appForm.id,
            label: "How did you hear about us?",
            type: "SHORT_TEXT",
            isRequired: false,
            order: 1,
          },
        ],
      });

      // Event already links to payout terms via payoutTermsId FK.
      // No fixup needed.

      // ── Ticket types ───────────────────────────────────────────────
      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: eventPublished.id,
          name: "General Admission",
          status: "ACTIVE",
          priceCents: 2500,
          capacity: 100,
        },
      });

      await prisma.ticketType.create({
        data: {
          eventId: eventDraft.id,
          name: "Workshop Seat",
          status: "ACTIVE",
          priceCents: 5000,
          capacity: 30,
        },
      });

      // ── Buyer + orders ─────────────────────────────────────────────
      const buyer = await prisma.human.create({
        data: { status: "ACTIVE", roles: ["USER"] },
      });

      await prisma.authUser.create({
        data: {
          id: buyer.id,
          humanId: buyer.id,
          email: `e2e-buyer-${seedSuffix}@example.com`,
          emailVerified: true,
          name: "E2E Buyer",
          createdAt: now,
          updatedAt: now,
        },
      });

      const adminFeePolicySnapshot = {
        version: 1,
        platformTakePercent: 6.5,
        buyerFeePercent: 0,
        appliedAt: now.toISOString(),
      };

      const orderSucceeded = await prisma.order.create({
        data: {
          eventId: eventPublished.id,
          buyerHumanId: buyer.id,
          status: "SUCCEEDED",
          currency: "usd",
          amountGrossCents: 2500,
          feesPlatformCents: 163,
          feePolicySnapshot: adminFeePolicySnapshot,
          occurredAt: new Date(now.getTime() - 86_400_000),
          stripePaymentIntentId: `pi_e2e_admin_${seedSuffix}`,
        },
      });

      const succeededOrderItem = await prisma.orderItem.create({
        data: {
          orderId: orderSucceeded.id,
          ticketTypeId: ticketType.id,
          kind: "ticket",
          qty: 1,
          unitPriceCents: 2500,
          amountCents: 2500,
          status: "CONFIRMED",
        },
      });

      // ── Tickets for the SUCCEEDED order ────────────────────────────
      // Hardcoded codes: stable across reseeds so dev can pre-print QR
      // codes and e2e tests can assert without reading the response.
      // Mix of statuses to cover: 2× VALID (scannable), 1× SCANNED.
      await prisma.ticket.deleteMany({
        where: { code: { in: [...SEED_TICKET_CODES.ADMIN_CONCERT] } },
      });
      const ticketStatuses = ["VALID", "VALID", "SCANNED"] as const;
      const adminConcertTickets = await Promise.all(
        SEED_TICKET_CODES.ADMIN_CONCERT.map((code, i) =>
          prisma.ticket.create({
            data: {
              eventId: eventPublished.id,
              ticketTypeId: ticketType.id,
              orderId: orderSucceeded.id,
              // orderItemId has a UNIQUE constraint; only one
              // ticket can claim the line item. The others are
              // orphaned-but-valid for scan-test purposes.
              orderItemId: i === 0 ? succeededOrderItem.id : null,
              ownerHumanId: buyer.id,
              code,
              status: ticketStatuses[i]!,
              scannedAt:
                ticketStatuses[i] === "SCANNED"
                  ? new Date(now.getTime() - 3_600_000)
                  : null,
              issuedAt: new Date(now.getTime() - 86_400_000),
            },
          }),
        ),
      );

      const orderPending = await prisma.order.create({
        data: {
          eventId: eventPublished.id,
          buyerHumanId: buyer.id,
          status: "PENDING",
          currency: "usd",
          amountGrossCents: 5000,
          feesPlatformCents: 325,
          feePolicySnapshot: adminFeePolicySnapshot,
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
            unitPriceCents: 2500,
            amountCents: 2500,
            status: "HELD",
          },
          {
            orderId: orderPending.id,
            ticketTypeId: ticketType.id,
            kind: "ticket",
            qty: 1,
            unitPriceCents: 2500,
            amountCents: 2500,
            status: "HELD",
          },
        ],
      });

      // ── PART_REFUNDED order ────────────────────────────────────────
      const orderPartRefund = await prisma.order.create({
        data: {
          eventId: eventPublished.id,
          buyerHumanId: buyer.id,
          status: "PART_REFUNDED",
          currency: "usd",
          amountGrossCents: 5000,
          feesPlatformCents: 325,
          feePolicySnapshot: adminFeePolicySnapshot,
          occurredAt: new Date(now.getTime() - 2 * 86_400_000),
          stripePaymentIntentId: `pi_e2e_admin_pr_${seedSuffix}`,
        },
      });

      await prisma.orderItem.createMany({
        data: [
          {
            orderId: orderPartRefund.id,
            ticketTypeId: ticketType.id,
            kind: "ticket",
            qty: 1,
            unitPriceCents: 2500,
            amountCents: 2500,
            status: "CONFIRMED",
          },
          {
            orderId: orderPartRefund.id,
            ticketTypeId: ticketType.id,
            kind: "ticket",
            qty: 1,
            unitPriceCents: 2500,
            amountCents: 2500,
            status: "REFUNDED",
            refundedAt: new Date(now.getTime() - 86_400_000),
          },
        ],
      });

      // ── REFUNDED order ─────────────────────────────────────────────
      const orderRefunded = await prisma.order.create({
        data: {
          eventId: eventPublished.id,
          buyerHumanId: buyer.id,
          status: "REFUNDED",
          currency: "usd",
          amountGrossCents: 2500,
          feesPlatformCents: 163,
          feePolicySnapshot: adminFeePolicySnapshot,
          occurredAt: new Date(now.getTime() - 3 * 86_400_000),
          stripePaymentIntentId: `pi_e2e_admin_ref_${seedSuffix}`,
        },
      });

      await prisma.orderItem.create({
        data: {
          orderId: orderRefunded.id,
          ticketTypeId: ticketType.id,
          kind: "ticket",
          qty: 1,
          unitPriceCents: 2500,
          amountCents: 2500,
          status: "REFUNDED",
          refundedAt: new Date(now.getTime() - 2 * 86_400_000),
        },
      });

      // ── DISPUTED order ─────────────────────────────────────────────
      const orderDisputed = await prisma.order.create({
        data: {
          eventId: eventPublished.id,
          buyerHumanId: buyer.id,
          status: "DISPUTED",
          currency: "usd",
          amountGrossCents: 2500,
          feesPlatformCents: 163,
          feePolicySnapshot: adminFeePolicySnapshot,
          occurredAt: new Date(now.getTime() - 4 * 86_400_000),
          stripePaymentIntentId: `pi_e2e_admin_disp_${seedSuffix}`,
        },
      });

      await prisma.orderItem.create({
        data: {
          orderId: orderDisputed.id,
          ticketTypeId: ticketType.id,
          kind: "ticket",
          qty: 1,
          unitPriceCents: 2500,
          amountCents: 2500,
          status: "CONFIRMED",
        },
      });

      return reply.send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          orgPageSlug: orgPage.slug,
          placeActiveId: placeActive.id,
          placeArchivedId: placeArchived.id,
          placePageSlug: placePage.slug,
          legacyCustomPageSlug: legacyCustomPage.slug,
          eventPublishedId: eventPublished.id,
          eventPublishedSlug: eventPublished.slug,
          eventDraftId: eventDraft.id,
          eventDraftSlug: eventDraft.slug,
          eventAppGatedId: eventAppGated.id,
          eventAppGatedSlug: eventAppGated.slug,
          orderSucceededId: orderSucceeded.id,
          orderPendingId: orderPending.id,
          orderPartRefundId: orderPartRefund.id,
          orderRefundedId: orderRefunded.id,
          orderDisputedId: orderDisputed.id,
          buyerHumanId: buyer.id,
          ticketCodes: adminConcertTickets.map((t) => t.code),
          ticketIds: adminConcertTickets.map((t) => t.id),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_admin_tables_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_admin_tables_failed",
        message,
      });
    }
  });
};

export default seedAdminTables;
