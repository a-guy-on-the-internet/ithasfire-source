/**
 * POST /e2e/seed/adjustable-checkout
 *
 * Creates a full domain graph with an ADJUSTABLE (donation/pay-what-you-want)
 * ticket type so E2E tests can exercise the adjustable pricing checkout flow,
 * non-refundable order behavior, and event cancellation override.
 */
import type { FastifyPluginAsync } from "fastify";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@th/db";
import { env } from "../../lib/env.js";
import {
  assertE2eAuthorized,
  formatError,
  seedHumanWithAuth,
  seedFeePolicy,
  seedPayoutTerms,
  seedOrgWithMember,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";

const seedAdjustableCheckout: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/adjustable-checkout", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      currency?: string;
      minimumCents?: number;
      suggestedCents?: number;
      nowIso?: string;
      stripeAccountId?: string;
      startsAt?: string;
      /** When true, also creates an Embed record for the event (for embed checkout testing). */
      createEmbed?: boolean;
      /** Domain to allow for the embed. Defaults to localhost. */
      embedDomain?: string;
    };

    const email = body.email ?? `e2e-adjustable-${Date.now()}@example.com`;
    const password = body.password ?? "Test-Account-2026!";
    const currency = body.currency ?? "usd";
    const minimumCents =
      typeof body.minimumCents === "number" ? body.minimumCents : 500;
    const suggestedCents =
      typeof body.suggestedCents === "number" ? body.suggestedCents : 1000;
    const now = body.nowIso ? new Date(body.nowIso) : new Date();
    const stripeAccountId =
      body.stripeAccountId ??
      env.E2E_STRIPE_ACCOUNT_ID ??
      "acct_1SsQuGFPwBURBn1I";
    const startsAt = body.startsAt
      ? new Date(body.startsAt)
      : new Date(now.getTime() + 86_400_000);

    try {
      const { humanId } = await seedHumanWithAuth({
        email,
        name: "E2E Organizer",
        now,
      });

      const passwordHash = await hashPassword(password);
      await prisma.authAccount.create({
        data: {
          providerId: "credential",
          accountId: humanId,
          userId: humanId,
          password: passwordHash,
        },
      });

      const org = await seedOrgWithMember({
        name: "E2E Donation Org",
        slugPrefix: "e2e-donation",
        humanId,
      });

      const feePolicy = await seedFeePolicy({
        createdBy: humanId,
        now,
        notes: "e2e-adjustable",
      });

      const payee = await prisma.payee.upsert({
        where: { stripeAccountId },
        update: {
          subjectType: "ORGANIZATION",
          subjectId: org.id,
          status: "ACTIVE",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: currency,
          requirements: {},
        },
        create: {
          subjectType: "ORGANIZATION",
          subjectId: org.id,
          stripeAccountId,
          status: "ACTIVE",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: currency,
          requirements: {},
        },
      });

      const { agreement } = await seedPayoutTerms({
        feePolicyId: feePolicy.id,
        payeeId: payee.id,
        currency,
      });

      const event = await prisma.event.create({
        data: {
          title: "E2E Pay What You Want Show",
          orgId: org.id,
          humanId: null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          currency,
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          slug: `e2e-adjustable-event-${Date.now()}`,
          addressText: "123 House Show Ln, Austin, TX",
          lat: 30.2672,
          lng: -97.7431,
          locality: "Austin",
          region: "TX",
          countryCode: "US",
          locationMode: "EXACT",
        },
      });

      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "Pay What You Want",
          status: "ACTIVE",
          priceCents: 0,
          pricingMode: "ADJUSTABLE",
          minimumCents,
          suggestedCents,
          capacity: 50,
          seatSectionId: null,
          resaleAllowed: false,
        },
      });

      // Optionally create an Embed record for embed checkout testing
      let embedId: string | null = null;
      if (body.createEmbed) {
        const embedDomain = body.embedDomain ?? "localhost";
        const embed = await prisma.embed.create({
          data: {
            subjectType: "event",
            subjectId: event.id,
            domain: embedDomain,
            status: "ACTIVE",
            requireAuth: false,
            createdBy: humanId,
          },
        });
        embedId = embed.id;
      }

      return reply.send({
        ok: true,
        seed: {
          email,
          password,
          humanId,
          orgId: org.id,
          orgSlug: org.slug,
          agreementId: agreement.id,
          eventId: event.id,
          eventSlug: event.slug,
          ticketTypeId: ticketType.id,
          stripeAccountId,
          minimumCents,
          suggestedCents,
          embedId,
        },
      });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_failed", message });
    }
  });
};

export default seedAdjustableCheckout;
