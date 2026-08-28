import { randomUUID } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { hashPassword } from "better-auth/crypto";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { createMailerFromConfig } from "@th/adapters/comms/mail";
import { prisma } from "@th/db";
import { finalizePaymentIntent } from "@th/core/use-cases/orders/finalize-from-payment-intent";
import { updateOrderItems } from "@th/core/use-cases/orders/update-order-items";
import { createCheckout } from "@th/core/use-cases/orders/create-checkout";
import { listOrderSplits } from "@th/core/use-cases/splits/list-order-splits";
import { createCreditsFromOrder } from "@th/core/use-cases/settlements/create-credits-from-order";
import { getSettlement } from "@th/core/use-cases/settlements/get-settlement";
import { quoteFullRefund } from "@th/core/use-cases/orders/quote-full-refund";
import { refundFullOrder } from "@th/core/use-cases/orders/refund-full-order";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "@th/core/lib/payments";
import { hashEventPassword } from "@th/core/lib/security/event-password";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
// The ONE fee-policy writer for e2e fixtures. This file used to hand-type a
// rate table (`buyerFeePct: "0.03"` with `maxFeeCents: null` — an UNCAPPED 3%
// that is not, and never was, the shipped policy). Routing through the shared
// helper means the fixtures spread `PLATFORM_FEE_POLICY`, the same constant the
// deploy-time reconciler materializes, and it archives the scope's previous
// ACTIVE row so the seeds satisfy `FeePolicy_one_active_per_scope_key`.
// Deliberately imported from the LIVE `routes/e2e/` split (no cycle: the
// helpers module imports nothing from this file) so the two cannot drift.
import { seedFeePolicy } from "./e2e/_helpers.js";
import { env } from "../lib/env";

/**
 * E2E-only helpers.
 *
 * These routes are guarded by NODE_ENV !== "production" AND an explicit secret
 * header so they can't be called accidentally.
 */
