/**
 * E2E seed: Unified Search fixtures.
 *
 * POST /e2e/seed/unified-search
 *
 * Creates humans, profiles, orgs, places, events, and triggers a search
 * full reindex so the unified search can be exercised end-to-end.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import { env } from "../../lib/env";
import {
  assertE2eAuthorized,
  formatError,
  seedFeePolicy,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";

const seedUnifiedSearch: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/unified-search", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const now = new Date();
    const uniqueSuffix = Date.now();

    try {
      // ── Humans + AuthUsers ─────────────────────────────────────────
      const humanRecords = await Promise.all([
        prisma.human.create({ data: { status: "ACTIVE", roles: ["USER"] } }),
        prisma.human.create({ data: { status: "ACTIVE", roles: ["USER"] } }),
      ]);

      const authUsers = await Promise.all([
        prisma.authUser.create({
          data: {
            id: humanRecords[0].id,
            humanId: humanRecords[0].id,
            email: `search-test-alex-${uniqueSuffix}@example.com`,
            emailVerified: true,
            name: "Alex Rivera",
            createdAt: now,
            updatedAt: now,
          },
        }),
        prisma.authUser.create({
          data: {
            id: humanRecords[1].id,
            humanId: humanRecords[1].id,
            email: `search-test-maya-${uniqueSuffix}@example.com`,
            emailVerified: true,
            name: "Maya Chen",
            createdAt: now,
            updatedAt: now,
          },
        }),
      ]);

      const humans = humanRecords.map((h, i) => ({
        ...h,
        email: authUsers[i]!.email,
      }));

      // ── Entity Pages ───────────────────────────────────────────
      await Promise.all([
        prisma.entityPage.create({
          data: {
            ownerType: "HUMAN",
            ownerId: humans[0]!.id,
            displayName: "Alex Rivera",
            slug: `alex-rivera-${uniqueSuffix}`,
            bio: "Concert promoter and music lover",
            visibility: "PUBLIC",
          },
        }),
        prisma.entityPage.create({
          data: {
            ownerType: "HUMAN",
            ownerId: humans[1]!.id,
            displayName: "Maya Chen",
            slug: `maya-chen-${uniqueSuffix}`,
            bio: "Community event organizer",
            visibility: "PUBLIC",
          },
        }),
      ]);

      // ── Organizations ──────────────────────────────────────────────
      const orgs = await Promise.all([
        prisma.organization.create({
          data: {
            name: "Bay Area Music Collective",
            slug: `bamc-${uniqueSuffix}`,
            status: "ACTIVE",
            defaultLocale: null,
          },
        }),
        prisma.organization.create({
          data: {
            name: "Nightlife Productions",
            slug: `nightlife-prod-${uniqueSuffix}`,
            status: "ACTIVE",
            defaultLocale: null,
          },
        }),
      ]);

      // ── Places ─────────────────────────────────────────────────────
      const places = await Promise.all([
        prisma.place.create({
          data: {
            name: "The Fillmore",
            address: "1805 Geary Blvd, San Francisco, CA 94115",
            city: "San Francisco",
            region: "CA",
            country: "US",
            status: "ACTIVE",
          },
        }),
        prisma.place.create({
          data: {
            name: "The Independent",
            address: "628 Divisadero St, San Francisco, CA 94117",
            city: "San Francisco",
            region: "CA",
            country: "US",
            status: "ACTIVE",
          },
        }),
        prisma.place.create({
          data: {
            name: "Great American Music Hall",
            address: "859 O'Farrell St, San Francisco, CA 94109",
            city: "San Francisco",
            region: "CA",
            country: "US",
            status: "ACTIVE",
          },
        }),
      ]);

      // ── Fee policy ─────────────────────────────────────────────────
      const feePolicy = await seedFeePolicy({
        createdBy: humans[0]!.id,
        now,
        notes: "e2e-unified-search",
      });

      // ── Payee ──────────────────────────────────────────────────────
      const payee = await prisma.payee.create({
        data: {
          subjectType: "ORGANIZATION",
          subjectId: orgs[0]!.id,
          status: "ACTIVE",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
          requirements: {},
        },
      });

      // ── Payout terms ───────────────────────────────────────────
      const agreements = await Promise.all([
        prisma.payoutTerms.create({
          data: {
            kind: "PRIMARY",
            version: 1,
            isDefault: true,
            settlementCurrency: "usd",
            status: "ACTIVE",
            feePolicyId: feePolicy.id,
          },
        }),
        prisma.payoutTerms.create({
          data: {
            kind: "PRIMARY",
            version: 1,
            isDefault: true,
            settlementCurrency: "usd",
            status: "ACTIVE",
            feePolicyId: feePolicy.id,
          },
        }),
        prisma.payoutTerms.create({
          data: {
            kind: "PRIMARY",
            version: 1,
            isDefault: true,
            settlementCurrency: "usd",
            status: "ACTIVE",
            feePolicyId: feePolicy.id,
          },
        }),
      ]);

      // ── Payout terms lines ─────────────────────────────────────────
      await Promise.all(
        agreements.map((agreement) =>
          prisma.payoutTermsLine.create({
            data: {
              payoutTermsId: agreement.id,
              payeeId: payee.id,
              percent: 100,
              floorCents: 0,
              priority: 0,
              rounding: "FLOOR",
            },
          }),
        ),
      );

      // ── Events ─────────────────────────────────────────────────────
      // Snapshot payout terms per-event before the parallel creates.
      const [pt0, pt1, pt2] = await Promise.all([
        snapshotPayoutTermsForE2eEvent(prisma, agreements[0].id),
        snapshotPayoutTermsForE2eEvent(prisma, agreements[1].id),
        snapshotPayoutTermsForE2eEvent(prisma, agreements[2].id),
      ]);
      const events = await Promise.all([
        prisma.event.create({
          data: {
            title: "Summer Jazz Festival",
            orgId: orgs[0].id,
            humanId: null,
            placeId: places[0].id,
            startsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            endsAt: new Date(
              now.getTime() + 7 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000,
            ),
            status: "PUBLISHED",
            visibility: "PUBLIC",
            gateType: "NONE",
            slug: `summer-jazz-festival-${uniqueSuffix}`,
            addressText: places[0].address,
            regionCode: "CA",
            payoutTermsId: pt0,
          },
        }),
        prisma.event.create({
          data: {
            title: "Electronic Music Night",
            orgId: orgs[1].id,
            humanId: null,
            placeId: places[1].id,
            startsAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
            endsAt: new Date(
              now.getTime() + 14 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000,
            ),
            status: "PUBLISHED",
            visibility: "PUBLIC",
            gateType: "NONE",
            slug: `electronic-music-night-${uniqueSuffix}`,
            addressText: places[1].address,
            regionCode: "CA",
            payoutTermsId: pt1,
          },
        }),
        prisma.event.create({
          data: {
            title: "Indie Rock Showcase",
            orgId: orgs[0].id,
            humanId: null,
            placeId: places[2].id,
            startsAt: new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000),
            endsAt: new Date(
              now.getTime() + 21 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000,
            ),
            status: "PUBLISHED",
            visibility: "PUBLIC",
            gateType: "NONE",
            slug: `indie-rock-showcase-${uniqueSuffix}`,
            addressText: places[2].address,
            regionCode: "CA",
            payoutTermsId: pt2,
          },
        }),
      ]);

      // Events already link to payout terms via payoutTermsId FK.
      // No fixup needed.

      // ── Build search index if a backend is available ───────────────
      let indexingResult = null;
      const meiliHost = process.env.MEILISEARCH_HOST;
      const meiliKey = process.env.MEILISEARCH_API_KEY;

      if (env.SEARCH_BACKEND === "postgres") {
        const { MultiIndexPostgresAdapter } =
          await import("@th/adapters/search/multi-index-postgres-adapter");
        const { buildSearchIndex } =
          await import("@th/core/use-cases/search/build-search-index");

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

        indexingResult = await buildSearchIndex(
          {
            repos: app.deps.trpc.repos,
            search: multiSearch,
            clock: app.deps.trpc.clock,
          },
          { fullReindex: true },
        );
      } else if (meiliHost && meiliKey) {
        const { MultiIndexMeilisearchAdapter } =
          await import("@th/adapters/search/multi-index-meilisearch-adapter");
        const { buildSearchIndex } =
          await import("@th/core/use-cases/search/build-search-index");

        const multiSearch = new MultiIndexMeilisearchAdapter({
          host: meiliHost,
          apiKey: meiliKey,
        });

        indexingResult = await buildSearchIndex(
          {
            repos: app.deps.trpc.repos,
            search: multiSearch,
            clock: app.deps.trpc.clock,
          },
          { fullReindex: true },
        );
      }

      return reply.send({
        ok: true,
        seed: {
          humans: humans.map((h) => ({ id: h.id, email: h.email })),
          organizations: orgs.map((o) => ({
            id: o.id,
            name: o.name,
            slug: o.slug,
          })),
          places: places.map((p) => ({ id: p.id, name: p.name })),
          events: events.map((e) => ({
            id: e.id,
            title: e.title,
            slug: e.slug,
          })),
          indexingResult,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_unified_search_failed",
        message,
      });
    }
  });
};

export default seedUnifiedSearch;
