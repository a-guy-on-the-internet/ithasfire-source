import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";

// ─────────────────────────────────────────────────────────────────────────────
// Membership fixtures — the VISIBILITY half of /platform/memberships.
//
// Without these, a freshly seeded dev database has ZERO MembershipTier and
// ZERO Membership rows, so every membership surface in the product renders its
// empty state: the platform standing table (which derives its rows from
// `listOwnersWithTiers` and has therefore never displayed a single row in
// dev), the recurring-revenue panel, the needs-attention list, the leaving
// list, and the `memberships.report-health` job. These give each of them
// something real.
//
// FILL GAPS, NEVER CLOBBER (house seed convention). Every row is written
// create-if-absent against a deterministic id, so a re-run is a no-op and a
// developer who has been poking at a row by hand keeps their edits. Nothing
// here deletes, and nothing here updates.
//
// ── WHAT IS DELIBERATELY LEFT OFF, AND WHICH JOB WOULD HAVE CHASED IT ──────
//
// This is the same question the payout fixtures had to answer about their
// reserve columns, and it has the same shape: a display fixture must be INERT
// to every scheduled job, or the job acts on money that never moved.
//
//   * `Membership.taxJurisdictionId` / `billingPostalCode` /
//     `billingCountryCode` are ALWAYS NULL, and that is a correctness
//     constraint rather than a gap. `memberships.refresh-tax-jurisdictions`
//     (daily, 06:40) selects memberships by `listByTaxJurisdictionId` and then
//     repoints each one's Stripe `default_tax_rates` through the real Billing
//     API. A fixture carrying a jurisdiction would put `sub_seed_*` into that
//     call the first time any rate changed — a 404 from Stripe in the middle
//     of a migration step whose whole purpose is to keep live subscriptions
//     off archived tax rates. Null keeps every fixture outside the job's
//     selection entirely.
//
//   * `MembershipTier.stripeProductId` / `stripePriceId` are ALWAYS NULL, for
//     two separate reasons. `startMembership` refuses a tier with no price id
//     (`MEMBERSHIP_TIER_NOT_ACTIVE`) BEFORE it touches Stripe, so a developer
//     who clicks "Join" on a seeded tier gets a clean typed refusal instead of
//     a Stripe 400 about a price that does not exist. And `publishMembershipTier`
//     early-returns when BOTH ids are already set, so a fake pair would
//     permanently block that tier from ever minting real Stripe objects —
//     the seeded tier could never be made real. Null leaves "Publish" as the
//     working path to a genuinely joinable tier.
//
//   * NO `Order` rows with `kind = MEMBERSHIP`. Membership invoices are
//     materialised as Orders, and membership-classified settlement lines are
//     exactly what `runPayoutBatch` step 4b-2 holds against a suspended owner
//     and what `MembershipStanding.reserveBps` withholds from. Writing them
//     here would feed the payout batch money that never arrived — the same
//     hazard that made the payout fixtures drop their reserve columns.
//
//   * NO `MembershipStanding` rows. The standing overview synthesises the
//     schema defaults (no reserve, 90-day release) for an owner without one,
//     so the table renders correctly without them, and a seeded standing would
//     be an intervention nobody made sitting in an audit-visible field.
//
// `stripeSubscriptionId` and `stripeCustomerId` are NOT NULL and unique, so
// they cannot be omitted. They carry obvious `sub_seed_*` / `cus_seed_*`
// values and nothing sweeps them: every membership webhook path is INBOUND and
// keyed by the subscription id Stripe sends, so an id Stripe has never heard
// of is never delivered, and `sendRenewalNotice` fires only from
// `invoice.upcoming`.
//
// The real thing is `publishMembershipTier` + `startMembership` against a
// Stripe test key; run those if you want end-to-end membership state.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const daysFromNow = (now: Date, days: number, hourUtc = 9): Date => {
  const d = new Date(now.getTime() + days * DAY_MS);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

type SeedTier = {
  id: string;
  ownerOrgId?: string;
  ownerHumanId?: string;
  name: string;
  description: string;
  benefitsDescription: string;
  /** Integer cents, never floats. */
  priceCents: number;
  currency: string;
  interval: "MONTH" | "YEAR";
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  sortOrder: number;
};

type SeedMembership = {
  id: string;
  tierId: string;
  memberHumanId: string;
  /** Stripe's vocabulary verbatim — never re-cased. */
  status: string;
  /** Days from now; negative is in the past. */
  periodStartDays: number;
  periodEndDays: number;
  cancelAtPeriodEnd?: boolean;
  /**
   * Days ago the row was created. Only matters for `incomplete`, where
   * `createdAt` is what the 24h stuck-signup grace window is measured against
   * — and it is also the one timestamp the platform view reports as EXACT
   * rather than approximate.
   */
  createdDaysAgo?: number;
};

