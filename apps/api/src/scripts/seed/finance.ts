import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import { DEMO_IDS } from "./ids.js";

export const ensureSeedPrimaryPayoutLine = async (
  prisma: PrismaClient,
  payoutTermsId: string,
  payeeId: string,
) => {
  const existingLine = await prisma.payoutTermsLine.findFirst({
    where: {
      payoutTermsId,
      payeeId,
      ticketTypeId: null,
    },
    select: { id: true },
  });

  if (existingLine) {
    await prisma.payoutTermsLine.update({
      where: { id: existingLine.id },
      data: {
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });
    return;
  }

  await prisma.payoutTermsLine.create({
    data: {
      payoutTermsId,
      payeeId,
      percent: 100,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
    },
  });
};

// ── Stripe Connect helper ────────────────────────────────────────────────

/**
 * Create (or reuse) a real Stripe Connect Custom account in test mode.
 * Uses `type: "custom"` with ToS pre-accepted and transfer capability so the
 * account is immediately ready to receive transfers without onboarding.
 * Falls back to a fake `acct_seed_*` ID when no Stripe instance is provided.
 */
async function resolveStripeAccountId(
  prisma: PrismaClient,
  payeeId: string,
  stripe: Stripe | undefined,
): Promise<string> {
  // If the payee already exists with a real (non-seed) Stripe account, keep it.
  const existing = await prisma.payee.findUnique({
    where: { id: payeeId },
    select: { stripeAccountId: true },
  });
  if (
    existing?.stripeAccountId &&
    !existing.stripeAccountId.startsWith("acct_seed_") &&
    !existing.stripeAccountId.startsWith("acct_mxn_seed_")
  ) {
    return existing.stripeAccountId;
  }

  if (!stripe) {
    return `acct_seed_${payeeId.slice(-8)}`;
  }

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
    capabilities: {
      transfers: { requested: true },
    },
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
    `  [stripe] Created Connect account ${acct.id} for payee ${payeeId.slice(-8)}`,
  );
  return acct.id;
}

// ── Payee ���──────────────��─────────────────────────────��──────────────────

export const ensurePayee = async (
  prisma: PrismaClient,
  orgId: string,
  payeeId: string = DEMO_IDS.payee,
  stripe?: Stripe,
) => {
  const stripeAccountId = await resolveStripeAccountId(prisma, payeeId, stripe);
  return prisma.payee.upsert({
    where: { id: payeeId },
    update: {
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      stripeAccountId,
    },
    create: {
      id: payeeId,
      subjectType: "ORGANIZATION",
      subjectId: orgId,
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      defaultCurrency: "usd",
      stripeAccountId,
    },
  });
};

// ── Payout agreement ─────────────────────────────────────────────────────

export const ensureAgreement = async (
  prisma: PrismaClient,
  orgId: string,
  payeeId: string,
  agreementId: string = DEMO_IDS.agreement,
) => {
  const agreement = await prisma.payoutTerms.upsert({
    where: { id: agreementId },
    update: {
      status: "ACTIVE",
    },
    create: {
      id: agreementId,
      kind: "PRIMARY",
      status: "ACTIVE",
      settlementCurrency: "usd",
      lines: {
        create: [
          {
            payeeId,
            percent: 100,
            floorCents: 0,
            priority: 0,
          },
        ],
      },
    },
  });

  // ensure line remains 100% on repeated runs
  await prisma.payoutTermsLine.deleteMany({
    where: { payoutTermsId: agreement.id },
  });
  await prisma.payoutTermsLine.create({
    data: {
      payoutTermsId: agreement.id,
      payeeId,
      percent: 100,
      floorCents: 0,
      priority: 0,
    },
  });

  return agreement;
};

// ── Default agreements (primary + resale) ────────────────��───────────────

