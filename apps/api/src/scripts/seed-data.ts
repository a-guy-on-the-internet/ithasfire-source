/**
 * seed-data.ts — Thin orchestrator for dev seeding.
 *
 * All reusable logic lives in `./seed/*` modules so both this script and
 * the E2E seed endpoints (`routes/e2e.ts`) can share the same helpers.
 *
 * Run via: `pnpm -F api seed:dev`
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ── Apple App Store reviewer credentials ──────────────────────────────────
// Deterministic password the Apple reviewer uses to sign into the scanner
// during App Store review. Override via env if you need to rotate.
const APPLE_REVIEWER_PASSWORD =
  process.env.APPLE_REVIEWER_PASSWORD ?? "IthasFireReview!2026";
const APPLE_REVIEWER_EMAIL = "apple-reviewer@ithasfire.com";
const APPLE_REVIEW_ORG_SLUG = "apple-review";
const APPLE_REVIEW_EVENT_SLUG = "test-event-apple";
const APPLE_REVIEW_TICKET_CODE = "APPLE-REVIEW-001";
const APPLE_REVIEW_IDS = {
  org: "00000000-0000-4000-8000-0000000a9001",
  reviewerHuman: "00000000-0000-4000-8000-0000000a9002",
  buyerHuman: "00000000-0000-4000-8000-0000000a9003",
  event: "00000000-0000-4000-8000-0000000a9004",
  ticketType: "00000000-0000-4000-8000-0000000a9005",
  ticket: "00000000-0000-4000-8000-0000000a9006",
} as const;

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure repo-root .env.local is loaded when running this script directly
// (pnpm -F api seed:dev). If the current DATABASE_URL looks like the placeholder
// example (USER:PASSWORD@HOST), overwrite it with our repo-root `.env.local`.
const placeholderMatch = (process.env.DATABASE_URL || "").match(
  /USER:PASSWORD|@HOST|postgres:\/\/USER/,
);
if (!process.env.DATABASE_URL || placeholderMatch) {
  dotenvConfig({
    path: path.resolve(__dirname, "../../../../.env.local"),
    override: true,
  });
  console.log("[seed] Using repo .env.local for DATABASE_URL");
} else {
  console.log("[seed] Using existing DATABASE_URL from environment");
}

// Also load apps/api/.env.local for keys that live there (e.g. STRIPE_SECRET_KEY).
// `override: false` means the repo-root file and existing env vars take precedence;
// this only fills in values that are still unset.
dotenvConfig({
  path: path.resolve(__dirname, "../../.env.local"),
  override: false,
});

const localDbUrl =
  "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
const allowRemoteDb = process.env.THC_SEED_ALLOW_REMOTE_DB === "true";
const readSearchWeight = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const searchWeightsFromEnv = () => ({
  fulltext: readSearchWeight("SEARCH_W_FULLTEXT", 1.0),
  prefix: readSearchWeight("SEARCH_W_PREFIX", 0.7),
  fuzzy: readSearchWeight("SEARCH_W_FUZZY", 0.5),
  popularity: readSearchWeight("SEARCH_W_POPULARITY", 0.05),
  geo: readSearchWeight("SEARCH_W_GEO", 1.0),
});
const resolveDbUrl = () => {
  if (!process.env.DATABASE_URL || placeholderMatch) {
    return localDbUrl;
  }
  try {
    const url = new URL(process.env.DATABASE_URL);
    const isLocalHost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocalHost && !allowRemoteDb) {
      return localDbUrl;
    }
  } catch {
    return localDbUrl;
  }
  return process.env.DATABASE_URL;
};

process.env.DATABASE_URL = resolveDbUrl();
if (process.env.DATABASE_URL === localDbUrl) {
  console.log("[seed] Using local postgres DATABASE_URL");
}

// Ensure Meilisearch host defaults match docker-compose.search.yml
const meiliPort = process.env.MEILISEARCH_PORT?.trim() || "7700";
if (!process.env.MEILISEARCH_HOST) {
  process.env.MEILISEARCH_HOST = `http://localhost:${meiliPort}`;
}
const meiliMasterKey =
  process.env.MEILISEARCH_MASTER_KEY ||
  process.env.MEILI_MASTER_KEY ||
  "dev-master-key";
if (
  !process.env.MEILISEARCH_API_KEY ||
  process.env.MEILISEARCH_API_KEY !== meiliMasterKey
) {
  process.env.MEILISEARCH_API_KEY = meiliMasterKey;
}

// ── Imports (after env is settled) ───────────────────────────────────────
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import {
  MultiIndexMeilisearchAdapter,
  MultiIndexPostgresAdapter,
} from "@th/adapters/search";
import { buildSearchIndex } from "@th/core/use-cases/search/build-search-index";
import { env } from "../lib/env";
import { createCreditsFromOrder } from "@th/core/use-cases/settlements/create-credits-from-order";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "@th/core/lib/payments";
import { createSystemClock } from "@th/adapters/infra/clock";

import Stripe from "stripe";
import { hashPassword } from "better-auth/crypto";
import {
  DEMO_IDS,
  DEV_LOGIN_USER,
  DEV_LOGIN_MXN_USER,
  buildEventFixtures,
  HUMAN_EVENT_FIXTURES,
  ADDITIONAL_HUMANS,
  ADDITIONAL_ORGS,
  pMap,
  wipeSeedData,
  ensureOrg,
  ensureDemoHuman,
  ensureDevLoginUser,
  ensureDevLoginMxnUser,
  ensureAdditionalHumans,
  ensurePerformerProfiles,
  ensurePerformerBookingDefaults,
  ensureAdditionalOrgs,
  ensurePayee,
  ensureAgreement,
  ensureDefaultAgreements,
  ensureFeePolicy,
  ensureCategories,
  ensureGenreTags,
  ensurePlaces,
  backfillEventVenueDefaults,
  ensurePlaceLayouts,
  linkEventsToPlaceLayouts,
  ensureEventSeatSections,
  validatePlaceLayouts,
  validateLayoutRenderability,
  upsertEventWithTickets,
  upsertHumanEventWithTickets,
  ensureEventImage,
  seedDemoOrders,
  seedDevLoginOrders,
  seedHumanEventOrders,
  seedDevLoginExtras,
  ensurePlatformWaivers,
  seedWaiverClauses,
  ensureDemoPromos,
  ensureFeaturedItems,
  FEATURED_EVENT_SLUGS,
  seedVolunteering,
  ensureVolunteerPacks,
  ensureTicketPacks,
  ensureApplicationFormTemplates,
  seedDemoCashSales,
  seedDemoPosOrders,
  seedAttendeeReviewShow,
  seedAllEntityPages,
  seedEntityFollows,
  seedCommunityEditSuggestions,
} from "./seed/index.js";

const prisma = getPrisma();

async function main() {
  const t0 = performance.now();

  // ── Stripe (for creating real Connect accounts + PaymentIntents) ───────
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY || undefined;
  const stripe = stripeSecretKey
    ? new Stripe(stripeSecretKey, { apiVersion: "2025-08-27.basil" as any })
    : undefined;

  // ── Wipe ───────────────────────────────────────────────────────────────
  await wipeSeedData(prisma);

  // ── Fixtures ───────────────────────────────────────────────────────────
  const fixtures = buildEventFixtures();
  const uniqueRegions = Array.from(new Set(fixtures.map((f) => f.regionCode)));
  console.log(
    `Seeding demo events: ${fixtures.length} fixtures across ${uniqueRegions.length} regions`,
  );
  console.log(`Regions: ${uniqueRegions.join(", ")}`);

  // ── Identity ───────────────────────────────────────────────────────────
  const org = await ensureOrg(prisma);

  const [payee, categoryMap, , devLogin] = await Promise.all([
    ensurePayee(prisma, org.id, DEMO_IDS.payee, stripe),
    ensureCategories(prisma),
    ensureDemoHuman(prisma),
    ensureDevLoginUser(prisma),
    ensureFeePolicy(prisma),
  ]);

  const agreement = await ensureAgreement(
    prisma,
    org.id,
    payee.id,
    DEMO_IDS.agreement,
  );
  await ensureDefaultAgreements(prisma, org.id, payee.id, agreement.id);
  await prisma.organization.update({
    where: { id: org.id },
    data: {
      chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: new Date(),
      chargebackTermsAcceptedByHumanId: DEMO_IDS.human,
    },
  });

  // Genre tag library (replaces the legacy EventType sub-category taxonomy).
  await ensureGenreTags(prisma);

  // Waiver clause library (platform-maintained risk paragraphs) — must run
  // BEFORE ensurePlatformWaivers: the platform templates are ASSEMBLED from
  // these clauses.
  await seedWaiverClauses(prisma);

  // Platform waiver templates (orgId = null, available to all orgs)
  await ensurePlatformWaivers(prisma);

  // Demo promo codes (org-scoped on the primary demo org)
  await ensureDemoPromos(prisma);

  // Additional humans, orgs, and places
  console.log("Seeding additional humans, orgs, and places...");
  const additionalHumans = await ensureAdditionalHumans(prisma);
  console.log(`  Created ${additionalHumans.length} additional humans`);

  // Opt the seeded tier-demo humans (Alex Rivera, Diego Alvarez) into performer
  // mode so their seeded performer/musician pages resolve to "performer" on
  // editor load. Must run AFTER the humans exist and BEFORE any performer-state
  // read (entity-page seeding / runtime editor load).
  const performerProfiles = await ensurePerformerProfiles(prisma);
  console.log(`  Enabled ${performerProfiles} performer profiles`);

  // Booking-request prefill data (PerformerBookingDefaults + Human
  // jobs/genreTags) for the performer-enabled humans, so the dev admin and
  // the seeded performers exercise the fully-populated prefill path.
  const bookingDefaults = await ensurePerformerBookingDefaults(prisma);
  console.log(`  Seeded ${bookingDefaults} performer booking defaults`);

  const [additionalOrgs, places] = await Promise.all([
    ensureAdditionalOrgs(prisma),
    ensurePlaces(prisma),
  ]);
  await Promise.all(
    ADDITIONAL_ORGS.map((fixture) =>
      prisma.organization.update({
        where: { id: fixture.id },
        data: {
          chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
          chargebackTermsAcceptedAt: new Date(),
          chargebackTermsAcceptedByHumanId: fixture.ownerHumanId,
        },
      }),
    ),
  );
  console.log(
    `  Created ${additionalOrgs.length} additional orgs with members`,
  );
  console.log(`  Created ${places.length} places with ownership`);

  // Place layouts (must run after places)
  const placeLayouts = await ensurePlaceLayouts(prisma);
  console.log(`  Created ${placeLayouts.length} place layouts`);
  for (const pl of placeLayouts) {
    console.log(
      `    ${pl.placeId.slice(-4)}: ${pl.seatCount} seats, ${pl.sectionCount} sections`,
    );
  }

  // Payees & agreements for additional orgs
  const payee2 = await ensurePayee(
    prisma,
    DEMO_IDS.org2,
    DEMO_IDS.payee2,
    stripe,
  );
  const agreement2 = await ensureAgreement(
    prisma,
    DEMO_IDS.org2,
    payee2.id,
    DEMO_IDS.agreement2,
  );
  await ensureDefaultAgreements(
    prisma,
    DEMO_IDS.org2,
    payee2.id,
    agreement2.id,
  );

  const payee3 = await ensurePayee(
    prisma,
    DEMO_IDS.org3,
    DEMO_IDS.payee3,
    stripe,
  );
  const agreement3 = await ensureAgreement(
    prisma,
    DEMO_IDS.org3,
    payee3.id,
    DEMO_IDS.agreement3,
  );
  await ensureDefaultAgreements(
    prisma,
    DEMO_IDS.org3,
    payee3.id,
    agreement3.id,
  );

  const payee4 = await ensurePayee(
    prisma,
    DEMO_IDS.org4,
    DEMO_IDS.payee4,
    stripe,
  );
  const agreement4 = await ensureAgreement(
    prisma,
    DEMO_IDS.org4,
    payee4.id,
    DEMO_IDS.agreement4,
  );
  await ensureDefaultAgreements(
    prisma,
    DEMO_IDS.org4,
    payee4.id,
    agreement4.id,
  );

  // ── Place-level default payout terms (demonstrates place override cascade) ──
  // SOMA Warehouse (place6, owned by org3) gets its own primary default.
  await prisma.place.update({
    where: { id: DEMO_IDS.place6 },
    data: { defaultPrimaryPayoutTermsId: agreement3.id },
  });
  // The Paramount Theatre (place1, owned by org) gets its own primary default.
  await prisma.place.update({
    where: { id: DEMO_IDS.place1 },
    data: { defaultPrimaryPayoutTermsId: agreement.id },
  });
  console.log("  Wired place-level default payout terms for place1 + place6");

  // Map each org to its payee + agreement so upsertEventWithTickets can look it up.
  const orgPayeeMap: Record<string, { payeeId: string; agreementId: string }> =
    {
      [DEMO_IDS.org]: { payeeId: payee.id, agreementId: agreement.id },
      [DEMO_IDS.org2]: { payeeId: payee2.id, agreementId: agreement2.id },
      [DEMO_IDS.org3]: { payeeId: payee3.id, agreementId: agreement3.id },
      [DEMO_IDS.org4]: { payeeId: payee4.id, agreementId: agreement4.id },
    };

  // ── MXN dev-login user + org (Mexican peso test account) ───────────────
  console.log("Seeding MXN dev-login user and org...");
  const devLoginMxn = await ensureDevLoginMxnUser(prisma);

  const mxnOrg = await prisma.organization.upsert({
    where: { id: DEMO_IDS.orgMxn },
    update: {
      name: "Mexico City Events",
      slug: "mexico-city-events",
      status: "ACTIVE",
      chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: new Date(),
      chargebackTermsAcceptedByHumanId: DEMO_IDS.devUserMxn,
    },
    create: {
      id: DEMO_IDS.orgMxn,
      name: "Mexico City Events",
      slug: "mexico-city-events",
      status: "ACTIVE",
      defaultLocale: "es",
      chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: new Date(),
      chargebackTermsAcceptedByHumanId: DEMO_IDS.devUserMxn,
    },
  });

  await prisma.orgMember.upsert({
    where: {
      orgId_humanId: { orgId: mxnOrg.id, humanId: DEMO_IDS.devUserMxn },
    },
    update: { role: "OWNER" },
    create: { orgId: mxnOrg.id, humanId: DEMO_IDS.devUserMxn, role: "OWNER" },
  });

  // Also give the primary dev-login user ADMIN access on the MXN org.
  await prisma.orgMember.upsert({
    where: { orgId_humanId: { orgId: mxnOrg.id, humanId: DEMO_IDS.devUser } },
    update: { role: "ADMIN" },
    create: { orgId: mxnOrg.id, humanId: DEMO_IDS.devUser, role: "ADMIN" },
  });

  const mxnStripeAccountId = await (async () => {
    const existing = await prisma.payee.findUnique({
      where: { id: DEMO_IDS.payeeMxn },
      select: { stripeAccountId: true },
    });
    if (
      existing?.stripeAccountId &&
      !existing.stripeAccountId.startsWith("acct_mxn_seed_")
    ) {
      return existing.stripeAccountId;
    }
    if (stripe) {
      const acct = await stripe.accounts.create({
        type: "custom",
        country: "US",
        business_type: "individual",
        business_profile: { url: "https://ithasfire.events" },
        individual: {
          first_name: "Test",
          last_name: "Payee",
          dob: { day: 1, month: 1, year: 1990 },
          address: {
            line1: "123 Main St",
            city: "San Francisco",
            state: "CA",
            postal_code: "94105",
          },
          ssn_last_4: "0000",
        },
        capabilities: { transfers: { requested: true } },
        tos_acceptance: {
          date: Math.floor(Date.now() / 1000),
          ip: "127.0.0.1",
        },
        external_account: {
          object: "bank_account",
          country: "US",
          currency: "usd",
          routing_number: "110000000",
          account_number: "000123456789",
        },
      } as any);
      console.log(
        `  [stripe] Created Connect account ${acct.id} for MXN payee`,
      );
      return acct.id;
    }
    return `acct_mxn_seed_${DEMO_IDS.payeeMxn.slice(-8)}`;
  })();

  const mxnPayee = await prisma.payee.upsert({
    where: { id: DEMO_IDS.payeeMxn },
    update: {
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      defaultCurrency: "mxn",
      stripeAccountId: mxnStripeAccountId,
    },
    create: {
      id: DEMO_IDS.payeeMxn,
      subjectType: "ORGANIZATION",
      subjectId: mxnOrg.id,
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      defaultCurrency: "mxn",
      stripeAccountId: mxnStripeAccountId,
    },
  });

  const mxnAgreement = await prisma.payoutTerms.upsert({
    where: { id: DEMO_IDS.agreementMxn },
    update: { status: "ACTIVE" },
    create: {
      id: DEMO_IDS.agreementMxn,
      kind: "PRIMARY",
      status: "ACTIVE",
      settlementCurrency: "mxn",
      isDefault: true,
      lines: {
        create: [
          { payeeId: mxnPayee.id, percent: 100, floorCents: 0, priority: 0 },
        ],
      },
    },
  });
  await prisma.payoutTermsLine.deleteMany({
    where: { payoutTermsId: mxnAgreement.id },
  });
  await prisma.payoutTermsLine.create({
    data: {
      payoutTermsId: mxnAgreement.id,
      payeeId: mxnPayee.id,
      percent: 100,
      floorCents: 0,
      priority: 0,
    },
  });

  // Wire up MXN org's default payout terms FK
  await prisma.organization.update({
    where: { id: mxnOrg.id },
    data: { defaultPrimaryPayoutTermsId: mxnAgreement.id },
  });

  console.log(`  MXN user: ${devLoginMxn.email} / ${devLoginMxn.password}`);
  console.log(`  MXN org: ${mxnOrg.name} (${mxnOrg.slug})`);
  console.log(`  MXN payee currency: mxn`);

  orgPayeeMap[DEMO_IDS.orgMxn] = {
    payeeId: mxnPayee.id,
    agreementId: mxnAgreement.id,
  };

  // ── Org-owned events ───────────────────────────────────────────────────
  const events = await pMap(fixtures, 6, async (fixture, idx) => {
    const categoryId =
      categoryMap[fixture.categorySlug ?? "community"] ??
      Object.values(categoryMap)[0]!;
    const record = await upsertEventWithTickets(prisma, fixture, {
      categoryId,
      orgPayeeMap,
      fixtureIndex: idx,
    });

    await ensureEventImage(prisma, record.id, idx);

    return {
      id: record.id,
      slug: record.slug ?? fixture.slug,
      title: record.title,
      startsAt: record.startsAt.toISOString(),
      status: record.status,
      regionCode: record.regionCode ?? fixture.regionCode,
    };
  });

  const byStatus = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Seeded ${events.length} events.`);
  console.log(
    `Status breakdown: ${Object.entries(byStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );

  const orgNameMap: Record<string, string> = {
    [DEMO_IDS.org]: "Ithas Fire Demo Org",
    [DEMO_IDS.org2]: "Austin Live Events",
    [DEMO_IDS.org3]: "Bay Area Festivals",
  };
  const byOrg = fixtures.reduce<Record<string, number>>((acc, f) => {
    const oid = f.orgId ?? DEMO_IDS.org;
    acc[oid] = (acc[oid] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `Org breakdown: ${Object.entries(byOrg)
      .map(([oid, count]) => `${orgNameMap[oid] ?? oid}=${count}`)
      .join(", ")}`,
  );

  // ── Link events to place layouts ────────────────────────────────────
  console.log("Linking events to venue place layouts...");
  const linkedEvents = await linkEventsToPlaceLayouts(prisma);
  if (linkedEvents.length > 0) {
    for (const le of linkedEvents) {
      console.log(`  ${le.eventSlug} -> layout ${le.layoutId.slice(-8)}`);
    }
  } else {
    console.log("  No events needed linking (already linked or no layouts).");
  }

  // ── Seat sections + seats (materialise layout metadata into DB rows) ───
  console.log("Materialising seat sections and seats for venue events...");
  const seatResults = await ensureEventSeatSections(prisma);
  for (const sr of seatResults) {
    console.log(
      `  ${sr.eventSlug}: ${sr.sectionsCreated} sections, ${sr.seatsCreated} seats, ${sr.ticketTypesLinked} ticket types linked`,
    );
  }

  // ── Validate layouts ──────────────────────────────────────────────────
  const layoutIssues = await validatePlaceLayouts(prisma);
  if (layoutIssues.length > 0) {
    console.warn(`Layout validation found ${layoutIssues.length} issue(s):`);
    for (const issue of layoutIssues) {
      const prefix = issue.level === "error" ? "  ERROR" : "  WARN ";
      console.warn(`${prefix} [${issue.eventSlug}] ${issue.message}`);
    }
    const errors = layoutIssues.filter((i) => i.level === "error");
    if (errors.length > 0) {
      console.error(
        `  ${errors.length} error-level issue(s) detected — venue checkout may not work correctly.`,
      );
    }
  } else {
    console.log(
      "Layout validation passed: all venue events have valid seating data.",
    );
  }

  // ── Renderability validation (checks data shape against SeatMapPicker) ──
  const renderIssues = await validateLayoutRenderability(prisma);
  if (renderIssues.length > 0) {
    console.warn(
      `Renderability validation found ${renderIssues.length} issue(s):`,
    );
    for (const ri of renderIssues) {
      const prefix = ri.level === "error" ? "  ERROR" : "  WARN ";
      console.warn(`${prefix} [${ri.layoutName}] (${ri.code}) ${ri.message}`);
    }
    const renderErrors = renderIssues.filter((i) => i.level === "error");
    if (renderErrors.length > 0) {
      console.error(
        `  ${renderErrors.length} renderability error(s) — SeatMapPicker may not display correctly.`,
      );
    }
  } else {
    console.log(
      "Renderability validation passed: all layouts can be rendered by SeatMapPicker.",
    );
  }

  // ── Human-owned (personal) events for the dev-login user ───────────────
  const devStripeAccountId = await (async () => {
    const existing = await prisma.payee.findUnique({
      where: { id: DEMO_IDS.devPayee },
      select: { stripeAccountId: true },
    });
    if (
      existing?.stripeAccountId &&
      !existing.stripeAccountId.startsWith("acct_seed_")
    ) {
      return existing.stripeAccountId;
    }
    if (stripe) {
      const acct = await stripe.accounts.create({
        type: "custom",
        country: "US",
        business_type: "individual",
        business_profile: { url: "https://ithasfire.events" },
        individual: {
          first_name: "Test",
          last_name: "Payee",
          dob: { day: 1, month: 1, year: 1990 },
          address: {
            line1: "123 Main St",
            city: "San Francisco",
            state: "CA",
            postal_code: "94105",
          },
          ssn_last_4: "0000",
        },
        capabilities: { transfers: { requested: true } },
        tos_acceptance: {
          date: Math.floor(Date.now() / 1000),
          ip: "127.0.0.1",
        },
        external_account: {
          object: "bank_account",
          country: "US",
          currency: "usd",
          routing_number: "110000000",
          account_number: "000123456789",
        },
      } as any);
      console.log(
        `  [stripe] Created Connect account ${acct.id} for dev payee`,
      );
      return acct.id;
    }
    return `acct_seed_${DEMO_IDS.devPayee.slice(-8)}`;
  })();

  const devPayee = await prisma.payee.upsert({
    where: { id: DEMO_IDS.devPayee },
    update: {
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      stripeAccountId: devStripeAccountId,
    },
    create: {
      id: DEMO_IDS.devPayee,
      subjectType: "HUMAN",
      subjectId: DEMO_IDS.devUser,
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      defaultCurrency: "usd",
      stripeAccountId: devStripeAccountId,
    },
  });

  await prisma.human.update({
    where: { id: DEMO_IDS.devUser },
    data: {
      chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: new Date(),
    },
  });

  const devAgreement = await prisma.payoutTerms.upsert({
    where: { id: DEMO_IDS.devAgreement },
    update: { status: "ACTIVE" },
    create: {
      id: DEMO_IDS.devAgreement,
      kind: "PRIMARY",
      status: "ACTIVE",
      settlementCurrency: "usd",
      lines: {
        create: [
          { payeeId: devPayee.id, percent: 100, floorCents: 0, priority: 0 },
        ],
      },
    },
  });
  await prisma.payoutTermsLine.deleteMany({
    where: { payoutTermsId: devAgreement.id },
  });
  await prisma.payoutTermsLine.create({
    data: {
      payoutTermsId: devAgreement.id,
      payeeId: devPayee.id,
      percent: 100,
      floorCents: 0,
      priority: 0,
    },
  });

  const defaultCategoryId =
    categoryMap["community"] ?? Object.values(categoryMap)[0]!;
  console.log(
    `Seeding ${HUMAN_EVENT_FIXTURES.length} human-owned events for dev-login user...`,
  );
  const humanEvents = await pMap(
    HUMAN_EVENT_FIXTURES,
    3,
    async (fixture, idx) => {
      const categoryId = categoryMap[fixture.categorySlug] ?? defaultCategoryId;
      const record = await upsertHumanEventWithTickets(prisma, fixture, {
        actorHumanId: DEMO_IDS.devUser,
        categoryId,
        payeeId: devPayee.id,
        fixtureIndex: events.length + idx,
      });
      await ensureEventImage(prisma, record.id, events.length + idx);
      return {
        id: record.id,
        slug: record.slug ?? fixture.slug,
        title: record.title,
        startsAt: record.startsAt.toISOString(),
        status: record.status,
        regionCode: record.regionCode ?? fixture.regionCode,
      };
    },
  );
  console.log(`  Seeded ${humanEvents.length} human-owned events`);

  // ── Orders ─────────────────────────────────────────────────────────────
  const publishedEvents = events.filter((e) => e.status === "PUBLISHED");
  const publishedHumanEvents = humanEvents.filter(
    (e) => e.status === "PUBLISHED",
  );

  await Promise.all([
    seedDemoOrders(prisma, publishedEvents, { stripeSecretKey }),
    seedDevLoginOrders(prisma, publishedEvents, { stripeSecretKey }),
    seedHumanEventOrders(prisma, publishedHumanEvents, { stripeSecretKey }),
  ]);

  // Cash + comp sales — no Stripe key required (FR-015 bypasses processor).
  await seedDemoCashSales(prisma, publishedEvents);

  // POS Tap-to-Pay sales — paymentChannel="POS" with phantom POS_WALKUP humans.
  await seedDemoPosOrders(prisma, publishedEvents);

  // Attendee-review ("Rate this show") fixture — a SUCCEEDED order + one
  // SCANNED ticket owned by the dev-login admin against the recent-past recap
  // event, so /review-event + the my-tickets "Rate this show" CTA are
  // exercisable locally. Stripe-free; runs regardless of STRIPE_SECRET_KEY.
  // Deliberately seeds NO AttendeeReview (that would hide the CTA).
  await seedAttendeeReviewShow(prisma, { humanId: DEMO_IDS.devUser });

  // ── Ledger credits (splits + SETTLEMENT_CREDIT entries for SUCCEEDED
  // orders) ──────────────────────────────────────────────────────────────
  // The seed creates orders directly (not via webhook), so we need to
  // create OrderSplits and ledger credits explicitly. This gives the full
  // pipeline testable locally: seed → credits exist → run-batch → transfers.
  //
  // Creates a realistic mix:
  //   ~50% instant payouts (immediately mature for batch transfer)
  //   ~50% real maturity dates (pending until event date passes)
  if (stripeSecretKey) {
    console.log(
      "Creating order splits and ledger credits for succeeded orders...",
    );
    const repos = createPrismaRepos(prisma);
    const clock = createSystemClock();
    const succeededOrders = await prisma.order.findMany({
      where: { status: "SUCCEEDED", stripePaymentIntentId: { not: null } },
      select: {
        id: true,
        eventId: true,
        amountGrossCents: true,
        feesPlatformCents: true,
        currency: true,
      },
    });

    let splitCount = 0;
    let instantCount = 0;
    let scheduledCount = 0;

    for (let i = 0; i < succeededOrders.length; i++) {
      const order = succeededOrders[i]!;
      // Membership invoices are Orders with no event; the seed only builds
      // ticketing orders, so this is belt-and-braces for the nullable FK.
      if (!order.eventId) continue;
      // Resolve the payee for this order's event via org → payee mapping
      const event = await prisma.event.findUnique({
        where: { id: order.eventId },
        select: { orgId: true, humanId: true },
      });
      if (!event) continue;

      const payeeId = event.orgId
        ? orgPayeeMap[event.orgId]?.payeeId
        : event.humanId === DEMO_IDS.devUser
          ? DEMO_IDS.devPayee
          : undefined;
      if (!payeeId) continue;

      // Create OrderSplit (100% to the payee, net of platform fees)
      const splitAmount = order.amountGrossCents - order.feesPlatformCents;
      if (splitAmount <= 0) continue;

      // Alternate: even-indexed orders get instant payouts (transferable now),
      // odd-indexed get real payout dates (pending until event date passes).
      const useInstant = i % 2 === 0;

      try {
        await prisma.orderSplit.upsert({
          where: { orderId_payeeId: { orderId: order.id, payeeId } },
          update: { amountCents: splitAmount },
          create: { orderId: order.id, payeeId, amountCents: splitAmount },
        });
        splitCount++;

        await createCreditsFromOrder(
          { repos, clock, instantPayouts: useInstant },
          { orderId: order.id },
        );
        if (useInstant) instantCount++;
        else scheduledCount++;
      } catch (err) {
        // Some orders may fail (missing payout terms, etc.) — skip gracefully
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? (err as any).message
              : String(err);
        console.warn(
          `  [warn] Ledger credit for order ${order.id.slice(-8)}: ${msg}`,
        );
      }
    }

    console.log(
      `  Created ${splitCount} splits, ${instantCount} instant + ${scheduledCount} scheduled ledger credits`,
    );
  }

  // Force payoutsEnabled + chargesEnabled back to true on every seed run.
  // Stripe's `account.updated` webhook (when forwarded by the Stripe CLI)
  // syncs capabilities to false because the seed-created Custom accounts
  // aren't fully verified. Running this **outside** the `stripeSecretKey`
  // branch ensures seed orgs end up sellable even when:
  //   - The user runs without a Stripe key (no real accounts created),
  //   - The Stripe webhook lands AFTER the seed completed,
  //   - A previous seed run stamped the flags but a webhook later flipped
  //     them and the user re-ran seed.
  // The downstream effect: paid events created in seed always have a
  // sellable organizer in dev, matching the publish-time gate's expectation.
  const resetCount = await prisma.payee.updateMany({
    data: { payoutsEnabled: true, chargesEnabled: true, status: "ACTIVE" },
  });
  console.log(
    `  Reset ${resetCount.count} payee(s) to enabled (overrides webhook sync)`,
  );

  // ── Extras ─────────────────────────────────────────────────────────────
  const allEvents = [...events, ...humanEvents];
  await seedDevLoginExtras(prisma, allEvents);

  // ── Volunteering ────────────────────────────────────────────────────────
  // Platform-curated catalogue first (FR-018): it is org-independent and the
  // organizer template list unions it with the demo org's own rows, so seeding
  // it here means the templates screen has catalogue content from run one.
  // Needs categories (targeting is resolved by slug) — seeded far above.
  //
  // `refresh` + `prune` are BOTH on here and both off in the deploy workflows:
  // `pnpm seed:dev` drops and recreates the schema, so there is no staff-
  // authored catalogue content to protect and full convergence on the git
  // baseline is exactly what a dev reseed is for. See the header of
  // seed/volunteer-packs.ts.
  await ensureVolunteerPacks(prisma, { refresh: true, prune: true });

  // Same contract for the ticket-type catalogue (ticket-type-packs FR-013):
  // install-only in deploys, full convergence under the dev wipe.
  await ensureTicketPacks(prisma, { refresh: true, prune: true });

  // Same contract again for the application-form starter catalogue
  // (application-driven-events spec Phase 4): install-only in deploys, full
  // convergence under the dev wipe. Owner-independent, so it can run here
  // regardless of which orgs exist.
  await ensureApplicationFormTemplates(prisma, { refresh: true, prune: true });

  console.log(
    "Seeding volunteering data (role templates, roles, shifts, signups)...",
  );
  await seedVolunteering(prisma, allEvents);

  // ── Entity pages (orgs + places + enriched humans) ──────────────────────
  // Must run AFTER orgs/places/humans exist but can run independently of
  // events/orders. Populates EntityPage rows with bio + theme + blocks so
  // the consumer mobile app's profile/entity surfaces have real content.
  await seedAllEntityPages(prisma);

  // ── Entity follows ──────────────────────────────────────────────────────
  // Populates EntityFollow rows so the dev user has a non-empty following
  // feed and entity pages render non-zero follower counts.
  await seedEntityFollows(prisma);

  // ── Community listing + edit-suggestion queue fixtures ─────────────────
  // One ownerless COMMUNITY listing + PENDING EventEditSuggestion rows so the
  // moderator queue (/moderate/suggestions) and the FR-016 org "Suggestions"
  // inbox have real data to review. Must run after org-owned events exist
  // (one suggestion targets a demo-org event) and before the search index
  // build so the community listing is indexed.
  console.log("Seeding community listing + edit suggestions...");
  const communitySeed = await seedCommunityEditSuggestions(prisma, {
    communityCategoryId: categoryMap["community"] ?? null,
  });
  console.log(
    `  Community listing "${communitySeed.communityEventSlug}" + ${communitySeed.suggestionCount} pending suggestions`,
  );

  // ── Featured items (hero carousel) ────────────────────────────────────
  console.log("Seeding featured items for hero carousel...");
  const featuredSlugs = [...FEATURED_EVENT_SLUGS];
  const featuredEventRows = await prisma.event.findMany({
    where: { slug: { in: featuredSlugs } },
    select: { id: true, slug: true },
  });
  const eventSlugToIdMap: Record<string, string> = Object.fromEntries(
    featuredEventRows.map((r) => [r.slug!, r.id]),
  );
  await ensureFeaturedItems(prisma, eventSlugToIdMap);

  console.log(`Dev login user: ${devLogin.email} / ${devLogin.password}`);
  console.log(
    `Dev login MXN user: ${DEV_LOGIN_MXN_USER.email} / ${DEV_LOGIN_MXN_USER.password}`,
  );

  // ── Apple App Store reviewer fixture ───────────────────────────────────
  // Self-contained: an org, a member (OWNER so they have all roles incl.
  // scanning), one unpublished event with a single GA ticket type and one
  // pre-issued ticket bearing the public test code APPLE-REVIEW-001.
  // The /qr-test page renders a QR for that code so the reviewer can
  // validate the scanner end-to-end during App Store review.
  const existingAppleOrg = await prisma.organization.findUnique({
    where: { slug: APPLE_REVIEW_ORG_SLUG },
    select: { id: true },
  });
  if (existingAppleOrg) {
    console.log(
      `Apple review fixture: org "${APPLE_REVIEW_ORG_SLUG}" already exists — skipping.`,
    );
  } else {
    console.log("Seeding Apple App Store reviewer fixture...");

    // Reviewer human + auth user (email-verified, password set)
    const reviewerHuman = await prisma.human.upsert({
      where: { id: APPLE_REVIEW_IDS.reviewerHuman },
      update: { name: "Apple Reviewer", status: "ACTIVE" },
      create: {
        id: APPLE_REVIEW_IDS.reviewerHuman,
        name: "Apple Reviewer",
        status: "ACTIVE",
        locale: "en",
      },
    });

    const reviewerAuthUser = await prisma.authUser.upsert({
      where: { id: APPLE_REVIEW_IDS.reviewerHuman },
      update: {
        email: APPLE_REVIEWER_EMAIL,
        name: "Apple Reviewer",
        emailVerified: true,
        humanId: reviewerHuman.id,
      },
      create: {
        id: APPLE_REVIEW_IDS.reviewerHuman,
        email: APPLE_REVIEWER_EMAIL,
        name: "Apple Reviewer",
        emailVerified: true,
        humanId: reviewerHuman.id,
      },
    });

    const reviewerPasswordHash = await hashPassword(APPLE_REVIEWER_PASSWORD);
    await prisma.authAccount.upsert({
      where: {
        providerId_accountId: {
          providerId: "credential",
          accountId: reviewerAuthUser.id,
        },
      },
      update: {
        password: reviewerPasswordHash,
        userId: reviewerAuthUser.id,
      },
      create: {
        providerId: "credential",
        accountId: reviewerAuthUser.id,
        userId: reviewerAuthUser.id,
        password: reviewerPasswordHash,
      },
    });

    // Phantom buyer (POS_WALKUP so it stays out of marketing audiences)
    const buyerHuman = await prisma.human.upsert({
      where: { id: APPLE_REVIEW_IDS.buyerHuman },
      update: { name: "Apple Review Guest", status: "ACTIVE" },
      create: {
        id: APPLE_REVIEW_IDS.buyerHuman,
        name: "Apple Review Guest",
        status: "ACTIVE",
        locale: "en",
        source: "POS_WALKUP",
      },
    });

    // Org + reviewer membership (OWNER covers all ORG_SCAN_ROLES)
    const appleOrg = await prisma.organization.upsert({
      where: { id: APPLE_REVIEW_IDS.org },
      update: {
        name: "Apple Review Org",
        slug: APPLE_REVIEW_ORG_SLUG,
        status: "ACTIVE",
      },
      create: {
        id: APPLE_REVIEW_IDS.org,
        name: "Apple Review Org",
        slug: APPLE_REVIEW_ORG_SLUG,
        status: "ACTIVE",
        defaultLocale: "en",
      },
    });

    await prisma.orgMember.upsert({
      where: {
        orgId_humanId: {
          orgId: appleOrg.id,
          humanId: reviewerHuman.id,
        },
      },
      update: { role: "OWNER" },
      create: {
        orgId: appleOrg.id,
        humanId: reviewerHuman.id,
        role: "OWNER",
      },
    });

    // Event — DRAFT, public visibility, future date. Reviewer accesses it
    // via the scanner shell, not the public web, so we don't bother
    // publishing (which would require payee/agreement plumbing).
    const appleEventStartsAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    );
    const appleEventEndsAt = new Date(
      appleEventStartsAt.getTime() + 3 * 60 * 60 * 1000,
    );
    const fallbackCategoryId =
      categoryMap["community"] ?? Object.values(categoryMap)[0]!;

    const appleEvent = await prisma.event.upsert({
      where: { id: APPLE_REVIEW_IDS.event },
      update: {
        title: "Apple Review Test Event",
        slug: APPLE_REVIEW_EVENT_SLUG,
        orgId: appleOrg.id,
        startsAt: appleEventStartsAt,
        endsAt: appleEventEndsAt,
        status: "DRAFT",
        visibility: "PUBLIC",
        gateType: "NONE",
        categoryId: fallbackCategoryId,
        countryCode: "US",
      },
      create: {
        id: APPLE_REVIEW_IDS.event,
        title: "Apple Review Test Event",
        slug: APPLE_REVIEW_EVENT_SLUG,
        orgId: appleOrg.id,
        startsAt: appleEventStartsAt,
        endsAt: appleEventEndsAt,
        status: "DRAFT",
        visibility: "PUBLIC",
        gateType: "NONE",
        categoryId: fallbackCategoryId,
        countryCode: "US",
        addressText: "1 Apple Park Way, Cupertino, CA 95014",
        regionCode: "ca-sf",
      },
    });

    // Ticket type — GA, $1, capacity 100
    await prisma.ticketType.upsert({
      where: { id: APPLE_REVIEW_IDS.ticketType },
      update: {
        name: "General Admission",
        priceCents: 100,
        capacity: 100,
        status: "ACTIVE",
      },
      create: {
        id: APPLE_REVIEW_IDS.ticketType,
        eventId: appleEvent.id,
        name: "General Admission",
        priceCents: 100,
        capacity: 100,
        status: "ACTIVE",
      },
    });

    // Issued ticket the reviewer will scan via the /qr-test QR.
    // status=VALID so the scanner can successfully mark it SCANNED on first
    // tap. Re-running the seed will reset it to VALID + clear scannedAt.
    await prisma.ticket.upsert({
      where: { id: APPLE_REVIEW_IDS.ticket },
      update: {
        status: "VALID",
        scannedAt: null,
        code: APPLE_REVIEW_TICKET_CODE,
        eventId: appleEvent.id,
        ticketTypeId: APPLE_REVIEW_IDS.ticketType,
        ownerHumanId: buyerHuman.id,
      },
      create: {
        id: APPLE_REVIEW_IDS.ticket,
        eventId: appleEvent.id,
        ticketTypeId: APPLE_REVIEW_IDS.ticketType,
        ownerHumanId: buyerHuman.id,
        code: APPLE_REVIEW_TICKET_CODE,
        status: "VALID",
      },
    });

    console.log(
      `  Apple reviewer: ${APPLE_REVIEWER_EMAIL} / ${APPLE_REVIEWER_PASSWORD}`,
    );
    console.log(
      `  Apple event: "${APPLE_REVIEW_EVENT_SLUG}" with ticket code ${APPLE_REVIEW_TICKET_CODE}`,
    );
  }

  // ── Venue-hierarchy backfill (spaces + calendars) ───────────────────────
  // Greenfield seed backfill (NOT a data migration): every place-linked
  // seeded event gets its place's default space + default calendar so admin
  // calendars / calendar surfaces render real data. Must run AFTER every
  // event-creating step above (org events, human events, community listing,
  // attendee-review show, Apple review event).
  const venueBackfilled = await backfillEventVenueDefaults(prisma);
  console.log(
    `Venue hierarchy: backfilled ${venueBackfilled} events with default space/calendar`,
  );

  // ── Credentials file ───────────────────────────────────────────────────
  const credentialsOutput: string[] = [
    "# Ithas Fire Seed Credentials",
    `# Generated at: ${new Date().toISOString()}`,
    "#",
    "# This file is gitignored. Do not commit credentials.",
    "",
    "## Dev Login User (main test account, USD)",
    `Email: ${devLogin.email}`,
    `Password: ${devLogin.password}`,
    "",
    "## Dev Login MXN User (MXN currency test account)",
    `Email: ${DEV_LOGIN_MXN_USER.email}`,
    `Password: ${DEV_LOGIN_MXN_USER.password}`,
    `Org: Mexico City Events (mexico-city-events)`,
    "",
    "## Additional Seeded Users",
    `Password (all): demo1234`,
    "",
  ];

  for (const fixture of ADDITIONAL_HUMANS) {
    credentialsOutput.push(`- ${fixture.name}: ${fixture.email}`);
  }

  credentialsOutput.push("");
  credentialsOutput.push("## Seeded Organizations");
  for (const org of additionalOrgs) {
    credentialsOutput.push(`- ${org.name} (id: ${org.id})`);
  }

  credentialsOutput.push("");
  credentialsOutput.push("## Seeded Places (Venues)");
  for (const place of places) {
    credentialsOutput.push(`- ${place.name} (slug: ${place.slug})`);
  }

  // Write to a hidden, app-local folder so the file doesn't sit at the
  // repo root competing for attention with real source dirs. The folder
  // is gitignored alongside .env*.local, so nothing changes about secret
  // handling — just less visual clutter.
  const credentialsDir = path.resolve(__dirname, "../../.secrets");
  if (!fs.existsSync(credentialsDir)) {
    fs.mkdirSync(credentialsDir, { recursive: true });
  }
  const credentialsPath = path.join(credentialsDir, "seed-credentials.txt");
  fs.writeFileSync(credentialsPath, credentialsOutput.join("\n"), "utf-8");
  console.log(`Credentials written to: ${credentialsPath}`);

  for (const event of events) {
    console.log(
      ` - [${event.regionCode}] ${event.title} (${event.status}) -- ${event.startsAt}`,
    );
  }

  // ── Search index ───────────────────────────────────────────────────────
  // Use the parsed env so seed and runtime share one source of truth and
  // can never drift on defaults (SEARCH_BACKEND defaults to "postgres").
  const meiliHost = process.env.MEILISEARCH_HOST;
  const meiliKey = process.env.MEILISEARCH_API_KEY;
  const searchBackend = env.SEARCH_BACKEND;

  if (searchBackend === "postgres") {
    console.log("Building search index in Postgres...");
    const multiSearch = new MultiIndexPostgresAdapter({
      prisma,
      weights: searchWeightsFromEnv(),
    });
    const repos = createPrismaRepos(prisma);

    try {
      const result = await buildSearchIndex(
        { repos, search: multiSearch, clock: createSystemClock() },
        { fullReindex: true },
      );
      console.log(
        `  Indexed ${result.eventsIndexed} events, ${result.humansIndexed} humans, ${result.placesIndexed} places, ${result.organizationsIndexed} organizations`,
      );
    } catch (err) {
      console.warn(
        "  Search indexing failed (Postgres search table may not be migrated):",
        err instanceof Error ? err.message : err,
      );
    }
  } else if (searchBackend === "meili" && meiliHost && meiliKey) {
    console.log("Building search index in Meilisearch...");
    const multiSearch = new MultiIndexMeilisearchAdapter({
      host: meiliHost,
      apiKey: meiliKey,
    });
    const repos = createPrismaRepos(prisma);

    try {
      const result = await buildSearchIndex(
        { repos, search: multiSearch, clock: createSystemClock() },
        { fullReindex: true },
      );
      console.log(
        `  Indexed ${result.eventsIndexed} events, ${result.humansIndexed} humans, ${result.placesIndexed} places, ${result.organizationsIndexed} organizations`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.toLowerCase().includes("api key is invalid") &&
        meiliKey !== meiliMasterKey
      ) {
        try {
          const retrySearch = new MultiIndexMeilisearchAdapter({
            host: meiliHost,
            apiKey: meiliMasterKey,
          });
          const retryResult = await buildSearchIndex(
            { repos, search: retrySearch, clock: createSystemClock() },
            { fullReindex: true },
          );
          console.log(
            `  Indexed ${retryResult.eventsIndexed} events, ${retryResult.humansIndexed} humans, ${retryResult.placesIndexed} places, ${retryResult.organizationsIndexed} organizations`,
          );
        } catch (retryErr) {
          console.warn(
            "  Search indexing failed (Meilisearch may not be running):",
            retryErr instanceof Error ? retryErr.message : retryErr,
          );
        }
      } else {
        console.warn(
          "  Search indexing failed (Meilisearch may not be running):",
          message,
        );
      }
    }
  } else {
    console.log(
      "Skipping search index build (MEILISEARCH_HOST or MEILISEARCH_API_KEY not set)",
    );
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`Done in ${elapsed}s`);
}

main()
  .catch((error) => {
    console.error("Failed to seed demo data", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