/**
 * Six tiers across four owners, priced so the revenue panel has something to
 * normalise.
 *
 * "Patron" is annual at $119.99 ON PURPOSE. With three active annual members
 * the annualised USD total lands at 109,197 cents, which is not divisible by
 * 12 — so `floor(total / 12)` discards 9 cents and the panel's
 * `monthlyRemainderCents` field renders instead of sitting permanently at
 * zero. A fixture set where every price divided evenly would leave that whole
 * branch of the money maths unexercised in dev, which is precisely where a
 * rounding bug would hide.
 */
function buildSeedTiers(): SeedTier[] {
  return [
    {
      id: DEMO_IDS.membershipTierSustaining,
      ownerOrgId: DEMO_IDS.org,
      name: "Sustaining Member",
      description: "Monthly support for everything we put on.",
      benefitsDescription:
        "10% off every ticket, first look at on-sales, and your name on the wall.",
      priceCents: 1_200,
      currency: "usd",
      interval: "MONTH",
      status: "ACTIVE",
      sortOrder: 0,
    },
    {
      id: DEMO_IDS.membershipTierPatron,
      ownerOrgId: DEMO_IDS.org,
      name: "Patron",
      description: "A year of support, paid once.",
      benefitsDescription:
        "Everything in Sustaining Member, plus two guest passes a year.",
      priceCents: 11_999,
      currency: "usd",
      interval: "YEAR",
      status: "ACTIVE",
      sortOrder: 1,
    },
    {
      // A DRAFT tier, so the standing table's "tiers: N active / M total"
      // cell shows a real difference between the two numbers.
      id: DEMO_IDS.membershipTierDraft,
      ownerOrgId: DEMO_IDS.org,
      name: "Founding Circle",
      description: "Not published yet.",
      benefitsDescription: "To be decided.",
      priceCents: 5_000,
      currency: "usd",
      interval: "MONTH",
      status: "DRAFT",
      sortOrder: 2,
    },
    {
      id: DEMO_IDS.membershipTierSupporter,
      ownerOrgId: DEMO_IDS.org2,
      name: "Supporter",
      description: "The small monthly one.",
      benefitsDescription: "5% off tickets and a monthly what's-on note.",
      priceCents: 500,
      currency: "usd",
      interval: "MONTH",
      status: "ACTIVE",
      sortOrder: 0,
    },
    {
      // HUMAN-owned, so every owner-XOR branch in the read models is
      // exercised: an org-owned tier links to `/admin/<slug>`, a human-owned
      // one has no admin surface and must render as plain text.
      id: DEMO_IDS.membershipTierBacker,
      ownerHumanId: DEMO_IDS.human2,
      name: "Backer",
      description: "Support the work directly.",
      benefitsDescription: "Early demos and 10% off my own shows.",
      priceCents: 800,
      currency: "usd",
      interval: "MONTH",
      status: "ACTIVE",
      sortOrder: 0,
    },
    {
      // Non-USD, so the revenue panel's per-currency split is visible rather
      // than theoretical. Currencies never sum together.
      id: DEMO_IDS.membershipTierAmigo,
      ownerOrgId: DEMO_IDS.orgMxn,
      name: "Amigo del Foro",
      description: "Apoyo mensual.",
      benefitsDescription: "10% de descuento en boletos y acceso anticipado.",
      priceCents: 15_000,
      currency: "mxn",
      interval: "MONTH",
      status: "ACTIVE",
      sortOrder: 0,
    },
  ];
}

/**
 * Fifteen memberships covering every state the platform surfaces branch on.
 *
 * `active` and `trialing` feed the revenue panel (and only `active` is
 * valued); `past_due` and `unpaid` are the benefits-already-denied rows;
 * `incomplete` past its grace window is the abandoned signup; two
 * `cancelAtPeriodEnd` rows sit inside the 14-day leaving window. A row can be
 * `active` AND cancelling — it is still paying for the current period, so it
 * still counts as revenue, and having one in the fixtures is what stops that
 * from being an untested assumption.
 */
