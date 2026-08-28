/**
 * E2E seed: Event Builder fixtures.
 *
 * POST /e2e/seed/event-builder
 *
 * Creates an org, payee (Stripe Connect), fee policy, a DRAFT event, and
 * a ticket type so the event-builder UI can be tested end-to-end.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import { env } from "../../lib/env.js";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
  seedPayoutTerms,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";

const seedEventBuilder: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/event-builder", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      currency?: string;
      stripeAccountId?: string;
      startsAt?: string;
      endsAt?: string;
      location?: {
        addressText?: string;
        lat?: number;
        lng?: number;
        locality?: string;
        region?: string;
        countryCode?: string;
      };
    };
    const email = body.email ?? "playwright-setup@example.com";
    const currency = body.currency ?? "usd";
    const now = new Date();
    const startsAt = body.startsAt
      ? new Date(body.startsAt)
      : new Date(now.getTime() + 7 * 86_400_000);
    const endsAt = body.endsAt
      ? new Date(body.endsAt)
      : new Date(startsAt.getTime() + 3_600_000);

    try {
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      // ── Org + Membership ───────────────────────────────────────────
      const orgSlug = `e2e-builder-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Builder Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      // ── Fee policy + payout terms ──────────────────────────────────
      const feePolicy = await seedFeePolicy({
        notes: "e2e-event-builder",
        createdBy: humanId,
      });

      const stripeAccountId =
        body.stripeAccountId ??
        env.E2E_STRIPE_ACCOUNT_ID ??
        `acct_e2e_builder_${Date.now()}`;

      const { agreement } = await seedPayoutTerms({
        feePolicyId: feePolicy.id,
        orgId: org.id,
        currency,
        stripeAccountId,
      });

      // ── Draft Event ────────────────────────────────────────────────
      const event = await prisma.event.create({
        data: {
          title: "E2E Builder Event",
          orgId: org.id,
          humanId: null,
          startsAt,
          endsAt,
          status: "DRAFT",
          visibility: "PUBLIC",
          gateType: "NONE",
          currency,
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          slug: `e2e-builder-event-${Date.now()}`,
          addressText:
            body.location?.addressText ?? "123 Test St, E2E City, TS 00001",
          ...(body.location?.lat != null && body.location?.lng != null
            ? {
                lat: body.location.lat,
                lng: body.location.lng,
                locality: body.location.locality ?? null,
                region: body.location.region ?? null,
                countryCode: body.location.countryCode ?? null,
                locationMode: "EXACT",
              }
            : {}),
        },
      });

      // ── Ticket Type ────────────────────────────────────────────────
      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "General Admission",
          status: "ACTIVE",
          priceCents: 1500,
          capacity: 100,
        },
      });

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          eventId: event.id,
          eventSlug: event.slug,
          eventTitle: event.title,
          ticketTypeId: ticketType.id,
          payeeId: (
            await prisma.payee.findFirst({
              where: { subjectId: org.id },
            })
          )?.id,
          stripeAccountId,
          currency,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_event_builder_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_event_builder_failed",
        message,
      });
    }
  });
};

export default seedEventBuilder;
