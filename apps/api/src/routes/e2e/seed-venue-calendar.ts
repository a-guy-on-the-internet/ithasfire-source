/**
 * E2E seed: Venue Calendar fixtures.
 *
 * POST /e2e/seed/venue-calendar
 *
 * Creates an org, a place, and several events (including a series pair)
 * so the calendar page has data in every view mode.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
} from "./_helpers.js";

const seedVenueCalendar: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/venue-calendar", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    const email = body.email ?? "playwright-setup@example.com";
    const now = new Date();

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
      const orgSlug = `e2e-cal-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Calendar Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      // ── Place ──────────────────────────────────────────────────────
      const placeSlug = `e2e-venue-${Date.now()}`;
      const place = await prisma.place.create({
        data: {
          name: "E2E Test Venue",
          slug: placeSlug,
          address: "100 Calendar St, Test City, TS 00001",
          city: "Test City",
          region: "TS",
          country: "US",
          status: "ACTIVE",
        },
      });

      // ── Fee policy ─────────────────────────────────────────────────
      const feePolicy = await seedFeePolicy({
        notes: "e2e-venue-calendar",
        createdBy: humanId,
      });

      // Helper: build payout terms for an event
      async function makePayoutTerms() {
        return prisma.payoutTerms.create({
          data: {
            kind: "PRIMARY",
            version: 1,
            isDefault: true,
            settlementCurrency: "usd",
            status: "ACTIVE",
            feePolicyId: feePolicy.id,
          },
        });
      }

      // ── Events — spread across this month ──────────────────────────

      // Event A: today, 2-hour window
      const todayStart = new Date(now);
      todayStart.setHours(14, 0, 0, 0);
      const todayEnd = new Date(todayStart.getTime() + 2 * 3_600_000);

      const eventToday = await prisma.event.create({
        data: {
          title: "Today Live Show",
          orgId: org.id,
          placeId: place.id,
          startsAt: todayStart,
          endsAt: todayEnd,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          slug: `e2e-cal-today-${Date.now()}`,
          addressText: "100 Calendar St, Test City, TS 00001",
          locality: "Test City",
          region: "TS",
        },
      });
      const todayTerms = await makePayoutTerms();
      await prisma.event.update({
        where: { id: eventToday.id },
        data: { payoutTermsId: todayTerms.id },
      });

      // Event B: tomorrow, draft
      const tmrStart = new Date(now);
      tmrStart.setDate(tmrStart.getDate() + 1);
      tmrStart.setHours(10, 0, 0, 0);
      const tmrEnd = new Date(tmrStart.getTime() + 3_600_000);

      const eventTomorrow = await prisma.event.create({
        data: {
          title: "Tomorrow Draft Gig",
          orgId: org.id,
          placeId: place.id,
          startsAt: tmrStart,
          endsAt: tmrEnd,
          status: "DRAFT",
          visibility: "PUBLIC",
          gateType: "NONE",
          slug: `e2e-cal-tmr-${Date.now()}`,
          addressText: "100 Calendar St, Test City, TS 00001",
          locality: "Test City",
          region: "TS",
        },
      });
      const tmrTerms = await makePayoutTerms();
      await prisma.event.update({
        where: { id: eventTomorrow.id },
        data: { payoutTermsId: tmrTerms.id },
      });

      // Event C: today + 3 days
      const futStart = new Date(now);
      futStart.setDate(futStart.getDate() + 3);
      futStart.setHours(19, 0, 0, 0);
      const futEnd = new Date(futStart.getTime() + 2 * 3_600_000);

      const eventFuture = await prisma.event.create({
        data: {
          title: "Weekend Concert",
          orgId: org.id,
          placeId: place.id,
          startsAt: futStart,
          endsAt: futEnd,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          slug: `e2e-cal-fut-${Date.now()}`,
          addressText: "100 Calendar St, Test City, TS 00001",
          locality: "Test City",
          region: "TS",
        },
      });
      const futTerms = await makePayoutTerms();
      await prisma.event.update({
        where: { id: eventFuture.id },
        data: { payoutTermsId: futTerms.id },
      });

      // ── Series: "Friday Night Jazz" — 2 occurrences ────────────────
      const series = await prisma.eventSeries.create({
        data: {
          ownerScope: "ORGANIZATION",
          ownerId: org.id,
          name: "Friday Night Jazz",
          nameNormalized: "friday-night-jazz",
          timezone: "America/New_York",
          schedule: { freq: "weekly", day: 5 },
          createdByHumanId: humanId,
        },
      });

      // Series event 1: today + 5 days
      const s1Start = new Date(now);
      s1Start.setDate(s1Start.getDate() + 5);
      s1Start.setHours(20, 0, 0, 0);
      const s1End = new Date(s1Start.getTime() + 3 * 3_600_000);

      const seriesEvent1 = await prisma.event.create({
        data: {
          title: "Friday Night Jazz #1",
          orgId: org.id,
          placeId: place.id,
          startsAt: s1Start,
          endsAt: s1End,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          slug: `e2e-cal-jazz1-${Date.now()}`,
          addressText: "100 Calendar St, Test City, TS 00001",
          locality: "Test City",
          region: "TS",
        },
      });
      const s1Terms = await makePayoutTerms();
      await prisma.event.update({
        where: { id: seriesEvent1.id },
        data: { payoutTermsId: s1Terms.id },
      });

      await prisma.eventSeriesOccurrence.create({
        data: {
          seriesId: series.id,
          ordinal: 1,
          startsAt: s1Start,
          endsAt: s1End,
          status: "GENERATED",
          eventId: seriesEvent1.id,
        },
      });

      // Series event 2: today + 12 days
      const s2Start = new Date(now);
      s2Start.setDate(s2Start.getDate() + 12);
      s2Start.setHours(20, 0, 0, 0);
      const s2End = new Date(s2Start.getTime() + 3 * 3_600_000);

      const seriesEvent2 = await prisma.event.create({
        data: {
          title: "Friday Night Jazz #2",
          orgId: org.id,
          placeId: place.id,
          startsAt: s2Start,
          endsAt: s2End,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          slug: `e2e-cal-jazz2-${Date.now()}`,
          addressText: "100 Calendar St, Test City, TS 00001",
          locality: "Test City",
          region: "TS",
        },
      });
      const s2Terms = await makePayoutTerms();
      await prisma.event.update({
        where: { id: seriesEvent2.id },
        data: { payoutTermsId: s2Terms.id },
      });

      await prisma.eventSeriesOccurrence.create({
        data: {
          seriesId: series.id,
          ordinal: 2,
          startsAt: s2Start,
          endsAt: s2End,
          status: "GENERATED",
          eventId: seriesEvent2.id,
        },
      });

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          placeId: place.id,
          placeSlug,
          eventTodayId: eventToday.id,
          eventTodayTitle: eventToday.title,
          eventTomorrowId: eventTomorrow.id,
          eventFutureId: eventFuture.id,
          seriesId: series.id,
          seriesName: series.name,
          seriesEvent1Id: seriesEvent1.id,
          seriesEvent2Id: seriesEvent2.id,
          eventCount: 5,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_venue_calendar_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_venue_calendar_failed",
        message,
      });
    }
  });
};

export default seedVenueCalendar;
