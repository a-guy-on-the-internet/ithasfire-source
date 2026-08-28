/**
 * E2E seed: Booking loop fixtures.
 *
 * POST /e2e/seed/booking-loop
 *
 * Creates everything the booking-loop / booking-embed-loop Playwright specs
 * need to drive the request → inbox → agreement → event flow end to end:
 *
 * - Venue org (the caller's email becomes OWNER) with a VERIFIED place that
 *   accepts booking requests, verified org PlaceOwnership, and a PUBLIC
 *   PLACE entity page so /p/[slug] renders the "Request to book" affordance.
 * - A performer user (credential sign-in, performer mode deliberately OFF so
 *   specs exercise the one-click gate) with an ACTIVE Payee so the
 *   party-line direct-finalize branch passes `payee_not_ready`.
 * - A third-party payee user (credential sign-in, ACTIVE Payee, PUBLIC
 *   entity page + search index entry so the agreement editor's
 *   HumanSearchCombobox can find them).
 * - An ACTIVE Embed row (subjectType "place") whose domain matches the
 *   spec's local cross-origin host page (default "localhost").
 * - A GLOBAL ACTIVE fee policy (payout-terms scaffolding parity with the
 *   other seeds).
 *
 * Idempotent-per-run via unique suffixes (venue-calendar seed convention).
 */
import type { FastifyPluginAsync } from "fastify";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@th/db";
import { env } from "../../lib/env.js";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
  seedHumanWithAuth,
  seedOrgWithMember,
} from "./_helpers.js";

const seedBookingLoop: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/booking-loop", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      embedDomain?: string;
      password?: string;
    };
    const email = body.email ?? "playwright-setup@example.com";
    const embedDomain = body.embedDomain ?? "localhost";
    const password = body.password ?? "Test-Account-2026!";
    const now = new Date();
    const suffix = Date.now();

    try {
      const venueHumanId = await resolveHumanId({ email });
      if (!venueHumanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      // ── Fee policy (payout terms scaffolding parity) ────────────────
      await seedFeePolicy({ createdBy: venueHumanId, now, notes: "e2e-booking-loop" });

      // ── Venue org + verified place + entity page ────────────────────
      const org = await seedOrgWithMember({
        name: "E2E Booking Venue Org",
        slugPrefix: "e2e-bkorg",
        humanId: venueHumanId,
      });

      const placeName = `E2E Booking Venue ${suffix}`;
      const pageSlug = `e2e-bk-venue-${suffix}`;
      const place = await prisma.place.create({
        data: {
          name: placeName,
          slug: `e2e-bk-place-${suffix}`,
          address: "42 Booking Loop, Test City, TS 00042",
          city: "Test City",
          region: "TS",
          country: "US",
          status: "ACTIVE",
          verification: "VERIFIED",
          acceptsBookingRequests: true,
        },
      });

      await prisma.placeOwnership.create({
        data: {
          placeId: place.id,
          ownerType: "ORGANIZATION",
          ownerId: org.id,
          verified: true,
        },
      });

      await prisma.entityPage.create({
        data: {
          ownerType: "PLACE",
          ownerId: place.id,
          slug: pageSlug,
          displayName: placeName,
          bio: "E2E booking loop venue",
          visibility: "PUBLIC",
        },
      });

      // ── Performer user (mode OFF; specs exercise the gate) ──────────
      const passwordHash = await hashPassword(password);

      const performerEmail = `e2e-bk-performer-${suffix}@example.com`;
      const performerName = `E2E Performer ${suffix}`;
      const { humanId: performerHumanId } = await seedHumanWithAuth({
        email: performerEmail,
        name: performerName,
        now,
      });
      // Human.name is the display name booking surfaces resolve (inbox
      // sender column, agreement parties, payout-line labels).
      await prisma.human.update({
        where: { id: performerHumanId },
        data: { name: performerName },
      });
      await prisma.authAccount.create({
        data: {
          providerId: "credential",
          accountId: performerHumanId,
          userId: performerHumanId,
          password: passwordHash,
        },
      });
      await prisma.entityPage.create({
        data: {
          ownerType: "HUMAN",
          ownerId: performerHumanId,
          slug: `e2e-bk-performer-${suffix}`,
          displayName: performerName,
          visibility: "PUBLIC",
        },
      });
      // ACTIVE payee so a party line finalizes (payee_not_ready gate).
      await prisma.payee.create({
        data: {
          subjectType: "HUMAN",
          subjectId: performerHumanId,
          stripeAccountId: `acct_e2e_bkperf_${suffix}`,
          status: "ACTIVE",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
          requirements: {},
        },
      });

      // ── Third-party payee (searchable; ACTIVE payee) ────────────────
      const thirdEmail = `e2e-bk-payee-${suffix}@example.com`;
      const thirdName = `E2E Third Payee ${suffix}`;
      const { humanId: thirdHumanId } = await seedHumanWithAuth({
        email: thirdEmail,
        name: thirdName,
        now,
      });
      await prisma.human.update({
        where: { id: thirdHumanId },
        data: { name: thirdName },
      });
      await prisma.authAccount.create({
        data: {
          providerId: "credential",
          accountId: thirdHumanId,
          userId: thirdHumanId,
          password: passwordHash,
        },
      });
      await prisma.entityPage.create({
        data: {
          ownerType: "HUMAN",
          ownerId: thirdHumanId,
          slug: `e2e-bk-payee-${suffix}`,
          displayName: thirdName,
          visibility: "PUBLIC",
        },
      });
      await prisma.payee.create({
        data: {
          subjectType: "HUMAN",
          subjectId: thirdHumanId,
          stripeAccountId: `acct_e2e_bkthird_${suffix}`,
          status: "ACTIVE",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
          requirements: {},
        },
      });

      // ── Embed row for the cross-origin booking widget ───────────────
      const embed = await prisma.embed.create({
        data: {
          subjectType: "place",
          subjectId: place.id,
          domain: embedDomain,
          status: "ACTIVE",
          createdBy: venueHumanId,
        },
      });

      // ── Search index (HumanSearchCombobox needs the payee human) ────
      // Postgres backend only — same posture as seed-unified-search.
      if (env.SEARCH_BACKEND === "postgres") {
        const { MultiIndexPostgresAdapter } = await import(
          "@th/adapters/search/multi-index-postgres-adapter"
        );
        const { buildSearchIndex } = await import(
          "@th/core/use-cases/search/build-search-index"
        );

        const multiSearch = new MultiIndexPostgresAdapter({
          prisma,
          weights: {
            fulltext: env.SEARCH_W_FULLTEXT,
            prefix: env.SEARCH_W_PREFIX,
            fuzzy: env.SEARCH_W_FUZZY,
            popularity: env.SEARCH_W_POPULARITY,
            geo: env.SEARCH_W_GEO,
          },
        });

        await buildSearchIndex(
          {
            repos: app.deps.trpc.repos,
            search: multiSearch,
            clock: app.deps.trpc.clock,
          },
          { fullReindex: true },
        );
      }

      return reply.status(200).send({
        ok: true,
        seed: {
          venueHumanId,
          orgId: org.id,
          orgSlug: org.slug,
          placeId: place.id,
          placeName,
          pageSlug,
          embedId: embed.id,
          embedDomain,
          performer: {
            humanId: performerHumanId,
            email: performerEmail,
            password,
            displayName: performerName,
          },
          thirdPayee: {
            humanId: thirdHumanId,
            email: thirdEmail,
            password,
            displayName: thirdName,
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_booking_loop_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_booking_loop_failed",
        message,
      });
    }
  });
};

export default seedBookingLoop;
