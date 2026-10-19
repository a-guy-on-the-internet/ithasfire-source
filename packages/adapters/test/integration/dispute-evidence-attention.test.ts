import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeDisputesRepo } from "../../src/db/prisma/disputes";

// ---------------------------------------------------------------------------
// `disputes.listOpenNeedingEvidenceAttention` — the daily evidence-deadline
// sweep's feed. Runs against REAL Postgres (testcontainers + `prisma migrate
// deploy`); client construction copies dispute-evidence.test.ts EXACTLY
// (driver-adapter mode — a bare `new PrismaClient()` throws and the suite
// would silently skip).
//
// Load-bearing SQL under test: the OR over (deadline within window | no
// deadline | no evidence row | SUBMIT_FAILED evidence), the status /
// orderId / evidenceSubmittedAt gates, `evidenceDueBy ASC NULLS LAST, id
// ASC` ordering, the relation-null filter on the 1:1 evidence row, and the
// cap.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-01T19:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("Prisma adapters integration – dispute evidence attention feed", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let humanOwnerId: string;
  let orderId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const buyer = await prisma.human.create({
        data: { name: "Buyer Person", status: "ACTIVE" },
      });
      const owner = await prisma.human.create({
        data: { name: "Solo Promoter", status: "ACTIVE" },
      });
      humanOwnerId = owner.id;
      const org = await prisma.organization.create({
        data: { name: "Drkmttr Collective", slug: "drkmttr" },
      });
      orgId = org.id;
      const event = await prisma.event.create({
        data: {
          title: "Rock Show",
          orgId,
          startsAt: new Date("2026-06-01T01:00:00.000Z"),
          endsAt: new Date("2026-06-01T04:00:00.000Z"),
          timezone: "America/Chicago",
        },
      });
      const order = await prisma.order.create({
        data: {
          eventId: event.id,
          buyerHumanId: buyer.id,
          amountGrossCents: 5_000,
          currency: "usd",
          status: "SUCCEEDED",
          feePolicySnapshot: {},
        },
      });
      orderId = order.id;
    } catch (err) {
      runtimeError = err instanceof Error ? err : new Error(String(err));
    }
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pg?.stop();
  }, 120_000);

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.disputeEvidence.deleteMany();
    await prisma.dispute.deleteMany();
  });

  function requireRuntime() {
    if (runtimeError) throw runtimeError;
    if (!prisma) throw new Error("prisma client not initialised");
    return prisma;
  }

  async function seedDispute(input: {
    stripeDisputeId: string;
    status?:
      | "OPEN"
      | "UNDER_REVIEW"
      | "NEEDS_TRIAGE"
      | "WARNING_OPEN"
      | "WON"
      | "LOST";
    evidenceDueBy?: Date | null;
    evidenceSubmittedAt?: Date | null;
    evidenceSubmissionCount?: number | null;
    linked?: boolean;
    owner?: "org" | "human";
    evidence?: "DRAFT" | "APPROVED" | "SUBMITTED" | "SUBMIT_FAILED" | null;
  }) {
    const p = requireRuntime();
    const row = await p.dispute.create({
      data: {
        stripeDisputeId: input.stripeDisputeId,
        orderId: input.linked === false ? null : orderId,
        ownerSubjectType: input.owner === "human" ? "HUMAN" : "ORGANIZATION",
        ownerSubjectId: input.owner === "human" ? humanOwnerId : orgId,
        ownerOrgId: input.owner === "human" ? null : orgId,
        ownerHumanId: input.owner === "human" ? humanOwnerId : null,
        amountCents: 5_000,
        currency: "usd",
        reason: "fraudulent",
        status: input.status ?? "OPEN",
        evidenceDueBy: input.evidenceDueBy ?? null,
        evidenceSubmittedAt: input.evidenceSubmittedAt ?? null,
        evidenceSubmissionCount: input.evidenceSubmissionCount ?? null,
      },
    });
    if (input.evidence) {
      await p.disputeEvidence.create({
        data: {
          disputeId: row.id,
          status: input.evidence,
          fields: {},
          sources: {},
          assembledAt: NOW,
        },
      });
    }
    return row;
  }

  test("returns only contestable, linked, unsubmitted disputes that need chasing, soonest deadline first, NULLs last", async () => {
    const p = requireRuntime();
    const repo = makeDisputesRepo(p);

    // IN the feed:
    const overdueDraft = await seedDispute({
      stripeDisputeId: "dp_overdue",
      evidenceDueBy: daysFromNow(-1),
      evidence: "DRAFT",
    });
    const dueSoonApproved = await seedDispute({
      stripeDisputeId: "dp_due_soon",
      evidenceDueBy: daysFromNow(3), // exactly at the window edge (lte)
      evidenceSubmissionCount: 0, // Stripe mirror observed, nothing submitted
      evidence: "APPROVED",
    });
    const noPackageFarDue = await seedDispute({
      stripeDisputeId: "dp_no_pkg",
      evidenceDueBy: daysFromNow(20),
      evidence: null,
    });
    const submitFailedFarDue = await seedDispute({
      stripeDisputeId: "dp_submit_failed",
      evidenceDueBy: daysFromNow(30),
      evidence: "SUBMIT_FAILED",
      owner: "human",
    });
    const noDueDate = await seedDispute({
      stripeDisputeId: "dp_no_due",
      evidenceDueBy: null,
      evidence: "DRAFT",
    });

    // NOT in the feed:
    await seedDispute({
      stripeDisputeId: "dp_far_draft",
      evidenceDueBy: new Date(daysFromNow(3).getTime() + 1_000),
      evidence: "DRAFT",
    });
    await seedDispute({
      stripeDisputeId: "dp_submitted",
      evidenceDueBy: daysFromNow(-1),
      evidenceSubmittedAt: daysFromNow(-2),
      evidence: "SUBMITTED",
    });
    // Submitted by hand in the Stripe Dashboard: the webhook mirror moves the
    // status to UNDER_REVIEW and counts the submission, but the desk stamp
    // stays null. Must NOT be chased (was: chased daily until Stripe closed).
    await seedDispute({
      stripeDisputeId: "dp_dashboard_submitted",
      status: "UNDER_REVIEW",
      evidenceDueBy: daysFromNow(-1),
      evidenceSubmissionCount: 1,
      evidence: "DRAFT",
    });
    // Same, before Stripe flipped the status: the count alone is enough.
    await seedDispute({
      stripeDisputeId: "dp_open_counted",
      status: "OPEN",
      evidenceDueBy: daysFromNow(-1),
      evidenceSubmissionCount: 1,
      evidence: "DRAFT",
    });
    // UNDER_REVIEW with nothing counted is still excluded on status alone.
    await seedDispute({
      stripeDisputeId: "dp_under_review_uncounted",
      status: "UNDER_REVIEW",
      evidenceDueBy: daysFromNow(1),
      evidence: "DRAFT",
    });
    await seedDispute({
      stripeDisputeId: "dp_triage",
      status: "NEEDS_TRIAGE",
      evidenceDueBy: daysFromNow(1),
      linked: false,
    });
    await seedDispute({
      stripeDisputeId: "dp_open_unlinked",
      status: "OPEN",
      evidenceDueBy: daysFromNow(1),
      linked: false,
    });
    await seedDispute({
      stripeDisputeId: "dp_warning",
      status: "WARNING_OPEN",
      evidenceDueBy: daysFromNow(1),
    });
    await seedDispute({
      stripeDisputeId: "dp_won",
      status: "WON",
      evidenceDueBy: daysFromNow(-5),
    });
    await seedDispute({
      stripeDisputeId: "dp_lost",
      status: "LOST",
      evidenceDueBy: null,
    });

    const rows = await repo.listOpenNeedingEvidenceAttention({
      now: NOW,
      dueWithinDays: 3,
    });

    expect(rows.map((r) => r.stripeDisputeId)).toEqual([
      "dp_overdue",
      "dp_due_soon",
      "dp_no_pkg",
      "dp_submit_failed",
      "dp_no_due",
    ]);
    expect(rows.map((r) => r.id)).toEqual([
      overdueDraft.id,
      dueSoonApproved.id,
      noPackageFarDue.id,
      submitFailedFarDue.id,
      noDueDate.id,
    ]);

    expect(rows[1]).toMatchObject({
      stripeDisputeId: "dp_due_soon",
      status: "OPEN",
      evidenceStatus: "APPROVED",
    });
    expect(rows[0]).toEqual({
      id: overdueDraft.id,
      stripeDisputeId: "dp_overdue",
      status: "OPEN",
      evidenceDueBy: daysFromNow(-1),
      evidencePastDue: null,
      amountCents: 5_000,
      currency: "usd",
      orderId,
      eventId: expect.any(String),
      eventTitle: "Rock Show",
      ownerOrgId: orgId,
      ownerOrgName: "Drkmttr Collective",
      ownerHumanId: null,
      ownerHumanName: null,
      evidenceStatus: "DRAFT",
    });
    expect(rows[2]).toMatchObject({
      stripeDisputeId: "dp_no_pkg",
      evidenceStatus: null,
    });
    expect(rows[3]).toMatchObject({
      stripeDisputeId: "dp_submit_failed",
      evidenceStatus: "SUBMIT_FAILED",
      ownerOrgId: null,
      ownerOrgName: null,
      ownerHumanId: humanOwnerId,
      ownerHumanName: "Solo Promoter",
    });
    expect(rows[4]).toMatchObject({
      stripeDisputeId: "dp_no_due",
      evidenceDueBy: null,
      evidenceStatus: "DRAFT",
    });
  });

  test("window is inclusive of now + dueWithinDays and honours the cap", async () => {
    const p = requireRuntime();
    const repo = makeDisputesRepo(p);

    await seedDispute({
      stripeDisputeId: "dp_edge",
      evidenceDueBy: daysFromNow(7),
      evidence: "DRAFT",
    });
    await seedDispute({
      stripeDisputeId: "dp_past_edge",
      evidenceDueBy: new Date(daysFromNow(7).getTime() + 1_000),
      evidence: "DRAFT",
    });
    await seedDispute({
      stripeDisputeId: "dp_sooner",
      evidenceDueBy: daysFromNow(1),
      evidence: "DRAFT",
    });

    const within7 = await repo.listOpenNeedingEvidenceAttention({
      now: NOW,
      dueWithinDays: 7,
    });
    expect(within7.map((r) => r.stripeDisputeId)).toEqual([
      "dp_sooner",
      "dp_edge",
    ]);

    const within3 = await repo.listOpenNeedingEvidenceAttention({
      now: NOW,
      dueWithinDays: 3,
    });
    expect(within3.map((r) => r.stripeDisputeId)).toEqual(["dp_sooner"]);

    const capped = await repo.listOpenNeedingEvidenceAttention({
      now: NOW,
      dueWithinDays: 7,
      limit: 1,
    });
    expect(capped.map((r) => r.stripeDisputeId)).toEqual(["dp_sooner"]);
  });

  test("clamps to the 200-row ceiling: 201 eligible rows, an oversized limit and the default both return 200", async () => {
    const p = requireRuntime();
    const repo = makeDisputesRepo(p);

    await p.dispute.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        stripeDisputeId: `dp_bulk_${String(i).padStart(3, "0")}`,
        orderId,
        ownerSubjectType: "ORGANIZATION" as const,
        ownerSubjectId: orgId,
        ownerOrgId: orgId,
        amountCents: 1_000,
        currency: "usd",
        reason: "fraudulent",
        status: "OPEN" as const,
        evidenceDueBy: daysFromNow(-1),
      })),
    });

    const oversized = await repo.listOpenNeedingEvidenceAttention({
      now: NOW,
      dueWithinDays: 3,
      limit: 10_000,
    });
    expect(oversized).toHaveLength(200);

    const defaulted = await repo.listOpenNeedingEvidenceAttention({
      now: NOW,
      dueWithinDays: 3,
    });
    expect(defaulted).toHaveLength(200);
  });
});
