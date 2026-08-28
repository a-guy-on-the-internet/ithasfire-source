/**
 * POST /e2e/seed/paid-checkout
 *
 * Creates a full domain graph (human → org → fee policy → payout terms →
 * event → ticket type → auth account) so E2E tests can exercise the
 * checkout / payment flow.
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

const seedPaidCheckout: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/paid-checkout", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      currency?: string;
      priceCents?: number;
      enableResale?: boolean;
      nowIso?: string;
      stripeAccountId?: string;
      sellerStripeAccountId?: string;
      startsAt?: string;
      refundCutoffAt?: string;
      /** Admission tax rate in basis points, e.g. 975 = 9.75%. */
      admissionTaxRateBps?: number;
      location?: {
        addressText?: string;
        lat?: number;
        lng?: number;
        locality?: string;
        region?: string;
        countryCode?: string;
      };
    };

    const email = body.email ?? `e2e-paid-checkout-${Date.now()}@example.com`;
    const password = body.password ?? "Test-Account-2026!";
    const currency = body.currency ?? "usd";
    const priceCents =
      typeof body.priceCents === "number" ? body.priceCents : 2500;
    const enableResale = body.enableResale === true;
    const now = body.nowIso ? new Date(body.nowIso) : new Date();
    const stripeAccountId =
      body.stripeAccountId ??
      env.E2E_STRIPE_ACCOUNT_ID ??
      "acct_1SsQuGFPwBURBn1I";
    const sellerStripeAccountId =
      body.sellerStripeAccountId ?? `acct_e2e_resale_${Date.now()}`;
    const startsAt = body.startsAt
      ? new Date(body.startsAt)
      : new Date(now.getTime() + 86_400_000);
    const refundCutoffAt = body.refundCutoffAt
      ? new Date(body.refundCutoffAt)
      : null;

    try {
      const { humanId } = await seedHumanWithAuth({
        email,
        name: "E2E Buyer",
        now,
      });

      // Create credential account so Better Auth sign-in works.
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
        name: "E2E Org",
        slugPrefix: "e2e-org",
        humanId,
      });

      const feePolicy = await seedFeePolicy({
        createdBy: humanId,
        now,
        notes: "e2e",
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

      const resalePayee = enableResale
        ? await prisma.payee.upsert({
            where: {
              subjectType_subjectId: {
                subjectType: "HUMAN",
                subjectId: humanId,
              },
            },
            update: {
              stripeAccountId: sellerStripeAccountId,
              status: "ACTIVE",
              payoutsEnabled: true,
              chargesEnabled: true,
              defaultCurrency: currency,
              requirements: {},
            },
            create: {
              subjectType: "HUMAN",
              subjectId: humanId,
              stripeAccountId: sellerStripeAccountId,
              status: "ACTIVE",
              payoutsEnabled: true,
              chargesEnabled: true,
              defaultCurrency: currency,
              requirements: {},
            },
          })
        : null;

      const resaleAgreement = enableResale
        ? await prisma.payoutTerms.create({
            data: {
              kind: "PRIMARY",
              version: 1,
              isDefault: false,
              settlementCurrency: currency,
              status: "ACTIVE",
              feePolicyId: feePolicy.id,
              resaleSellerMarkupShareBps: 5000,
              resalePayoutReleaseDays: 7,
              lines: {
                create: {
                  payeeId: resalePayee!.id,
                  percent: 100,
                  floorCents: 0,
                  capPercent: null,
                  priority: 0,
                  rounding: "FLOOR",
                },
              },
            },
          })
        : null;

      const event = await prisma.event.create({
        data: {
          title: "E2E Paid Checkout Event",
          orgId: org.id,
          humanId: null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          refundCutoffAt,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          currency,
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
          resalePayoutTermsId: resaleAgreement
            ? await snapshotPayoutTermsForE2eEvent(prisma, resaleAgreement.id)
            : null,
          slug: `e2e-paid-checkout-event-${Date.now()}`,
          ...(typeof body.admissionTaxRateBps === "number"
            ? { admissionTaxRateBps: body.admissionTaxRateBps }
            : {}),
          addressText:
            body.location?.addressText ?? "123 E2E Street, Nashville, TN",
          lat: body.location?.lat ?? 36.1627,
          lng: body.location?.lng ?? -86.7816,
          locality: body.location?.locality ?? "Nashville",
          region: body.location?.region ?? "TN",
          countryCode: body.location?.countryCode ?? "US",
          locationMode: "EXACT",
        },
      });

      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "General Admission",
          status: "ACTIVE",
          priceCents,
          resaleAllowed: enableResale,
          capacity: 100,
          seatSectionId: null,
        },
      });

      return reply.send({
        ok: true,
        seed: {
          email,
          password,
          humanId,
          orgId: org.id,
          orgSlug: org.slug,
          agreementId: agreement.id,
          resaleAgreementId: resaleAgreement?.id ?? null,
          eventId: event.id,
          eventSlug: event.slug,
          ticketTypeId: ticketType.id,
          stripeAccountId,
          sellerStripeAccountId: resalePayee?.stripeAccountId ?? null,
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

export default seedPaidCheckout;