export const ensureDefaultAgreements = async (
  prisma: PrismaClient,
  orgId: string,
  payeeId: string = DEMO_IDS.payee,
  agreementId: string = DEMO_IDS.agreement,
): Promise<{ primaryId: string; resaleId: string }> => {
  const [primaryExisting, resaleExisting] = await Promise.all([
    prisma.payoutTerms.findFirst({
      where: {
        kind: "PRIMARY",
        status: { in: ["ACTIVE", "PENDING"] },
        isDefault: true,
        id: agreementId,
      },
      select: { id: true },
    }),
    prisma.payoutTerms.findFirst({
      where: {
        kind: "RESALE",
        status: { in: ["ACTIVE", "PENDING"] },
        isDefault: true,
      },
      select: { id: true },
    }),
  ]);

  let primaryId = primaryExisting?.id ?? agreementId;
  if (!primaryExisting) {
    await prisma.payoutTerms.update({
      where: { id: agreementId },
      data: { isDefault: true },
    });
  }

  let resaleId = resaleExisting?.id ?? "";
  if (!resaleExisting) {
    // Create a minimal default resale payout terms so the repo can link it on draft creation.
    const resale = await prisma.payoutTerms.create({
      data: {
        kind: "RESALE",
        status: "ACTIVE",
        settlementCurrency: "usd",
        isDefault: true,
        version: 1,
        lines: {
          create: [
            {
              payeeId,
              percent: 0,
              floorCents: 0,
              priority: 0,
            },
          ],
        },
      },
      select: { id: true },
    });

    // Ensure line exists (same pattern as ensureAgreement).
    await prisma.payoutTermsLine.deleteMany({
      where: { payoutTermsId: resale.id },
    });
    await prisma.payoutTermsLine.create({
      data: {
        payoutTermsId: resale.id,
        payeeId,
        percent: 0,
        floorCents: 0,
        priority: 0,
      },
    });

    resaleId = resale.id;
  }

  // Wire up the org's default payout terms FKs
  await prisma.organization.update({
    where: { id: orgId },
    data: {
      defaultPrimaryPayoutTermsId: primaryId,
      defaultResalePayoutTermsId: resaleId,
    },
  });

  return { primaryId, resaleId };
};

// ── Fee policy ─────────────────────────────���─────────────────────────────

/**
 * CREATE-IF-ABSENT, not reconcile. Deliberate, and worth being precise about:
 *
 *   - On a FRESH database (the only case that matters for `seed:dev`, which
 *     wipes) this installs `PLATFORM_FEE_POLICY`, so a locally-seeded stack and
 *     a deployed one run the same economics.
 *   - On an EXISTING dev database it is a no-op and the old row survives, even
 *     if the constant has since changed. It does NOT converge. To pull an
 *     existing local DB onto the current constant, run `pnpm seed:fee-policy`
 *     — the same reconciler the deploy runs.
 *
 * It is not wired to `reconcilePlatformFeePolicy` because that mints a new
 * policy VERSION when it writes, and seeding demo data should not silently
 * archive a row a developer is mid-way through testing against.
 */
export const ensureFeePolicy = async (prisma: PrismaClient) => {
  // publishEvent resolves fee policies in this order: EVENT -> ORG -> GLOBAL.
  // For seed, a simple GLOBAL ACTIVE policy is enough.
  //
  // The existence check is deliberately NOT time-filtered. It used to also
  // require `effectiveFrom <= now < effectiveTo`, which meant an ACTIVE GLOBAL
  // row outside its effective window (a hand-stamped `effectiveTo`, a clock
  // skew, a fixture dated into the future) read as "no policy" and this
  // function inserted a SECOND ACTIVE GLOBAL row. That is now refused by
  // `FeePolicy_one_active_per_scope_key` (migration
  // 20260812130000_fee_policy_one_active_per_scope) with a P2002, so
  // create-if-absent has to mean absent from the SCOPE, matching the index's
  // predicate exactly. Returning the existing row is also the only legal
  // outcome: the seed's job is to hand back an id to pin onto payout terms,
  // and `loadPayoutTermsContext` reads that pin with `getById`, which does not
  // filter on the effective window.
  const existing = await prisma.feePolicy.findFirst({
    where: { scopeType: "GLOBAL", scopeId: null, status: "ACTIVE" },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    select: { id: true },
  });

  if (existing) return existing;

  return prisma.feePolicy.create({
    data: {
      // Scaled per-ticket buyer fee: 3.33% of face, capped at 50¢. Carries
      // `scopeType: "GLOBAL"` / `scopeId: null` as well as the economics.
      //
      // Spread from the SAME code constant the deploy-time reconciler
      // (`apps/api/src/scripts/seed-platform-fee-policy.ts`) materializes, so a
      // FRESHLY seeded dev DB and a deployed one cannot start out with
      // different economics (see the create-if-absent caveat above). Do NOT
      // inline numbers here — change
      // `packages/core/src/lib/pricing/platform-fee-policy.ts` instead.
      ...PLATFORM_FEE_POLICY,

      // Row lifecycle — owned by the seed, not by the policy constant.
      status: "ACTIVE",
      version: 1,
      effectiveFrom: new Date(Date.now() - 60 * 60 * 1000),
      effectiveTo: null,

      notes: "dev seed default (from PLATFORM_FEE_POLICY)",
      createdBy: DEMO_IDS.human,
      approvedBy: DEMO_IDS.human,
    },
    select: { id: true },
  });
};
