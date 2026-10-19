import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeMembershipsRepo } from "../memberships";

// ---------------------------------------------------------------------------
// Integration coverage for the three membership HEALTH reads behind
// /platform/memberships and `memberships.report-health`.
//
// Real Postgres, because none of what matters here is provable against a
// mocked Prisma client: a nested relation include, an OR'd bucket predicate,
// a keyset cursor with an id tie-break, and a `groupBy` over two columns. A
// mocked client would happily return whatever the test handed it.
//
// Same harness shape as `payout-items-history.integration.test.ts`: hand-rolled
// DDL for exactly the columns the queries touch, a real PrismaClient over
// PrismaPg (WITHOUT which these adapter suites silently SKIP), and a TRUNCATE
// between cases.
//
// The load-bearing properties under test:
//   1. COUNT AND LIST AGREE. The badge and the table are built from the same
//      predicates; a count that disagrees with the rows beneath it is the
//      defect this page would most easily ship.
//   2. The cursor's id tie-break actually holds when two rows share a
//      timestamp — without it a page boundary silently drops or repeats rows.
//   3. A `cancelAtPeriodEnd` row whose period end has already passed is NOT in
//      the "leaving" bucket. There is no window left to intervene in.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "MembershipInterval" AS ENUM ('MONTH', 'YEAR');
CREATE TYPE "MembershipTierStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Human" (
  "id" TEXT NOT NULL,
  "name" TEXT,
  CONSTRAINT "Human_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipTier" (
  "id" TEXT NOT NULL,
  "ownerOrgId" TEXT,
  "ownerHumanId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "benefitsDescription" VARCHAR(500),
  "priceCents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
  "interval" "MembershipInterval" NOT NULL DEFAULT 'MONTH',
  "stripeProductId" TEXT,
  "stripePriceId" TEXT,
  "status" "MembershipTierStatus" NOT NULL DEFAULT 'DRAFT',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipTier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipTier_ownerOrgId_fkey" FOREIGN KEY ("ownerOrgId")
    REFERENCES "Organization"("id") ON DELETE CASCADE,
  CONSTRAINT "MembershipTier_ownerHumanId_fkey" FOREIGN KEY ("ownerHumanId")
    REFERENCES "Human"("id") ON DELETE CASCADE
);

CREATE TABLE "Membership" (
  "id" TEXT NOT NULL,
  "tierId" TEXT NOT NULL,
  "memberHumanId" TEXT NOT NULL,
  "stripeSubscriptionId" TEXT NOT NULL,
  "stripeCustomerId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "taxJurisdictionId" TEXT,
  "billingPostalCode" TEXT,
  "billingCountryCode" VARCHAR(2),
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "canceledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Membership_tierId_fkey" FOREIGN KEY ("tierId")
    REFERENCES "MembershipTier"("id") ON DELETE CASCADE,
  CONSTRAINT "Membership_memberHumanId_fkey" FOREIGN KEY ("memberHumanId")
    REFERENCES "Human"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "Membership_stripeSubscriptionId_key"
  ON "Membership"("stripeSubscriptionId");
CREATE UNIQUE INDEX "Membership_tierId_memberHumanId_key"
  ON "Membership"("tierId", "memberHumanId");
`;

const ORG = "org_1";
const HUMAN_OWNER = "human_owner";
const ORG_TIER = "tier_org";
const HUMAN_TIER = "tier_human";

const T = (iso: string) => new Date(iso);
const NOW = T("2026-09-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** The statuses the use cases pass, so the queries are exercised as shipped. */
const PAYMENT_FAILING = ["past_due", "unpaid"];
const LIVE = ["active", "trialing", "past_due", "unpaid"];

const baseQuery = {
  paymentFailingStatuses: PAYMENT_FAILING,
  liveStatuses: LIVE,
  incompleteBefore: new Date(NOW.getTime() - DAY_MS),
  leavingFrom: NOW,
  leavingBefore: new Date(NOW.getTime() + 14 * DAY_MS),
};

describe("memberships health reads (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repo: ReturnType<typeof makeMembershipsRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repo = makeMembershipsRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE "Membership", "MembershipTier", "Human", "Organization" CASCADE`,
    );
    await pool!.query(
      `INSERT INTO "Organization" ("id","name","slug") VALUES ($1,$2,$3)`,
      [ORG, "Ithas Fire Demo Org", "demo"],
    );
    await pool!.query(`INSERT INTO "Human" ("id","name") VALUES ($1,$2)`, [
      HUMAN_OWNER,
      "Alex Rivera",
    ]);
    await pool!.query(
      `INSERT INTO "MembershipTier"
         ("id","ownerOrgId","ownerHumanId","name","priceCents","currency","interval","status")
       VALUES
         ($1, $2, NULL, 'Sustaining Member', 1200, 'usd', 'MONTH', 'ACTIVE'),
         ($3, NULL, $4, 'Backer', 800, 'usd', 'MONTH', 'ACTIVE')`,
      [ORG_TIER, ORG, HUMAN_TIER, HUMAN_OWNER],
    );
  });

  // Tearing a Testcontainers Postgres down routinely outruns vitest's 10s
  // default hook timeout, failing a suite whose every test already passed.
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  let humanSeq = 0;
  async function member(name: string | null): Promise<string> {
    const id = `member_${++humanSeq}`;
    await pool!.query(`INSERT INTO "Human" ("id","name") VALUES ($1,$2)`, [
      id,
      name,
    ]);
    return id;
  }

  // Timestamps go over the wire as ISO strings, not JS Dates: the columns are
  // TIMESTAMP(3) WITHOUT time zone and node-pg serialises a Date in the
  // process's LOCAL zone, which would shift every pinned instant by the box's
  // UTC offset.
  async function membership(opts: {
    id: string;
    tierId?: string;
    memberHumanId: string;
    status: string;
    periodStart?: Date;
    periodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    await pool!.query(
      `INSERT INTO "Membership"
         ("id","tierId","memberHumanId","stripeSubscriptionId","stripeCustomerId",
          "status","currentPeriodStart","currentPeriodEnd","cancelAtPeriodEnd",
          "startedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamp,$8::timestamp,$9,
               $10::timestamp,$10::timestamp,$11::timestamp)`,
      [
        opts.id,
        opts.tierId ?? ORG_TIER,
        opts.memberHumanId,
        `sub_${opts.id}`,
        `cus_${opts.memberHumanId}`,
        opts.status,
        (opts.periodStart ?? T("2026-09-01T09:00:00.000Z")).toISOString(),
        (opts.periodEnd ?? T("2026-10-01T09:00:00.000Z")).toISOString(),
        opts.cancelAtPeriodEnd ?? false,
        (opts.createdAt ?? T("2026-05-01T09:00:00.000Z")).toISOString(),
        (opts.updatedAt ?? T("2026-09-02T09:00:00.000Z")).toISOString(),
      ],
    );
  }

  test("countHealth counts the three signals separately, never summed", async () => {
    const [a, b, c, d, e] = await Promise.all([
      member("A"),
      member("B"),
      member("C"),
      member("D"),
      member("E"),
    ]);
    await membership({ id: "m_pastdue", memberHumanId: a, status: "past_due" });
    await membership({
      id: "m_unpaid",
      tierId: HUMAN_TIER,
      memberHumanId: a,
      status: "unpaid",
    });
    await membership({
      id: "m_incomplete",
      memberHumanId: b,
      status: "incomplete",
      createdAt: T("2026-09-07T09:00:00.000Z"),
    });
    await membership({
      id: "m_leaving",
      memberHumanId: c,
      status: "active",
      periodEnd: new Date(NOW.getTime() + 6 * DAY_MS),
      cancelAtPeriodEnd: true,
    });
    await membership({ id: "m_active", memberHumanId: d, status: "active" });
    await membership({
      id: "m_trialing",
      memberHumanId: e,
      status: "trialing",
    });

    await expect(repo.countHealth(baseQuery)).resolves.toEqual({
      paymentFailing: 2,
      stuckIncomplete: 1,
      leavingSoon: 1,
    });
  });

  test("a failing card that is ALSO leaving counts in BOTH buckets", async () => {
    // The buckets OVERLAP by design. `leavingWhere` admits every LIVE status
    // and `MEMBERSHIP_LIVE_STATUSES` includes past_due/unpaid, so this member
    // is both "the card is failing" and "the last window to intervene" — two
    // facts about one person, each calling for a different action.
    //
    // This test exists in both directions. It fails if someone narrows
    // `leaving` to exclude failing cards (hiding the most urgent retention
    // case there is), and it documents why the three counts must never be
    // summed: 1 + 0 + 1 here describes ONE membership, not two.
    const a = await member("Both");
    await membership({
      id: "m_both",
      memberHumanId: a,
      status: "past_due",
      periodEnd: new Date(NOW.getTime() + 3 * DAY_MS),
      cancelAtPeriodEnd: true,
    });

    const counts = await repo.countHealth(baseQuery);
    expect(counts).toEqual({
      paymentFailing: 1,
      stuckIncomplete: 0,
      leavingSoon: 1,
    });

    const attention = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
    });
    const leaving = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "leaving",
    });
    expect(attention.items.map((r) => r.id)).toEqual(["m_both"]);
    expect(leaving.items.map((r) => r.id)).toEqual(["m_both"]);
  });

  test("a FRESH incomplete signup is inside the grace window and is not counted", async () => {
    const a = await member("A");
    await membership({
      id: "m_fresh",
      memberHumanId: a,
      status: "incomplete",
      // Two hours ago — the member may still be mid-3DS.
      createdAt: new Date(NOW.getTime() - 2 * 3_600_000),
    });

    const counts = await repo.countHealth(baseQuery);
    expect(counts.stuckIncomplete).toBe(0);

    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
    });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  test("incomplete_expired is never chased — Stripe has already given up", async () => {
    const a = await member("A");
    await membership({
      id: "m_expired",
      memberHumanId: a,
      status: "incomplete_expired",
      createdAt: T("2026-08-01T09:00:00.000Z"),
    });

    const counts = await repo.countHealth(baseQuery);
    expect(counts.stuckIncomplete).toBe(0);
    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
    });
    expect(page.items).toEqual([]);
  });

  test("a cancelAtPeriodEnd row whose period ALREADY ended is not 'leaving'", async () => {
    // There is no window left to intervene in, so calling it a retention
    // opportunity would send someone to a conversation that is over.
    const a = await member("A");
    await membership({
      id: "m_gone",
      memberHumanId: a,
      status: "active",
      periodEnd: new Date(NOW.getTime() - DAY_MS),
      cancelAtPeriodEnd: true,
    });

    expect((await repo.countHealth(baseQuery)).leavingSoon).toBe(0);
    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "leaving",
    });
    expect(page.items).toEqual([]);
  });

  test("a CANCELED row is not 'leaving' — it has already gone", async () => {
    const a = await member("A");
    await membership({
      id: "m_canceled",
      memberHumanId: a,
      status: "canceled",
      periodEnd: new Date(NOW.getTime() + 5 * DAY_MS),
      cancelAtPeriodEnd: true,
    });
    expect((await repo.countHealth(baseQuery)).leavingSoon).toBe(0);
  });

  test("a period end beyond the horizon is not yet 'leaving'", async () => {
    const a = await member("A");
    await membership({
      id: "m_far",
      memberHumanId: a,
      status: "active",
      periodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
      cancelAtPeriodEnd: true,
    });
    expect((await repo.countHealth(baseQuery)).leavingSoon).toBe(0);
  });

  test("listHealthPositions joins member, tier and BOTH kinds of owner", async () => {
    const a = await member("Jamie Chen");
    const b = await member(null);
    await membership({ id: "m_org", memberHumanId: a, status: "past_due" });
    await membership({
      id: "m_human",
      tierId: HUMAN_TIER,
      memberHumanId: b,
      status: "unpaid",
      updatedAt: T("2026-09-03T09:00:00.000Z"),
    });

    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
    });

    expect(page.items.map((r) => r.id)).toEqual(["m_org", "m_human"]);
    expect(page.items[0]).toMatchObject({
      memberName: "Jamie Chen",
      tierName: "Sustaining Member",
      tierPriceCents: 1_200,
      tierCurrency: "usd",
      tierInterval: "MONTH",
      ownerOrgId: ORG,
      ownerOrgName: "Ithas Fire Demo Org",
      ownerOrgSlug: "demo",
      ownerHumanId: null,
    });
    expect(page.items[1]).toMatchObject({
      // A human with no display name comes back null, not blank or missing.
      memberName: null,
      tierName: "Backer",
      ownerOrgId: null,
      ownerOrgSlug: null,
      ownerHumanId: HUMAN_OWNER,
      ownerHumanName: "Alex Rivera",
    });
  });

  test("attention orders longest-stuck FIRST", async () => {
    const [a, b, c] = await Promise.all([
      member("A"),
      member("B"),
      member("C"),
    ]);
    await membership({
      id: "m_recent",
      memberHumanId: a,
      status: "past_due",
      updatedAt: T("2026-09-10T09:00:00.000Z"),
    });
    await membership({
      id: "m_oldest",
      memberHumanId: b,
      status: "past_due",
      updatedAt: T("2026-07-01T09:00:00.000Z"),
    });
    await membership({
      id: "m_middle",
      memberHumanId: c,
      status: "unpaid",
      updatedAt: T("2026-08-15T09:00:00.000Z"),
    });

    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
    });
    expect(page.items.map((r) => r.id)).toEqual([
      "m_oldest",
      "m_middle",
      "m_recent",
    ]);
  });

  test("leaving orders soonest-to-go FIRST", async () => {
    const [a, b] = await Promise.all([member("A"), member("B")]);
    await membership({
      id: "m_later",
      memberHumanId: a,
      status: "active",
      periodEnd: new Date(NOW.getTime() + 12 * DAY_MS),
      cancelAtPeriodEnd: true,
    });
    await membership({
      id: "m_sooner",
      memberHumanId: b,
      status: "active",
      periodEnd: new Date(NOW.getTime() + 2 * DAY_MS),
      cancelAtPeriodEnd: true,
    });

    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "leaving",
    });
    expect(page.items.map((r) => r.id)).toEqual(["m_sooner", "m_later"]);
  });

  test("the cursor pages every row exactly once, even on a TIMESTAMP TIE", async () => {
    // The id tie-break is load-bearing. Without it Postgres is free to order
    // same-timestamp rows differently between the two queries, and a row
    // silently vanishes across the page boundary or arrives twice.
    const tied = T("2026-08-01T09:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await member(`Tied ${i}`);
      const id = `m_tied_${i}`;
      ids.push(id);
      await membership({
        id,
        memberHumanId: m,
        status: "past_due",
        updatedAt: tied,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<
        ReturnType<typeof repo.listHealthPositions>
      > = await repo.listHealthPositions({
        ...baseQuery,
        bucket: "attention",
        limit: 2,
        cursor,
      });
      seen.push(...page.items.map((r) => r.id));
      // The badge total covers the WHOLE bucket on every page, never the
      // remainder — a count that shrank as you paged would read as rows
      // disappearing.
      expect(page.total).toBe(5);
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen.sort()).toEqual(ids.sort());
    expect(new Set(seen).size).toBe(5);
  });

  test("a garbage cursor restarts from the top instead of throwing", async () => {
    const a = await member("A");
    await membership({ id: "m_1", memberHumanId: a, status: "past_due" });

    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
      cursor: "not-a-cursor",
    });
    expect(page.items.map((r) => r.id)).toEqual(["m_1"]);
  });

  test("a cursor from the OTHER bucket restarts rather than answering wrongly", async () => {
    // `at` is `updatedAt` in the attention bucket and `currentPeriodEnd` in the
    // leaving one, so a crossed cursor compares two unrelated timestamps. The
    // failure mode without the bucket stamp is not an empty page — it is a
    // WRONG page, which looks like data.
    const [a, b, c] = await Promise.all([
      member("A"),
      member("B"),
      member("C"),
    ]);
    await membership({
      id: "m_leaving_1",
      memberHumanId: a,
      status: "active",
      periodEnd: new Date(NOW.getTime() + 2 * DAY_MS),
      cancelAtPeriodEnd: true,
    });
    await membership({
      id: "m_leaving_2",
      memberHumanId: b,
      status: "active",
      periodEnd: new Date(NOW.getTime() + 9 * DAY_MS),
      cancelAtPeriodEnd: true,
    });
    // An ATTENTION row is REQUIRED for this test to discriminate. Its
    // `updatedAt` sits in the PAST, while the crossed cursor's `at` is a
    // `currentPeriodEnd` in the FUTURE — so an unchecked cursor filters
    // `updatedAt > <future>` and silently hides it. Without this row both the
    // checked and the unchecked path return an empty page and the test is
    // inert. (It was, on first write; the mutation ran green.)
    await membership({
      id: "m_attention",
      memberHumanId: c,
      status: "past_due",
      updatedAt: T("2026-09-02T09:00:00.000Z"),
    });

    const first = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "leaving",
      limit: 1,
    });
    expect(first.nextCursor).toBeTruthy();

    // Replay the LEAVING cursor against ATTENTION. It must be IGNORED, so the
    // attention bucket answers from the top — not filtered by a period-end
    // timestamp that means nothing to it.
    const crossed = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
      cursor: first.nextCursor,
    });
    expect(crossed.items.map((r) => r.id)).toEqual(["m_attention"]);
    expect(crossed.total).toBe(1);

    // And the same cursor still works for the bucket that minted it.
    const second = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "leaving",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((r) => r.id)).toEqual(["m_leaving_2"]);
  });

  test("the count and the list agree on exactly the same rows", async () => {
    const [a, b, c, d] = await Promise.all([
      member("A"),
      member("B"),
      member("C"),
      member("D"),
    ]);
    await membership({ id: "m_a", memberHumanId: a, status: "past_due" });
    await membership({ id: "m_b", memberHumanId: b, status: "unpaid" });
    await membership({
      id: "m_c",
      memberHumanId: c,
      status: "incomplete",
      createdAt: T("2026-09-01T09:00:00.000Z"),
    });
    await membership({ id: "m_d", memberHumanId: d, status: "active" });

    const counts = await repo.countHealth(baseQuery);
    const page = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
      limit: 100,
    });

    expect(page.total).toBe(counts.paymentFailing + counts.stuckIncomplete);
    expect(page.items).toHaveLength(page.total);
  });

  test("countByTierAndStatus groups by BOTH columns and honours the status filter", async () => {
    const [a, b, c, d] = await Promise.all([
      member("A"),
      member("B"),
      member("C"),
      member("D"),
    ]);
    await membership({ id: "m_a", memberHumanId: a, status: "active" });
    await membership({ id: "m_b", memberHumanId: b, status: "active" });
    await membership({ id: "m_c", memberHumanId: c, status: "trialing" });
    // Excluded by the filter: a past_due member pays nothing this period.
    await membership({ id: "m_d", memberHumanId: d, status: "past_due" });
    await membership({
      id: "m_e",
      tierId: HUMAN_TIER,
      memberHumanId: a,
      status: "active",
    });

    const rows = await repo.countByTierAndStatus({
      statuses: ["active", "trialing"],
    });
    const key = (r: { tierId: string; status: string }) =>
      `${r.tierId}:${r.status}`;
    const map = new Map(rows.map((r) => [key(r), r.count]));

    expect(map.get(`${ORG_TIER}:active`)).toBe(2);
    expect(map.get(`${ORG_TIER}:trialing`)).toBe(1);
    expect(map.get(`${HUMAN_TIER}:active`)).toBe(1);
    expect(map.has(`${ORG_TIER}:past_due`)).toBe(false);
  });

  test("countByTierAndStatus short-circuits on an empty status list", async () => {
    await expect(repo.countByTierAndStatus({ statuses: [] })).resolves.toEqual(
      [],
    );
  });

  test("a statement budget still returns the same rows", async () => {
    // The budgeted path opens its OWN transaction and runs SET LOCAL; the
    // unbudgeted one does not. Both must answer identically.
    const a = await member("A");
    await membership({ id: "m_1", memberHumanId: a, status: "past_due" });

    const bare = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
    });
    const budgeted = await repo.listHealthPositions({
      ...baseQuery,
      bucket: "attention",
      statementTimeoutMs: 8_000,
    });

    expect(budgeted.items.map((r) => r.id)).toEqual(
      bare.items.map((r) => r.id),
    );
    expect(budgeted.total).toBe(bare.total);
  });
});