function buildSeedMemberships(): SeedMembership[] {
  return [
    // ── Sustaining Member (demo org, $12.00/mo) ────────────────────────────
    {
      id: DEMO_IDS.membershipSustainingActive1,
      tierId: DEMO_IDS.membershipTierSustaining,
      memberHumanId: DEMO_IDS.human2,
      status: "active",
      periodStartDays: -9,
      periodEndDays: 21,
    },
    {
      id: DEMO_IDS.membershipSustainingActive2,
      tierId: DEMO_IDS.membershipTierSustaining,
      memberHumanId: DEMO_IDS.human3,
      status: "active",
      periodStartDays: -3,
      periodEndDays: 27,
    },
    {
      id: DEMO_IDS.membershipSustainingActive3,
      tierId: DEMO_IDS.membershipTierSustaining,
      memberHumanId: DEMO_IDS.human4,
      status: "active",
      periodStartDays: -17,
      periodEndDays: 13,
    },
    {
      // Benefits ALREADY DENIED. This is the state that had no operational
      // surface at all before `memberships.report-health`.
      id: DEMO_IDS.membershipSustainingPastDue,
      tierId: DEMO_IDS.membershipTierSustaining,
      memberHumanId: DEMO_IDS.human5,
      status: "past_due",
      periodStartDays: -11,
      periodEndDays: 19,
    },
    {
      // Still active, still paying, already told us they are going. Ends
      // inside the leaving window.
      id: DEMO_IDS.membershipSustainingLeaving,
      tierId: DEMO_IDS.membershipTierSustaining,
      memberHumanId: DEMO_IDS.human6,
      status: "active",
      periodStartDays: -24,
      periodEndDays: 6,
      cancelAtPeriodEnd: true,
    },
    {
      // Signup that never completed, well past the 24h grace window.
      id: DEMO_IDS.membershipSustainingIncomplete,
      tierId: DEMO_IDS.membershipTierSustaining,
      memberHumanId: DEMO_IDS.human7,
      status: "incomplete",
      periodStartDays: -4,
      periodEndDays: 26,
      createdDaysAgo: 4,
    },

    // ── Patron (demo org, $119.99/yr) ──────────────────────────────────────
    {
      id: DEMO_IDS.membershipPatronActive1,
      tierId: DEMO_IDS.membershipTierPatron,
      memberHumanId: DEMO_IDS.human7,
      status: "active",
      periodStartDays: -120,
      periodEndDays: 245,
    },
    {
      id: DEMO_IDS.membershipPatronActive2,
      tierId: DEMO_IDS.membershipTierPatron,
      memberHumanId: DEMO_IDS.devUser,
      status: "active",
      periodStartDays: -40,
      periodEndDays: 325,
    },
    {
      // An ANNUAL member on their way out, 12 days from the end of a year
      // they have already paid for.
      id: DEMO_IDS.membershipPatronLeaving,
      tierId: DEMO_IDS.membershipTierPatron,
      memberHumanId: DEMO_IDS.human2,
      status: "active",
      periodStartDays: -353,
      periodEndDays: 12,
      cancelAtPeriodEnd: true,
    },

    // ── Supporter (org2, $5.00/mo) ─────────────────────────────────────────
    {
      id: DEMO_IDS.membershipSupporterActive,
      tierId: DEMO_IDS.membershipTierSupporter,
      memberHumanId: DEMO_IDS.human3,
      status: "active",
      periodStartDays: -6,
      periodEndDays: 24,
    },
    {
      // Entitled to benefits, has paid nothing. Counted, never valued.
      id: DEMO_IDS.membershipSupporterTrialing,
      tierId: DEMO_IDS.membershipTierSupporter,
      memberHumanId: DEMO_IDS.human2,
      status: "trialing",
      periodStartDays: -2,
      periodEndDays: 12,
    },

    // ── Backer (human-owned, $8.00/mo) ─────────────────────────────────────
    {
      id: DEMO_IDS.membershipBackerActive,
      tierId: DEMO_IDS.membershipTierBacker,
      memberHumanId: DEMO_IDS.human4,
      status: "active",
      periodStartDays: -14,
      periodEndDays: 16,
    },
    {
      // `unpaid` is past_due's terminal cousin: Stripe has exhausted its
      // retries. Benefits denied just the same.
      id: DEMO_IDS.membershipBackerUnpaid,
      tierId: DEMO_IDS.membershipTierBacker,
      memberHumanId: DEMO_IDS.human5,
      status: "unpaid",
      periodStartDays: -38,
      periodEndDays: -8,
    },

    // ── Amigo del Foro (MXN org, MX$150.00/mo) ─────────────────────────────
    {
      id: DEMO_IDS.membershipAmigoActive1,
      tierId: DEMO_IDS.membershipTierAmigo,
      memberHumanId: DEMO_IDS.human6,
      status: "active",
      periodStartDays: -5,
      periodEndDays: 25,
    },
    {
      id: DEMO_IDS.membershipAmigoActive2,
      tierId: DEMO_IDS.membershipTierAmigo,
      memberHumanId: DEMO_IDS.human7,
      status: "active",
      periodStartDays: -19,
      periodEndDays: 11,
    },
  ];
}

