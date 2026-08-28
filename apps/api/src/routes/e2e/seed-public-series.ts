/**
 * E2E seed: public event-series date-switcher fixtures.
 *
 * POST /e2e/seed/public-series
 *
 * Creates an org with a fee policy + payout terms and three PUBLISHED,
 * PUBLIC events linked into a single EventSeries via EventSeriesOccurrence
 * rows. This lets the public event-detail E2E exercise the buyer-facing
 * SeriesDateSwitcher: every occurrence's page should surface the other
 * published dates and let the buyer jump between them.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
  seedPayoutTerms,
  seedOrgWithMember,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";

const seedPublicSeries: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/public-series", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      dates?: number;
    };
    const email = body.email ?? "playwright-setup@example.com";
    const dateCount = Math.min(Math.max(body.dates ?? 3, 2), 6);
    const stamp = Date.now();

    try {
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      const org = await seedOrgWithMember({
        name: "E2E Series Org",
        slugPrefix: "e2e-public-series",
        humanId,
      });

      const feePolicy = await seedFeePolicy({ createdBy: humanId, notes: "e2e" });
      const { agreement } = await seedPayoutTerms({
        feePolicyId: feePolicy.id,
        orgId: org.id,
        currency: "usd",
      });

      const series = await prisma.eventSeries.create({
        data: {
          ownerScope: "ORGANIZATION",
          ownerId: org.id,
          name: `E2E Public Series ${stamp}`,
          nameNormalized: `e2e public series ${stamp}`,
          timezone: "America/Chicago",
          active: true,
          schedule: { kind: "MANUAL" },
          createdByHumanId: humanId,
        },
      });

      const baseStart = Date.now() + 7 * 86_400_000;
      const dates: Array<{
        eventId: string;
        slug: string;
        title: string;
        startsAt: string;
      }> = [];

      for (let i = 0; i < dateCount; i++) {
        const startsAt = new Date(baseStart + i * 7 * 86_400_000);
        const endsAt = new Date(startsAt.getTime() + 3_600_000);
        const slug = `e2e-public-series-${stamp}-date-${i + 1}`;
        const title = `E2E Series Night ${i + 1}`;

        const event = await prisma.event.create({
          data: {
            title,
            orgId: org.id,
            humanId: null,
            startsAt,
            endsAt,
            status: "PUBLISHED",
            visibility: "PUBLIC",
            gateType: "NONE",
            currency: "usd",
            payoutTermsId: await snapshotPayoutTermsForE2eEvent(
              prisma,
              agreement.id,
            ),
            slug,
            addressText: "123 Series St, Austin, TX",
            lat: 30.2672,
            lng: -97.7431,
            locality: "Austin",
            region: "TX",
            countryCode: "US",
            locationMode: "EXACT",
          },
        });

        await prisma.ticketType.create({
          data: {
            eventId: event.id,
            name: "General Admission",
            status: "ACTIVE",
            priceCents: 2500,
            capacity: 100,
            seatSectionId: null,
          },
        });

        await prisma.eventSeriesOccurrence.create({
          data: {
            seriesId: series.id,
            ordinal: i,
            startsAt,
            endsAt,
            status: "PUBLISHED",
            eventId: event.id,
          },
        });

        dates.push({
          eventId: event.id,
          slug,
          title,
          startsAt: startsAt.toISOString(),
        });
      }

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug: org.slug,
          seriesId: series.id,
          seriesName: series.name,
          dates,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_public_series_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_public_series_failed",
        message,
      });
    }
  });
};

export default seedPublicSeries;