const plugin: FastifyPluginAsync = async (app) => {
  // Helper to produce a sensible error message for non-Error objects.
  function formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    try {
      return JSON.stringify(err);
    } catch (_) {
      return String(err);
    }
  }

  const assertE2eAuthorized = (request: any, reply: any) => {
    if (process.env.NODE_ENV === "production") {
      reply.status(404).send({ ok: false });
      return false;
    }

    const expected = process.env.E2E_RESET_SECRET;
    const provided = request.headers["x-e2e-reset-secret"];
    if (!expected || typeof provided !== "string" || provided !== expected) {
      reply.status(401).send({ ok: false, error: "unauthorized" });
      return false;
    }

    return true;
  };

  app.post("/e2e/reset", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    // Accept an optional `preserveEmail` in the body. When provided, the
    // reset will keep the AuthUser / AuthAccount / AuthSession / Human rows
    // for that email so the Playwright storageState (session cookies) stays
    // valid across reset + re-seed cycles.
    const body = (request.body ?? {}) as { preserveEmail?: string };
    const preserveEmail =
      typeof body.preserveEmail === "string" && body.preserveEmail
        ? body.preserveEmail
        : null;

    // Resolve both the AuthUser.id and the linked Human.id to preserve.
    // AuthUser.id is used as the FK in AuthSession/AuthAccount (userId).
    // AuthUser.humanId is the link to Human.id (optional).
    let preserveAuthUserId: string | null = null;
    let preserveHumanId: string | null = null;
    if (preserveEmail) {
      const authUser = await prisma.authUser
        .findUnique({ where: { email: preserveEmail } })
        .catch(() => null);
      preserveAuthUserId = authUser?.id ?? null;
      preserveHumanId = authUser?.humanId ?? null;
    }

    // Better Auth is persisted in our Prisma DB models:
    // AuthUser, AuthAccount, AuthSession, AuthVerification.
    // AuthUser has a 1:1 optional link to Human, and uses onDelete: Cascade.
    //
    // To make signup tests strict and deterministic, we delete AuthUser rows
    // (except the preserved one). Cascades will remove associated rows.
    //
    // NOTE: This is intentionally destructive and must never be enabled in prod.
    try {
      // Delete in FK-safe order so we're not dependent on cascade behavior.
      // Keep this list intentionally aggressive: E2E tests should be able to
      // build a fully-deterministic graph (humans/orgs/events/payees/orders)
      // without leaking state between runs.
      //
      // If you add new money-flow tables, add them here so Stripe E2Es remain
      // stable.

      // Domain/money-flow tables (newest -> oldest / most-dependent -> least).
      await prisma.payoutItemSettlement.deleteMany({}).catch(() => undefined);
      await prisma.payoutItem.deleteMany({}).catch(() => undefined);
      await prisma.payout.deleteMany({}).catch(() => undefined);
      await prisma.settlementLine.deleteMany({}).catch(() => undefined);
      await prisma.settlement.deleteMany({}).catch(() => undefined);

      await prisma.orderSplit.deleteMany({}).catch(() => undefined);
      await prisma.orderItem.deleteMany({}).catch(() => undefined);
      await prisma.order.deleteMany({}).catch(() => undefined);

      await prisma.ticket.deleteMany({}).catch(() => undefined);
      // NOTE: Some environments don't have seat tables yet.
      await (prisma as any).seatHold?.deleteMany?.({}).catch(() => undefined);
      await (prisma as any).seat?.deleteMany?.({}).catch(() => undefined);

      await prisma.promoHold.deleteMany({}).catch(() => undefined);
      await prisma.promo.deleteMany({}).catch(() => undefined);

      await prisma.payoutTermsLine.deleteMany({}).catch(() => undefined);
      await prisma.payoutTerms.deleteMany({}).catch(() => undefined);
      await prisma.feePolicy.deleteMany({}).catch(() => undefined);

      await prisma.payee.deleteMany({}).catch(() => undefined);
      // Prisma model is `ticketType` (not `eventTicketType`) in the current schema.
      await prisma.ticketType.deleteMany({}).catch(() => undefined);
      await prisma.event.deleteMany({}).catch(() => undefined);

      // Place-related tables (ownership must go before places).
      await prisma.placeOwnership.deleteMany({}).catch(() => undefined);
      await prisma.placeSlugHistory.deleteMany({}).catch(() => undefined);
      await prisma.placeLayout.deleteMany({}).catch(() => undefined);
      await prisma.place.deleteMany({}).catch(() => undefined);

      await prisma.orgMember.deleteMany({}).catch(() => undefined);
      await prisma.organization.deleteMany({}).catch(() => undefined);
      await prisma.entityPage.deleteMany({}).catch(() => undefined);
      await prisma.human
        .deleteMany({
          where: preserveHumanId ? { id: { not: preserveHumanId } } : {},
        })
        .catch(() => undefined);
      await prisma.apiKey.deleteMany({}).catch(() => undefined);

      // Better Auth tables — preserve the Playwright test user's session.
      // AuthSession.userId and AuthAccount.userId reference AuthUser.id.
      await prisma.authSession.deleteMany({
        where: preserveAuthUserId
          ? { userId: { not: preserveAuthUserId } }
          : {},
      });
      await prisma.authAccount.deleteMany({
        where: preserveAuthUserId
          ? { userId: { not: preserveAuthUserId } }
          : {},
      });
      await prisma.authVerification.deleteMany({});
      await prisma.authUser.deleteMany({
        where: preserveAuthUserId ? { id: { not: preserveAuthUserId } } : {},
      });
    } catch (err) {
      // If the local DB hasn't been migrated yet, these tables won't exist.
      // Surface a clear message so E2E runs fail with actionable output.
      const message = err instanceof Error ? err.message : formatError(err);
      return reply.status(500).send({
        ok: false,
        error: "e2e_reset_failed",
        message,
      });
    }

    return reply.send({ ok: true });
  });

  // E2E-only: mark a Better Auth user as email-verified so password sign-in can proceed.
  // This is test-only because it bypasses the verification email flow.
  app.post("/e2e/auth/verify-email", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    if (!body.email || typeof body.email !== "string") {
      return reply.status(400).send({ ok: false, error: "invalid_input" });
    }

    const user = await prisma.authUser.findUnique({
      where: { email: body.email },
    });
    if (!user) {
      return reply
        .status(404)
        .send({ ok: false, error: "auth_user_not_found" });
    }

    await prisma.authUser.update({
      where: { email: body.email },
      data: { emailVerified: true },
    });

    await prisma.authVerification
      .deleteMany({
        where: { identifier: body.email },
      })
      .catch(() => undefined);

    return reply.send({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Seed Auth User
  // ─────────────────────────────────────────────────────────────────────────
  // Creates a simple authenticated user for E2E testing. Useful when tests
  // need multiple users (e.g., testing targeted magic links).
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/seed/auth-user", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
    };

    const email = body.email ?? `e2e-user-${Date.now()}@example.com`;
    const name = body.name ?? "E2E Test User";
    const now = new Date();

    try {
      // Create human
      const human = await prisma.human.create({
        data: {
          status: "ACTIVE",
          roles: ["USER"],
        },
      });

      // Create auth user
      await prisma.authUser.create({
        data: {
          id: human.id,
          humanId: human.id,
          email,
          emailVerified: true,
          name,
          createdAt: now,
          updatedAt: now,
        },
      });

      // Create auth account (password hash) if password provided
      // Note: For simplicity, we skip hashing and rely on the test knowing the password
      // Real auth flow is tested elsewhere

      return reply.send({
        ok: true,
        seed: {
          email,
          humanId: human.id,
          name,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, "e2e_seed_auth_user_failed");
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_auth_user_failed", message });
    }
  });

  app.post("/e2e/seed/paid-checkout", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    // We accept optional overrides from the caller, but keep a sane default.
    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      currency?: string;
      priceCents?: number;
      nowIso?: string;
      stripeAccountId?: string;
      startsAt?: string;
      refundCutoffAt?: string;
      acceptChargebackTerms?: boolean;
      /** Optional location fields for the seeded event */
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
    const now = body.nowIso ? new Date(body.nowIso) : new Date();
    // Use a valid Sandbox Connected Account ID so real-stripe tests don't fail on "No such destination".
    const stripeAccountId =
      body.stripeAccountId ??
      env.E2E_STRIPE_ACCOUNT_ID ??
      "acct_1SsQuGFPwBURBn1I";
    // Allow overriding event start time for testing refund eligibility
    const startsAt = body.startsAt
      ? new Date(body.startsAt)
      : new Date(now.getTime() + 86_400_000);
    // Allow overriding refund cutoff for testing past_refund_deadline scenario
    const refundCutoffAt = body.refundCutoffAt
      ? new Date(body.refundCutoffAt)
      : null;
    const acceptChargebackTerms = body.acceptChargebackTerms !== false;

    try {
      // Create a bare minimum domain graph with Prisma.
      // This intentionally bypasses use cases: it's test-only fixture plumbing.
      // prisma comes from @th/db

      const human = await prisma.human.create({
        data: {
          status: "ACTIVE",
          roles: ["USER"],
        },
      });

      // Better Auth requires an authUser for login flows and actor resolution.
      // Identity data (email, phone, verified) lives here, not on Human.
      await prisma.authUser.create({
        data: {
          id: human.id,
          humanId: human.id,
          email,
          emailVerified: true,
          name: "E2E Buyer",
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      // Create a credential account so Better Auth sign-in works for this user.
      const passwordHash = await hashPassword(password);
      await prisma.authAccount.create({
        data: {
          providerId: "credential",
          accountId: human.id,
          userId: human.id,
          password: passwordHash,
        },
      });

      const org = await prisma.organization.create({
        data: {
          name: "E2E Org",
          slug: `e2e-org-${Date.now()}`,
          status: "ACTIVE",
          defaultLocale: null,
          chargebackTermsVersion: acceptChargebackTerms
            ? CURRENT_CHARGEBACK_TERMS_VERSION
            : null,
          chargebackTermsAcceptedAt: acceptChargebackTerms ? now : null,
          chargebackTermsAcceptedByHumanId: acceptChargebackTerms
            ? human.id
            : null,
        },
      });

      // Fee policy + agreement (primary) so createCheckout can price.
      const feePolicy = await seedFeePolicy({
        createdBy: human.id,
        now,
        notes: "e2e",
      });

      const agreement = await prisma.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          version: 1,
          isDefault: true,
          settlementCurrency: currency,
          status: "ACTIVE",
          feePolicyId: feePolicy.id,
        },
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

      await prisma.payoutTermsLine.create({
        data: {
          payoutTermsId: agreement.id,
          payeeId: payee.id,
          // Prisma schema uses integer percent (0-100).
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      });

      const event = await prisma.event.create({
        data: {
          title: "E2E Paid Checkout Event",
          orgId: org.id,
          humanId: null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000), // 1 hour after start
          refundCutoffAt,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          currency,
          payoutTermsId: agreement.id,
          slug: `e2e-paid-checkout-event-${Date.now()}`,
          // Optional location fields for testing location preview
          ...(body.location
            ? {
                addressText: body.location.addressText ?? null,
                lat: body.location.lat ?? null,
                lng: body.location.lng ?? null,
                locality: body.location.locality ?? null,
                region: body.location.region ?? null,
                countryCode: body.location.countryCode ?? null,
                locationMode: "EXACT",
              }
            : {}),
        },
      });

      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "General Admission",
          status: "ACTIVE",
          priceCents,
          capacity: 100,
          seatSectionId: null,
        },
      });

      // Create an OrgMember so the seed human can access admin pages for this org.
      await prisma.orgMember.create({
        data: {
          orgId: org.id,
          humanId: human.id,
          role: "OWNER",
        },
      });

      return reply.send({
        ok: true,
        seed: {
          email,
          password,
          humanId: human.id,
          orgId: org.id,
          orgSlug: org.slug,
          agreementId: agreement.id,
          eventId: event.id,
          eventSlug: event.slug,
          ticketTypeId: ticketType.id,
          stripeAccountId,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_failed", message });
    }
  });

  /**
   * E2E seed route for unified search testing.
   * Creates a diverse set of entities (events, humans, places, organizations)
   * and indexes them in Meilisearch so the unified search can be tested.
   *
   * This is E2E-only because it directly manipulates the DB to create test fixtures
   * and triggers a search index rebuild.
   */
  app.post("/e2e/seed/unified-search", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const now = new Date();
    const uniqueSuffix = Date.now();

    try {
      // Create test humans first (domain identity)
      const humanRecords = await Promise.all([
        prisma.human.create({
          data: {
            status: "ACTIVE",
            roles: ["USER"],
          },
        }),
        prisma.human.create({
          data: {
            status: "ACTIVE",
            roles: ["USER"],
          },
        }),
      ]);

      // Create auth users for identity data (email/phone/verified lives here)
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

      // Combine for response
      const humans = humanRecords.map((h, i) => ({
        ...h,
        email: authUsers[i]!.email,
      }));

      // Create entity pages for the humans
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

      // Create test organizations
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

      // Create test places (venues) - using 'address' field per schema
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

      // Create fee policy for agreements
      const feePolicy = await seedFeePolicy({
        createdBy: humans[0]!.id,
        now,
        notes: "e2e-unified-search",
      });

      // Create payee for agreements
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

      // Create payout terms for events
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

      // Create payout terms lines
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

      // Create test events with required payoutTermsId
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
            payoutTermsId: agreements[0].id,
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
            payoutTermsId: agreements[1].id,
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
            payoutTermsId: agreements[2].id,
          },
        }),
      ]);

      // Build search index if a backend is available.
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
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_unified_search_failed", message });
    }
  });

  app.post("/e2e/finalize-order", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      orderId?: string;
      paymentIntentId?: string;
    };

    if (!body.orderId || typeof body.orderId !== "string") {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    const order = await prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        items: true,
        buyer: {
          include: { authUser: true },
        },
        event: {
          include: {
            place: true,
          },
        },
      },
    });
    if (!order) {
      return reply.status(404).send({ ok: false, error: "order_not_found" });
    }
    // Order.eventId is nullable now that membership invoices are Orders.
    // This e2e helper drives the ticketing flow and dereferences the event.
    if (!order.event) {
      return reply
        .status(400)
        .send({ ok: false, error: "order_has_no_event" });
    }
    const orderEvent = order.event;

    const paymentIntentId =
      (typeof body.paymentIntentId === "string" &&
      body.paymentIntentId.length > 0
        ? body.paymentIntentId
        : order.stripePaymentIntentId) ?? `pi_e2e_${Date.now()}`;
    const amountReceived = computeExpectedAmount(order);

    try {
      const finalizeDeps = {
        ...app.deps.trpc,
        onSettlementFailure: app.deps.trpc.onSettlementFailure ?? undefined,
      };
      await finalizePaymentIntent(finalizeDeps, {
        stripeEvent: {
          id: `evt_e2e_${Date.now()}`,
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: paymentIntentId,
              status: "succeeded",
              amount_received: amountReceived,
              currency: order.currency.toLowerCase(),
              metadata: {
                orderId: order.id,
                eventId: order.eventId,
                source: order.source.toLowerCase(),
              },
            },
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_finalize_failed", message });
    }

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });
    const tickets = await prisma.ticket.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        code: true,
      },
    });
    const ticketCount = tickets.length;

    const publicAppUrl =
      process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
    const manageUrl = `${publicAppUrl.replace(/\/+$/, "")}/orders/${order.id}`;
    // Order-aware support CTA: the buyer's ticket.issued email links to the
    // help section of their own order page, mirroring sendTicketIssuedEmail.
    const supportUrl = `${publicAppUrl.replace(/\/+$/, "")}/my-tickets/${order.id}#get-help`;
    const venueName =
      orderEvent.place?.name ?? orderEvent.addressText ?? "Venue TBA";
    const qrBaseUrl = `${publicAppUrl.replace(/\/+$/, "")}/tickets/qr`;
    const ticketAssets = tickets.map((ticket) => ({
      code: ticket.code,
      qrUrl: `${qrBaseUrl}/${ticket.code}`,
    }));

    const isPlaywrightE2E = process.env.PLAYWRIGHT_E2E === "1";
    const isPlainSmtp = isPlaywrightE2E || env.SMTP_SECURE === false;
    const mailer = createMailerFromConfig({
      resendApiKey: env.RESEND_API_KEY,
      defaultFromEmail: env.SMTP_DEFAULT_FROM_EMAIL,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUsername: env.SMTP_USERNAME,
      smtpPassword: env.SMTP_PASSWORD,
      appHeaderValue: env.SMTP_APP_HEADER,
      plainSmtp: isPlainSmtp,
      logger: createPinoLoggerAdapter(),
    });

    if (!mailer) {
      return reply.status(500).send({
        ok: false,
        error: "mailer_not_configured",
      });
    }

    await mailer.send({
      to: { to: order.buyer.authUser?.email ?? "" },
      template: {
        key: "ticket.issued",
        variables: {
          eventTitle: orderEvent.title,
          eventDateISO: orderEvent.startsAt.toISOString(),
          venueName,
          tickets: ticketAssets,
          orderId: order.id,
          manageUrl,
          supportUrl,
        },
      },
      idempotencyKey: `e2e-ticket-issued:${order.id}`,
    });

    return reply.send({
      ok: true,
      orderId: order.id,
      status: updatedOrder?.status ?? order.status,
      amountReceived,
      ticketCount,
      tickets: ticketAssets,
    });
  });

  app.post("/e2e/checkout/hold", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      humanId?: string;
      eventId?: string;
      orderId?: string;
      items?: Array<{ ticketTypeId: string; qty: number }>;
    };

    const actorHumanId = await resolveHumanId(body);
    if (!actorHumanId) {
      return reply.status(400).send({ ok: false, error: "missing_human" });
    }
    if (
      !body.eventId ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    ) {
      return reply.status(400).send({ ok: false, error: "missing_items" });
    }

    try {
      const result = await updateOrderItems(app.deps.trpc, {
        actorHumanId,
        eventId: body.eventId,
        orderId: body.orderId,
        items: body.items,
      });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_hold_failed", message });
    }
  });

  // Helper to inspect order status during E2E polling
  app.get("/e2e/orders/:id", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;
    const { id } = request.params as { id: string };
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return reply.status(404).send({ ok: false });
    return reply.send(order);
  });

  // Helper to inspect event geo fields during E2E assertions
  app.get("/e2e/events/:id", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;
    const { id } = request.params as { id: string };
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        addressText: true,
        lat: true,
        lng: true,
        locality: true,
        region: true,
        countryCode: true,
        postalCode: true,
        placeId: true,
        savedLocationId: true,
      },
    });
    if (!event) return reply.status(404).send({ ok: false });
    return reply.send(event);
  });

  app.post("/e2e/checkout/create", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      humanId?: string;
      eventId?: string;
      items?: Array<{ ticketTypeId: string; qty: number }>;
      currency?: string;
      clientKey?: string;
    };

    const actorHumanId = await resolveHumanId(body);
    if (!actorHumanId) {
      return reply.status(400).send({ ok: false, error: "missing_human" });
    }
    if (
      !body.eventId ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    ) {
      return reply.status(400).send({ ok: false, error: "missing_items" });
    }

    try {
      const stripeMode = env.E2E_STRIPE_MODE ?? "sandbox";
      if (stripeMode === "sandbox" && !env.STRIPE_SECRET_KEY) {
        return reply.status(500).send({
          ok: false,
          error: "missing_stripe_secret",
          message: "STRIPE_SECRET_KEY is required for sandbox E2E checkout.",
        });
      }
      if (stripeMode === "sandbox" && !env.STRIPE_WEBHOOK_SECRET) {
        return reply.status(500).send({
          ok: false,
          error: "missing_stripe_webhook_secret",
          message:
            "STRIPE_WEBHOOK_SECRET is required for sandbox E2E checkout. Run `stripe listen --forward-to http://localhost:3001/webhooks/stripe` and export the whsec_ value.",
        });
      }
      const shouldStub = stripeMode === "stub";

      const payments: PaymentProcessorPort = shouldStub
        ? {
            createPaymentIntent: async (input) => ({
              id: `pi_e2e_${Date.now()}`,
              clientSecret: `pi_e2e_secret_${input.amountCents}`,
            }),
            refundPaymentIntent: async () => ({
              refundId: `re_e2e_${Date.now()}`,
              status: "succeeded" as const,
            }),
            cancelPaymentIntent: async () => ({ canceled: true }),
            retrievePaymentIntent: async () => ({
              id: `pi_e2e_${Date.now()}`,
              status: "succeeded",
              amountReceived: 0,
              currency: "usd",
              metadata: {},
            }),
            getProcessingFeeForPaymentIntent: async () => ({
              feeCents: 0,
              currency: "usd",
            }),
            createTransfer: async () => ({ id: `tr_e2e_${Date.now()}` }),
            getChargeIdForPaymentIntent: async () => ({
              chargeId: `ch_e2e_${Date.now()}`,
            }),
            createConnectAccount: async () => ({
              accountId: `acct_e2e_${Date.now()}`,
            }),
            createAccountOnboardingLink: async () => ({
              url: "https://connect.stripe.com/setup/e2e_stub",
            }),
            createConnectLoginLink: async () => ({
              url: "https://connect.stripe.com/express/e2e_stub",
            }),
            getConnectAccountStatus: async () => ({
              chargesEnabled: false,
              payoutsEnabled: false,
              detailsSubmitted: false,
              requirements: {
                currentlyDue: [],
                eventuallyDue: [],
                pastDue: [],
              },
            }),
            calculateTax: async () => ({
              taxAmountCents: 0,
              calculationId: null,
            }),
            getPaymentMethodType: async () => ({ methodType: "card" }),
            reverseTransfer: async () => ({
              reversalId: `trr_e2e_${Date.now()}`,
            }),
            // Unbounded capacity: the stub never models prior reversals, so
            // the remaining-capacity pre-flight in reverseTransfersForItems
            // must never clamp under it.
            getTransfer: async () => ({
              amountCents: Number.MAX_SAFE_INTEGER,
              amountReversedCents: 0,
            }),
            // No prior reversals: with unbounded capacity above, the
            // recovery path in reverseTransfersForItems is never entered.
            listTransferReversals: async () => [],
            createTerminalConnectionToken: async () => ({
              secret: `pst_e2e_${Date.now()}`,
            }),
            createTerminalLocation: async () => ({
              locationId: `tml_e2e_${Date.now()}`,
            }),
            createCardPresentPaymentIntent: async (input) => ({
              paymentIntentId: `pi_cp_e2e_${Date.now()}`,
              clientSecret: `pi_cp_e2e_secret_${input.amountCents}`,
            }),
            // Terminal reader ops are out of scope for the e2e checkout stub.
            registerTerminalReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            getTerminalReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            deleteTerminalReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            processPaymentIntentOnReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            cancelReaderAction: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
          }
        : app.deps.trpc.payments;

      const result = await createCheckout(
        {
          ...app.deps.trpc,
          payments,
          onSettlementFailure: app.deps.trpc.onSettlementFailure ?? undefined,
          // `TrpcDeps.reportError` is `?: ReporterPort | null` (null is a
          // meaningful "no reporter wired" at the transport boundary), but the
          // use-case convention is `?: ReporterPort` — see CLAUDE.md. Normalise
          // null → undefined here, same as `onSettlementFailure` above.
          reportError: app.deps.trpc.reportError ?? undefined,
        },
        {
          actorHumanId,
          buyerHumanId: actorHumanId,
          eventId: body.eventId,
          clientKey: body.clientKey ?? `e2e-checkout-${Date.now()}`,
          currency: body.currency ?? "usd",
          items: body.items,
        },
      );
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_checkout_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Get Order Splits
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/e2e/orders/:orderId/splits", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const result = await listOrderSplits(app.deps.trpc, { orderId });
      return reply.send({
        ok: true,
        orderId: result.orderId,
        splits: result.splits,
        totalCents: result.totalCents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_splits_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Create Ledger Credits from Order Splits
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/settlements/create-from-order", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      orderId?: string;
    };

    if (!body.orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const output = await createCreditsFromOrder(
        {
          ...app.deps.trpc,
          // Same maturity bridge as routes/e2e/settlements.ts (the REGISTERED
          // copy — this monolith is unregistered legacy). The context's key is
          // `devInstantPayouts`; the use case reads `instantPayouts`, so a bare
          // spread leaves credits unmatured and the batch pays nothing.
          instantPayouts: true,
        },
        {
          orderId: body.orderId,
        },
      );

      return reply.send({
        ok: true,
        orderId: output.orderId,
        credits: output.credits,
        skippedZeroAmount: output.skippedZeroAmount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_settlement_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Get Settlement Details
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/e2e/settlements/:settlementId", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { settlementId } = request.params as { settlementId: string };
    if (!settlementId) {
      return reply
        .status(400)
        .send({ ok: false, error: "missing_settlement_id" });
    }

    try {
      const data = await getSettlement(app.deps.trpc, { settlementId });
      return reply.send({
        ok: true,
        settlement: data.settlement,
        payee: data.payee,
        lines: data.lines,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_settlement_get_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: List Settlements for Order
  // ─────────────────────────────────────────────────────────────────────────
  // E2E-only: This is a test inspection helper to verify that settlements
  // are automatically created during order finalization. Real users don't
  // need this - settlement visibility is an admin/finance concern handled
  // through dedicated dashboards, not per-order queries.
  app.get("/e2e/orders/:orderId/settlements", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      // Query settlement lines by order, then group by settlement
      const lines = await prisma.settlementLine.findMany({
        where: { orderId },
        include: {
          settlement: {
            include: {
              payee: true,
              payoutTerms: true,
              event: true,
            },
          },
        },
      });

      // Group by settlement ID
      const settlementsMap = new Map<
        string,
        {
          id: string;
          payeeId: string;
          scheduledPayoutDate: Date;
          amountCents: number;
          currency: string;
          status: string;
          stripeTransferId: string | null;
          payoutTermsId: string | null;
          eventId: string | null;
          lines: Array<{
            id: string;
            amountCents: number;
            orderSplitId: string;
          }>;
        }
      >();

      for (const line of lines) {
        const s = line.settlement;
        if (!settlementsMap.has(s.id)) {
          settlementsMap.set(s.id, {
            id: s.id,
            payeeId: s.payeeId,
            scheduledPayoutDate: s.scheduledPayoutDate,
            amountCents: s.amountCents,
            currency: s.currency,
            status: s.status,
            stripeTransferId: s.stripeTransferId,
            payoutTermsId: s.payoutTermsId,
            eventId: s.eventId,
            lines: [],
          });
        }
        settlementsMap.get(s.id)!.lines.push({
          id: line.id,
          amountCents: line.amountCents,
          orderSplitId: line.orderSplitId,
        });
      }

      return reply.send({
        ok: true,
        orderId,
        settlements: Array.from(settlementsMap.values()),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_settlements_list_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Quote Instant Refund
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/orders/:orderId/quote-refund", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    const body = (request.body ?? {}) as { actorHumanId?: string };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }
    if (!body.actorHumanId) {
      return reply
        .status(400)
        .send({ ok: false, error: "missing_actor_human_id" });
    }

    try {
      const quote = await quoteFullRefund(app.deps.trpc, {
        actorHumanId: body.actorHumanId,
        orderId,
      });
      return reply.send({
        ok: true,
        orderId: quote.orderId,
        currency: quote.currency,
        amountPaidCents: quote.amountPaidCents,
        stripeFeeCents: quote.stripeFeeCents,
        refundableCents: quote.refundableCents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      const code =
        err && typeof err === "object" && (err as any).code
          ? (err as any).code
          : undefined;
      let status = 500;
      if (code === "not_found") status = 404;
      if (code === "conflict") status = 409;
      app.log.error({ err, orderId }, "e2e_quote_refund_failed");
      return reply
        .status(status)
        .send({ ok: false, error: "e2e_quote_refund_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Execute Full Order Refund
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/orders/:orderId/refund", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    const body = (request.body ?? {}) as {
      actorHumanId?: string;
      reason?: string;
    };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }
    if (!body.actorHumanId) {
      return reply
        .status(400)
        .send({ ok: false, error: "missing_actor_human_id" });
    }

    try {
      const result = await refundFullOrder(app.deps.trpc, {
        actorHumanId: body.actorHumanId,
        orderId,
        reason: body.reason as
          | "requested_by_customer"
          | "fraudulent"
          | "other"
          | undefined,
      });
      return reply.send({
        ok: true,
        orderId: result.orderId,
        refundId: result.refundId,
        currency: result.currency,
        amountPaidCents: result.amountPaidCents,
        stripeFeeCents: result.stripeFeeCents,
        refundedCents: result.refundedCents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      const code =
        err && typeof err === "object" && (err as any).code
          ? (err as any).code
          : undefined;
      let status = 500;
      if (code === "not_found") status = 404;
      if (code === "conflict") status = 409;
      app.log.error({ err, orderId }, "e2e_refund_failed");
      return reply
        .status(status)
        .send({ ok: false, error: "e2e_refund_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Mark Order Item(s) as Paid Out
  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: This is E2E-only because:
  // 1. Production paidOutAt is set automatically by the payout batch
  // 2. This allows testing refund-blocked-by-payout scenarios without running
  //    a full settlement flow (which requires Stripe connected accounts)
  // 3. Real users never manually mark items as paid out—it's settlement-driven
  //
  // As of item-level settlements migration, this endpoint marks OrderItems
  // (not the Order) as paid out. If itemIds is not provided, all items in
  // the order are marked.
  app.post("/e2e/orders/:orderId/mark-paid-out", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    const body = (request.body ?? {}) as {
      paidOutAt?: string;
      itemIds?: string[];
    };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const paidOutAt = body.paidOutAt ? new Date(body.paidOutAt) : new Date();

      // Get order items
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: { select: { id: true } } },
      });

      if (!order) {
        return reply.status(404).send({ ok: false, error: "order_not_found" });
      }

      // Determine which items to mark
      const itemIdsToMark = body.itemIds?.length
        ? body.itemIds
        : order.items.map((i) => i.id);

      // Mark items as paid out
      await prisma.orderItem.updateMany({
        where: { id: { in: itemIdsToMark } },
        data: { paidOutAt },
      });

      // Fetch updated items for response
      const updatedItems = await prisma.orderItem.findMany({
        where: { id: { in: itemIdsToMark } },
        select: { id: true, paidOutAt: true, status: true },
      });

      // Backward compatibility note: Previously we returned `order.paidOutAt` here
      // for older tests. This has been removed in favor of item-level `paidOutAt`.
      // Tests should inspect `items` for paidOutAt values instead of relying on
      // a deprecated `Order.paidOutAt` field.
      return reply.send({ ok: true, items: updatedItems });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err, orderId }, "e2e_mark_paid_out_failed");
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_mark_paid_out_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Get Order Item Settlement Details
  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: This is E2E-only because:
  // 1. It exposes internal settlement tracking data not meant for end users
  // 2. Allows E2E tests to verify item-level settlement tracking without
  //    needing direct database access
  // 3. Production code accesses this data through proper use cases
  app.get("/e2e/orders/:orderId/settlement-details", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      // Get order with items
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            select: {
              id: true,
              kind: true,
              qty: true,
              amountCents: true,
              paidOutAt: true,
              refundedAt: true,
              transferredAt: true,
              status: true,
            },
          },
        },
      });

      if (!order) {
        return reply.status(404).send({ ok: false, error: "order_not_found" });
      }

      // Get OrderItemSettlementLine records for this order's items
      const itemIds = order.items.map((i) => i.id);
      const orderItemSettlementLines =
        await prisma.orderItemSettlementLine.findMany({
          where: { orderItemId: { in: itemIds } },
          include: {
            settlementLine: {
              include: {
                settlement: {
                  select: {
                    id: true,
                    status: true,
                    amountCents: true,
                    stripeTransferId: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                },
              },
            },
          },
        });

      // Get settlements via order splits
      const orderSplits = await prisma.orderSplit.findMany({
        where: { orderId },
        include: {
          settlementLines: {
            include: {
              settlement: {
                select: {
                  id: true,
                  status: true,
                  amountCents: true,
                  stripeTransferId: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });

      return reply.send({
        ok: true,
        order: {
          id: order.id,
          status: order.status,
        },
        items: order.items,
        orderItemSettlementLines: orderItemSettlementLines.map((oisl) => ({
          id: oisl.id,
          orderItemId: oisl.orderItemId,
          settlementLineId: oisl.settlementLineId,
          amountCents: oisl.amountCents,
          settlement: oisl.settlementLine.settlement,
        })),
        orderSplits: orderSplits.map((split) => ({
          id: split.id,
          payeeId: split.payeeId,
          amountCents: split.amountCents,
          settlementLines: split.settlementLines.map(
            (sl: {
              id: string;
              amountCents: number;
              settlement: {
                id: string;
                status: string;
                amountCents: number;
                stripeTransferId: string | null;
              };
            }) => ({
              id: sl.id,
              amountCents: sl.amountCents,
              settlement: sl.settlement,
            }),
          ),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err, orderId }, "e2e_get_settlement_details_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_get_settlement_details_failed",
        message,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E seed route for cart recovery testing.
  // Creates an event, user, and a PENDING order with seat holds so we can test:
  //   1. getActiveCartHolds returns the abandoned cart
  //   2. releaseCartHold correctly cancels the order and frees seats
  //   3. Cart recovery banner appears for returning users
  //   4. Resume checkout flow pre-populates correctly
  //
  // This is E2E-only because it directly manipulates the DB to create test fixtures.
  // ─────────────────────────────────────────────────────────────────────────
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
      typeof body.holdTtlSeconds === "number" ? body.holdTtlSeconds : 900; // 15 min default
    const createPendingOrder = body.createPendingOrder !== false; // Default true
    const now = new Date();

    try {
      // Create human (buyer) - identity data is on AuthUser
      const human = await prisma.human.create({
        data: {
          status: "ACTIVE",
          roles: ["USER"],
        },
      });

      // Create auth user for Better Auth login (email/verified lives here)
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

      // Create auth account with hashed password for login
      // We use the same pattern as Better Auth for password hashing
      const { createHash, randomBytes } = await import("node:crypto");
      // Better Auth uses bcrypt-style hash, but for simplicity we'll just let users sign up via UI
      // The test will sign up the user after seeding

      const org = await prisma.organization.create({
        data: {
          name: "E2E Cart Recovery Org",
          slug: `e2e-cart-recovery-org-${Date.now()}`,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      // Fee policy + agreement
      const feePolicy = await seedFeePolicy({
        createdBy: human.id,
        now,
        notes: "e2e-cart-recovery",
      });

      const agreement = await prisma.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          version: 1,
          isDefault: true,
          settlementCurrency: currency,
          status: "ACTIVE",
          feePolicyId: feePolicy.id,
        },
      });

      // Payee for the org
      const payee = await prisma.payee.create({
        data: {
          subjectType: "ORGANIZATION",
          subjectId: org.id,
          status: "ACTIVE",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: currency,
          requirements: {},
        },
      });

      await prisma.payoutTermsLine.create({
        data: {
          payoutTermsId: agreement.id,
          payeeId: payee.id,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      });

      const startsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 1 week from now
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
          payoutTermsId: agreement.id,
          slug: `e2e-cart-recovery-event-${Date.now()}`,
        },
      });

      // Create ticket types (multiple so we can test recovery with different selections)
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

      let orderId: string | null = null;
      let holdExpiresAt: Date | null = null;

      if (createPendingOrder) {
        // Create a PENDING order with seat holds to simulate an abandoned cart
        holdExpiresAt = new Date(now.getTime() + holdTtlSeconds * 1000);

        const order = await prisma.order.create({
          data: {
            eventId: event.id,
            buyerHumanId: human.id,
            status: "PENDING",
            currency,
            amountGrossCents: priceCents * 2, // 2 tickets
            feesPlatformCents: 0,
            feePolicySnapshot: {},
          },
        });

        // Create order items — one per ticket (qty=1) for granular refund tracking
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
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_cart_recovery_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Seed Gated Event (Password or Application)
  // ─────────────────────────────────────────────────────────────────────────
  // Creates a gated event for E2E testing of unlock flows.
  // Supports both PASSWORD and APPLICATION gate types.
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/seed/gated-event", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      gateType?: "PASSWORD" | "APPLICATION";
      password?: string; // For PASSWORD gate
      email?: string;
      userPassword?: string;
      priceCents?: number;
      applicationQuestions?: Array<{
        prompt: string;
        type?: "SHORT_TEXT" | "LONG_TEXT";
      }>;
    };

    const gateType = body.gateType ?? "PASSWORD";
    const eventPassword = body.password ?? "test-password-123";
    const email = body.email ?? `e2e-gated-${Date.now()}@example.com`;
    const userPassword = body.userPassword ?? "Test-Account-2026!";
    const priceCents =
      typeof body.priceCents === "number" ? body.priceCents : 2500;
    const now = new Date();
    const startsAt = new Date(now.getTime() + 86_400_000); // Tomorrow

    try {
      // Create human
      const human = await prisma.human.create({
        data: {
          status: "ACTIVE",
          roles: ["USER"],
        },
      });

      // Create auth user
      await prisma.authUser.create({
        data: {
          id: human.id,
          humanId: human.id,
          email,
          emailVerified: true,
          name: "E2E Gated Test User",
          createdAt: now,
          updatedAt: now,
        },
      });

      // Create org
      const org = await prisma.organization.create({
        data: {
          name: "E2E Gated Org",
          slug: `e2e-gated-org-${Date.now()}`,
          status: "ACTIVE",
        },
      });

      // Link human to org
      await prisma.orgMember.create({
        data: {
          orgId: org.id,
          humanId: human.id,
          role: "OWNER",
        },
      });

      // Create fee policy first
      const feePolicy = await seedFeePolicy({
        createdBy: human.id,
        now,
        notes: "e2e-gated-event",
      });

      // Create payout terms
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

      // Create payee
      const payee = await prisma.payee.create({
        data: {
          subjectType: "ORGANIZATION",
          subjectId: org.id,
          status: "ACTIVE",
          stripeAccountId:
            env.E2E_STRIPE_ACCOUNT_ID ?? `acct_e2e_${Date.now()}`,
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
        },
      });

      await prisma.payoutTermsLine.create({
        data: {
          payoutTermsId: agreement.id,
          payeeId: payee.id,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      });

      // Create event
      const slug = `e2e-gated-${gateType.toLowerCase()}-${Date.now()}`;
      const event = await prisma.event.create({
        data: {
          orgId: org.id,
          title: `E2E ${gateType} Gated Event`,
          slug,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000), // 3 hours
          status: "PUBLISHED",
          publishedAt: now,
          visibility: "PUBLIC",
          gateType,
          passwordHash:
            gateType === "PASSWORD" ? hashEventPassword(eventPassword) : null,
          passwordUpdatedAt: gateType === "PASSWORD" ? now : null,
          regionCode: "ca-sf",
          payoutTermsId: agreement.id,
        },
      });

      // Create ticket type
      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "General Admission",
          priceCents,
          capacity: 100,
          status: "ACTIVE",
        },
      });

      // If APPLICATION gate, create application form and questions
      let applicationFormId: string | null = null;
      const applicationQuestionIds: string[] = [];

      if (gateType === "APPLICATION") {
        const questions = body.applicationQuestions ?? [
          {
            prompt: "Why do you want to attend this event?",
            type: "LONG_TEXT" as const,
          },
          { prompt: "How did you hear about us?", type: "SHORT_TEXT" as const },
        ];

        const form = await prisma.eventApplicationForm.create({
          data: {
            eventId: event.id,
          },
        });
        applicationFormId = form.id;

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]!;
          const question = await prisma.eventApplicationQuestion.create({
            data: {
              formId: form.id,
              label: q.prompt,
              type: q.type ?? "SHORT_TEXT",
              isRequired: true,
              order: i,
            },
          });
          applicationQuestionIds.push(question.id);
        }
      }

      return reply.send({
        ok: true,
        seed: {
          email,
          password: userPassword,
          humanId: human.id,
          orgId: org.id,
          eventId: event.id,
          eventSlug: event.slug,
          gateType,
          eventPassword: gateType === "PASSWORD" ? eventPassword : null,
          ticketTypeId: ticketType.id,
          priceCents,
          applicationFormId,
          applicationQuestionIds,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, "e2e_seed_gated_event_failed");
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_gated_event_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Create Magic Link for a Gated Event
  // ─────────────────────────────────────────────────────────────────────────
  // Creates a magic link for an existing gated event. The event must already
  // exist (use /e2e/seed/gated-event first).
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/seed/magic-link", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      eventId: string;
      creatorHumanId: string;
      targetHumanId?: string;
      expiresInDays?: number;
      metadata?: Record<string, unknown>;
    };

    if (!body.eventId || !body.creatorHumanId) {
      return reply.status(400).send({
        ok: false,
        error: "missing_required_fields",
        message: "eventId and creatorHumanId are required",
      });
    }

    const now = new Date();
    const expiresInDays = body.expiresInDays ?? 7;
    const expiresAt = new Date(
      now.getTime() + expiresInDays * 24 * 60 * 60 * 1000,
    );

    try {
      // Generate a magic link token (same format as use case)
      const token = `ml_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

      const magicLink = await prisma.eventMagicLink.create({
        data: {
          eventId: body.eventId,
          token,
          targetHumanId: body.targetHumanId ?? null,
          createdByHumanId: body.creatorHumanId,
          expiresAt,
          metadata: (body.metadata ?? {}) as object,
        },
      });

      return reply.send({
        ok: true,
        magicLink: {
          id: magicLink.id,
          token: magicLink.token,
          eventId: magicLink.eventId,
          targetHumanId: magicLink.targetHumanId,
          expiresAt: magicLink.expiresAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, "e2e_seed_magic_link_failed");
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_magic_link_failed", message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Add Test Funds to Stripe Balance
  // ─────────────────────────────────────────────────────────────────────────
  // This endpoint adds funds to your Stripe test account balance so that
  // Connect transfers can succeed. Required because tok_bypassPending charges
  // don't always make funds available for transfers immediately.
  //
  // E2E-only: Creates a charge using Stripe's recommended 4000000000000077 card.
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/stripe/add-test-funds", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    if (!env.STRIPE_SECRET_KEY) {
      return reply.status(500).send({
        ok: false,
        error: "missing_stripe_secret",
        message: "STRIPE_SECRET_KEY is required to add test funds.",
      });
    }

    const body = (request.body ?? {}) as {
      amountCents?: number;
      currency?: string;
    };

    const amountCents =
      typeof body.amountCents === "number" ? body.amountCents : 100_000; // Default $1000
    const currency = body.currency ?? "usd";

    try {
      // Import Stripe dynamically to avoid issues if not configured
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: "2025-08-27.basil",
      });

      // Create a charge using the special test card that bypasses pending balance
      // Card 4000000000000077 is Stripe's recommended card for adding test funds
      const charge = await stripe.charges.create({
        amount: amountCents,
        currency,
        source: "tok_bypassPending",
        description: "E2E test: Add funds for Connect transfers",
      });

      // Fetch the updated balance
      const balance = await stripe.balance.retrieve();
      const availableUsd = balance.available.find(
        (b) => b.currency === currency,
      );

      app.log.info(
        {
          chargeId: charge.id,
          amountCents,
          availableBalance: availableUsd?.amount,
        },
        "e2e_stripe_test_funds_added",
      );

      return reply.send({
        ok: true,
        chargeId: charge.id,
        amountCents,
        currency,
        availableBalance: availableUsd?.amount ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error(
        { err, amountCents, currency },
        "e2e_stripe_add_test_funds_failed",
      );
      return reply.status(500).send({
        ok: false,
        error: "e2e_stripe_add_test_funds_failed",
        message,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Get Stripe Balance
  // ─────────────────────────────────────────────────────────────────────────
  // Returns the current Stripe test account balance. Useful for debugging
  // "insufficient funds" errors before running transfer tests.
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/e2e/stripe/balance", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    if (!env.STRIPE_SECRET_KEY) {
      return reply.status(500).send({
        ok: false,
        error: "missing_stripe_secret",
        message: "STRIPE_SECRET_KEY is required to check balance.",
      });
    }

    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: "2025-08-27.basil",
      });

      const balance = await stripe.balance.retrieve();

      return reply.send({
        ok: true,
        available: balance.available,
        pending: balance.pending,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_stripe_balance_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_stripe_balance_failed",
        message,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Seed Admin Tables
  // ─────────────────────────────────────────────────────────────────────────
  // Creates a fully wired org (with membership), events (PUBLISHED + DRAFT),
  // places (with ownership, mixed verification statuses), and orders so the
  // admin orders/events/places tables can be exercised end-to-end.
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/seed/admin-tables", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
    };

    const email = body.email ?? "playwright-setup@example.com";
    const now = new Date();

    try {
      // ── Resolve the authenticated human ────────────────────────────
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      // ── Create Org + Membership ────────────────────────────────────
      const orgSlug = `e2e-admin-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Admin Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: {
          orgId: org.id,
          humanId,
          role: "OWNER",
        },
      });

      // ── Create Places (with ownership) ─────────────────────────────
      const placeActive = await prisma.place.create({
        data: {
          name: "E2E Main Venue",
          slug: `e2e-main-venue-${Date.now()}`,
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
          slug: `e2e-old-hall-${Date.now()}`,
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

      // Ownership links so the admin can manage these places
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
          },
        ],
      });

      // ── Fee policy + payout terms (needed for orders) ──────────────
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

      // ── Create Events ──────────────────────────────────────────────
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
          payoutTermsId: agreement.id,
          slug: `e2e-published-concert-${Date.now()}`,
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
          payoutTermsId: agreement.id,
          slug: `e2e-draft-workshop-${Date.now()}`,
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
          payoutTermsId: agreement.id,
          slug: `e2e-app-gated-showcase-${Date.now()}`,
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

      // ── Create a buyer + orders ────────────────────────────────────
      const buyer = await prisma.human.create({
        data: {
          status: "ACTIVE",
          roles: ["USER"],
        },
      });

      await prisma.authUser.create({
        data: {
          id: buyer.id,
          humanId: buyer.id,
          email: `e2e-buyer-${Date.now()}@example.com`,
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
          stripePaymentIntentId: `pi_e2e_admin_${Date.now()}`,
        },
      });

      await prisma.orderItem.create({
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

      // ── PART_REFUNDED order (2 items: 1 refunded, 1 active) ────────
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
          stripePaymentIntentId: `pi_e2e_admin_pr_${Date.now()}`,
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

      // ── REFUNDED order (all items refunded) ────────────────────────
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
          stripePaymentIntentId: `pi_e2e_admin_ref_${Date.now()}`,
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
          stripePaymentIntentId: `pi_e2e_admin_disp_${Date.now()}`,
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
          placeActiveId: placeActive.id,
          placeArchivedId: placeArchived.id,
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

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Seed Platform Tables
  // ─────────────────────────────────────────────────────────────────────────
  // Creates seed data for the /platform/** staff-only pages.
  // Promotes the test user to ADMIN role, creates an org with events, orders,
  // tickets, and a place with a PENDING verification request + documents so
  // the platform orders/tickets/places pages can be exercised end-to-end.
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/seed/platform-tables", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
    };

    const email = body.email ?? "playwright-setup@example.com";
    const now = new Date();

    try {
      // ── Resolve the authenticated human ────────────────────────────
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      // ── Promote to platform staff (ADMIN role) ─────────────────────
      await prisma.human.update({
        where: { id: humanId },
        data: { roles: ["USER", "ADMIN"] },
      });

      // ── Create Org + Membership ────────────────────────────────────
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
        data: {
          orgId: org.id,
          humanId,
          role: "OWNER",
        },
      });

      // ── Create Places ──────────────────────────────────────────────
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

      // Ownership links
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

      // ── Verification request + documents (PENDING place) ───────────
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

      // ── Fee policy + payout terms (needed for orders) ──────────────
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

      // ── Create Event ───────────────────────────────────────────────
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

      // ── Create a buyer ─────────────────────────────────────────────
      const buyer = await prisma.human.create({
        data: {
          status: "ACTIVE",
          roles: ["USER"],
        },
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

      // ── Create orders ──────────────────────────────────────────────
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

      // ── Create tickets (for the succeeded order) ───────────────────
      const ticket = await prisma.ticket.create({
        data: {
          eventId: event.id,
          ticketTypeId: ticketType.id,
          orderId: orderSucceeded.id,
          orderItemId: succeededOrderItem.id,
          ownerHumanId: buyer.id,
          code: `TKT-E2E-${Date.now()}`,
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

  // ─────────────────────────────────────────────────────────────────────────
  // E2E: Seed Event Builder
  // ─────────────────────────────────────────────────────────────────────────
  // Creates an org + membership + a DRAFT event with one ticket type so the
  // EventBuilder edit-mode UI can be exercised end-to-end (ticket CRUD, gate
  // settings, publish flow, etc.).
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/e2e/seed/event-builder", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      currency?: string;
      stripeAccountId?: string;
    };
    const email = body.email ?? "playwright-setup@example.com";
    const currency = body.currency ?? "usd";
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
        data: {
          orgId: org.id,
          humanId,
          role: "OWNER",
        },
      });

      // ── Fee policy + payout terms ──────────────────────────────────
      const feePolicy = await seedFeePolicy({
        createdBy: humanId,
        now,
        notes: "e2e-event-builder",
      });

      // ── Payee (Stripe Connect) ─────────────────────────────────────
      const stripeAccountId =
        body.stripeAccountId ??
        env.E2E_STRIPE_ACCOUNT_ID ??
        `acct_e2e_builder_${Date.now()}`;

      const payee = await prisma.payee.create({
        data: {
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

      const agreement = await prisma.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          version: 1,
          isDefault: true,
          settlementCurrency: currency,
          status: "ACTIVE",
          feePolicyId: feePolicy.id,
        },
      });

      await prisma.payoutTermsLine.create({
        data: {
          payoutTermsId: agreement.id,
          payeeId: payee.id,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      });

      // ── Draft Event ────────────────────────────────────────────────
      const event = await prisma.event.create({
        data: {
          title: "E2E Builder Event",
          orgId: org.id,
          humanId: null,
          startsAt: new Date(now.getTime() + 7 * 86_400_000),
          endsAt: new Date(now.getTime() + 7 * 86_400_000 + 3_600_000),
          status: "DRAFT",
          visibility: "PUBLIC",
          gateType: "NONE",
          currency,
          payoutTermsId: agreement.id,
          slug: `e2e-builder-event-${Date.now()}`,
          addressText: "123 Test St, E2E City, TS 00001",
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
          payeeId: payee.id,
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

  // ═══════════════════════════════════════════════════════════════════════
  // SEED: Venue Calendar
  // ═══════════════════════════════════════════════════════════════════════
  // Creates an org, a place, and several events (including a series pair)
  // so the calendar page has data in every view mode.
  // ═══════════════════════════════════════════════════════════════════════

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
        data: {
          orgId: org.id,
          humanId,
          role: "OWNER",
        },
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

      // ── Fee policy + payout terms (shared by all events) ──────────
      const feePolicy = await seedFeePolicy({
        createdBy: humanId,
        now,
        notes: "e2e-venue-calendar",
      });

      // Helper to build payout terms for an event
      async function makePayoutTerms(_eventId?: string) {
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
      // Event A: today, 2-hour window (will show in "today" highlight)
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
      const todayTerms = await makePayoutTerms(eventToday.id);
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
      const tmrTerms = await makePayoutTerms(eventTomorrow.id);
      await prisma.event.update({
        where: { id: eventTomorrow.id },
        data: { payoutTermsId: tmrTerms.id },
      });

      // Event C: today + 3 days, published (gives week view variety)
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
      const futTerms = await makePayoutTerms(eventFuture.id);
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
      const s1Terms = await makePayoutTerms(seriesEvent1.id);
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
      const s2Terms = await makePayoutTerms(seriesEvent2.id);
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

  // ═══════════════════════════════════════════════════════════════════════
  // SEED: Event Series Builder
  // ═══════════════════════════════════════════════════════════════════════
  // Creates an org with membership and returns the slug so the E2E test
  // can navigate to /admin/{slug}/events/new and exercise the recurrence
  // builder UI in create mode.
  // ═══════════════════════════════════════════════════════════════════════

  app.post("/e2e/seed/event-series", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    const email = body.email ?? "playwright-setup@example.com";

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
      const orgSlug = `e2e-series-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Series Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: {
          orgId: org.id,
          humanId,
          role: "OWNER",
        },
      });

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_event_series_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_event_series_failed",
        message,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SEED: Place Layout Designer
  // ═══════════════════════════════════════════════════════════════════════
  // Creates an org with a place and a seeded layout so the layout designer
  // page can be tested end-to-end.
  // ═══════════════════════════════════════════════════════════════════════

  app.post("/e2e/seed/place-layout-designer", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    const email = body.email ?? "playwright-setup@example.com";

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
      const orgSlug = `e2e-layout-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Layout Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: {
          orgId: org.id,
          humanId,
          role: "OWNER",
        },
      });

      // ── Place ──────────────────────────────────────────────────────
      const placeSlug = `e2e-venue-${Date.now()}`;
      const place = await prisma.place.create({
        data: {
          name: "E2E Test Venue",
          slug: placeSlug,
          address: "100 E2E Blvd",
          city: "Testville",
          region: "TX",
          country: "US",
          postcode: "00001",
          lat: 30.27,
          lng: -97.74,
          capacity: 500,
          verification: "VERIFIED",
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

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          placeId: place.id,
          placeSlug,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_place_layout_designer_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_place_layout_designer_failed",
        message,
      });
    }
  });
};

function computeExpectedAmount(order: {
  amountGrossCents: number;
  feesPlatformCents: number;
  items: Array<{ amountCents: number; meta: unknown }>;
}): number {
  let hasBuyerTotals = false;
  let total = 0;

  for (const item of order.items) {
    const buyerTotal = extractNumber(
      (item.meta as Record<string, unknown> | null)?.buyerTotalCents,
    );
    if (buyerTotal !== null) {
      total += buyerTotal;
      hasBuyerTotals = true;
    } else {
      total += item.amountCents;
    }
  }

  if (!hasBuyerTotals) {
    total = order.amountGrossCents + order.feesPlatformCents;
  }

  return total;
}

function extractNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

async function resolveHumanId(input: {
  humanId?: string;
  email?: string;
}): Promise<string | null> {
  if (input.humanId && typeof input.humanId === "string") return input.humanId;
  if (!input.email || typeof input.email !== "string") return null;

  // Look up via AuthUser since email is now on that table
  const authUser = await prisma.authUser.findUnique({
    where: { email: input.email },
  });
  if (authUser?.humanId) return authUser.humanId;
  if (authUser) {
    // AuthUser exists but not linked to a Human - create one
    const created = await prisma.human.create({
      data: {
        id: randomUUID(),
        status: "ACTIVE",
        roles: ["USER"],
      },
    });

    await prisma.authUser.update({
      where: { id: authUser.id },
      data: { humanId: created.id },
    });

    return created.id;
  }

  return null;
}

export default fp(plugin as unknown as never) as unknown as never;