/**
 * Create-if-absent membership tiers and memberships for the platform
 * membership surfaces.
 *
 * Skips any fixture whose owner, member or tier is not present (the seed's
 * org/human set varies by which fixtures a given run created), so a partial
 * database gets partial fixtures rather than a foreign-key crash — the same
 * posture `ensurePayoutHistory` takes toward missing payees.
 */
export const ensureMembershipFixtures = async (
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ tiers: number; memberships: number }> => {
  const tiers = buildSeedTiers();
  const memberships = buildSeedMemberships();

  const orgIds = [
    ...new Set(tiers.map((t) => t.ownerOrgId).filter((v): v is string => !!v)),
  ];
  const humanIds = [
    ...new Set([
      ...tiers.map((t) => t.ownerHumanId).filter((v): v is string => !!v),
      ...memberships.map((m) => m.memberHumanId),
    ]),
  ];

  const [existingOrgs, existingHumans] = await Promise.all([
    prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true },
    }),
    prisma.human.findMany({
      where: { id: { in: humanIds } },
      select: { id: true },
    }),
  ]);
  const orgSet = new Set(existingOrgs.map((o) => o.id));
  const humanSet = new Set(existingHumans.map((h) => h.id));

  let createdTiers = 0;
  const liveTierIds = new Set<string>();

  for (const tier of tiers) {
    if (tier.ownerOrgId && !orgSet.has(tier.ownerOrgId)) continue;
    if (tier.ownerHumanId && !humanSet.has(tier.ownerHumanId)) continue;

    const existing = await prisma.membershipTier.findUnique({
      where: { id: tier.id },
      select: { id: true },
    });
    if (existing) {
      // Already there — a re-run must not touch it. Still record the id so
      // memberships below can attach to a tier a previous run created.
      liveTierIds.add(tier.id);
      continue;
    }

    await prisma.membershipTier.create({
      data: {
        id: tier.id,
        ownerOrgId: tier.ownerOrgId ?? null,
        ownerHumanId: tier.ownerHumanId ?? null,
        name: tier.name,
        description: tier.description,
        benefitsDescription: tier.benefitsDescription,
        priceCents: tier.priceCents,
        currency: tier.currency,
        interval: tier.interval,
        status: tier.status,
        sortOrder: tier.sortOrder,
        // stripeProductId / stripePriceId deliberately unset — see header.
      },
    });
    liveTierIds.add(tier.id);
    createdTiers += 1;
  }

  let createdMemberships = 0;

  for (const membership of memberships) {
    if (!liveTierIds.has(membership.tierId)) continue;
    if (!humanSet.has(membership.memberHumanId)) continue;

    const existing = await prisma.membership.findUnique({
      where: { id: membership.id },
      select: { id: true },
    });
    if (existing) continue;

    // The (tierId, memberHumanId) unique index is how a returning member
    // reuses a row. A hand-created row for the same pair must win, so check
    // that too rather than letting the create throw P2002 and abort the seed.
    const conflicting = await prisma.membership.findUnique({
      where: {
        tierId_memberHumanId: {
          tierId: membership.tierId,
          memberHumanId: membership.memberHumanId,
        },
      },
      select: { id: true },
    });
    if (conflicting) continue;

    const createdAt =
      membership.createdDaysAgo === undefined
        ? undefined
        : new Date(now.getTime() - membership.createdDaysAgo * DAY_MS);

    await prisma.membership.create({
      data: {
        id: membership.id,
        tierId: membership.tierId,
        memberHumanId: membership.memberHumanId,
        // Obviously-fake ids. Nothing sweeps them — see the header.
        stripeSubscriptionId: `sub_seed_${membership.id.slice(-12)}`,
        stripeCustomerId: `cus_seed_${membership.memberHumanId.slice(-12)}`,
        status: membership.status,
        currentPeriodStart: daysFromNow(now, membership.periodStartDays),
        currentPeriodEnd: daysFromNow(now, membership.periodEndDays),
        cancelAtPeriodEnd: membership.cancelAtPeriodEnd ?? false,
        // `canceledAt` stays null: none of these have actually ended. A
        // cancelAtPeriodEnd row is still live, which is the whole point of the
        // "Leaving" section.
        startedAt: daysFromNow(now, membership.periodStartDays),
        ...(createdAt ? { createdAt } : {}),
        // taxJurisdictionId / billingPostalCode / billingCountryCode
        // deliberately unset — see the header.
      },
    });
    createdMemberships += 1;
  }

  return { tiers: createdTiers, memberships: createdMemberships };
};
