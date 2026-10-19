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
import { makeDisputeEvidenceRepo } from "../../src/db/prisma/dispute-evidence";
import { makeOrdersRepo } from "../../src/db/prisma/orders";

// ---------------------------------------------------------------------------
// Dispute evidence adapter integration (dispute desk, step 2).
//
// Runs against REAL Postgres via `prisma migrate deploy`, which proves
// migration 20260901120000_dispute_evidence_package replays on a fresh
// database on top of the full history (enum + DisputeEvidence table + the
// Dispute mirror columns + Order.paymentCardChecks). Client construction
// copies booking-holds.test.ts EXACTLY: the repo's Prisma client runs in
// driver-adapter mode, so a bare `new PrismaClient()` throws and the suite
// would silently skip.
//
// Load-bearing SQL under test:
//   * `listForDesk` ordering — open: evidenceDueBy ASC NULLS LAST, id ASC;
//     closed: closedAt DESC NULLS LAST, id DESC — and the hand-built keyset
//     cursor across a NULL boundary (Prisma's `cursor:` emulation does not
//     honour NULLS LAST, which is exactly why it is hand-built).
//   * `upsertDraft` version bump + stamp reset on re-assemble.
//   * `updateEvidenceDetails` as a no-throw no-op for an unknown dispute.
// ---------------------------------------------------------------------------

describe("Prisma adapters integration – dispute evidence", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let buyerId: string;
  let orgId: string;
  let eventId: string;
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
      buyerId = buyer.id;
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
      eventId = event.id;
      const order = await prisma.order.create({
        data: {
          eventId,
          buyerHumanId: buyerId,
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
    status: "OPEN" | "UNDER_REVIEW" | "NEEDS_TRIAGE" | "WON" | "LOST";
    evidenceDueBy?: Date | null;
    closedAt?: Date | null;
    linked?: boolean;
  }) {
    const p = requireRuntime();
    return p.dispute.create({
      data: {
        stripeDisputeId: input.stripeDisputeId,
        orderId: input.linked === false ? null : orderId,
        ownerSubjectType: "ORGANIZATION",
        ownerSubjectId: orgId,
        ownerOrgId: orgId,
        amountCents: 5_000,
        currency: "usd",
        reason: "fraudulent",
        status: input.status,
        evidenceDueBy: input.evidenceDueBy ?? null,
        closedAt: input.closedAt ?? null,
      },
    });
  }

  test("migration applied: DisputeEvidence table, enum, mirror columns and Order.paymentCardChecks exist", async () => {
    const p = requireRuntime();
    const cols = await p.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'DisputeEvidence'`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "id",
        "disputeId",
        "status",
        "fields",
        "sources",
        "assembledAt",
        "assembledVersion",
        "reviewedByHumanId",
        "reviewedAt",
        "submittedByHumanId",
        "submittedAt",
        "submitError",
        "processorSubmissionCount",
        "reconciledFromProcessor",
      ]),
    );
    const disputeCols = await p.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Dispute'`,
    );
    expect(disputeCols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "evidenceHasEvidence",
        "evidencePastDue",
        "evidenceSubmissionCount",
        "evidenceSubmittedAt",
      ]),
    );
    const orderCols = await p.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Order' AND column_name = 'paymentCardChecks'`,
    );
    expect(orderCols).toHaveLength(1);
    const enumValues = await p.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'DisputeEvidenceStatus' ORDER BY enumsortorder`,
    );
    expect(enumValues.map((e) => e.enumlabel)).toEqual([
      "DRAFT",
      "APPROVED",
      "SUBMITTED",
      "SUBMIT_FAILED",
    ]);
  });

  test("upsertDraft creates v1, re-assembly bumps the version and clears every stamp; update + get round-trip", async () => {
    const p = requireRuntime();
    const repo = makeDisputeEvidenceRepo(p);
    const dispute = await seedDispute({ stripeDisputeId: "dp_up", status: "OPEN" });
    const sources = {
      order: "found",
      buyer: "found",
      buyerEmail: "missing",
      checkoutIp: "found",
      billingAddress: "found",
      event: "found",
      venue: "found",
      organizer: "found",
      refundPolicy: "found",
      termsAcceptance: "found",
      tickets: "found",
      scanLog: "missing",
      refundHistory: "missing",
      cardChecks: "missing",
      ticketEmail: "missing",
      statementDescriptor: "found",
      truncated: false,
    } as const;

    const v1 = await repo.upsertDraft({
      disputeId: dispute.id,
      fields: { productDescription: "2 tickets", customerName: "Buyer" },
      sources,
      assembledAt: new Date("2026-05-15T12:00:00.000Z"),
    });
    expect(v1.status).toBe("DRAFT");
    expect(v1.assembledVersion).toBe(1);
    expect(v1.fields).toEqual({ productDescription: "2 tickets", customerName: "Buyer" });
    expect(v1.sources).toEqual(sources);

    const approved = await repo.update({
      disputeId: dispute.id,
      status: "APPROVED",
      reviewedByHumanId: "staff_1",
      reviewedAt: new Date("2026-05-15T13:00:00.000Z"),
      // `""` is stored as-is (a deliberate clear), an absent key is absent.
      fields: { productDescription: "edited", customerName: "" },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewedByHumanId).toBe("staff_1");
    expect(approved.fields).toEqual({ productDescription: "edited", customerName: "" });

    const v2 = await repo.upsertDraft({
      disputeId: dispute.id,
      fields: { productDescription: "re-assembled" },
      sources: { ...sources, scanLog: "found" },
      assembledAt: new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(v2.id).toBe(v1.id);
    expect(v2.assembledVersion).toBe(2);
    expect(v2.status).toBe("DRAFT");
    expect(v2.reviewedByHumanId).toBeNull();
    expect(v2.reviewedAt).toBeNull();
    expect(v2.fields).toEqual({ productDescription: "re-assembled" });
    expect(v2.sources.scanLog).toBe("found");

    expect(await repo.getByDisputeId(dispute.id)).toEqual(v2);
    expect(await repo.getByDisputeId("nope")).toBeNull();
    await expect(
      repo.update({ disputeId: "nope", status: "APPROVED" }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_NOT_FOUND" });

    // Compare-and-set: a stale expectation writes NOTHING.
    await expect(
      repo.update({
        disputeId: dispute.id,
        expect: { status: "APPROVED", assembledVersion: 1 },
        status: "SUBMITTED",
        submittedByHumanId: "stale",
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_EVIDENCE_STATE_INVALID",
      meta: expect.objectContaining({
        actual: { status: "DRAFT", assembledVersion: 2 },
      }),
    });
    expect(await repo.getByDisputeId(dispute.id)).toEqual(v2);
    const stamped = await repo.update({
      disputeId: dispute.id,
      expect: { status: "DRAFT", assembledVersion: 2 },
      status: "APPROVED",
      reviewedByHumanId: "staff_2",
    });
    expect(stamped.status).toBe("APPROVED");
    expect(stamped.reconciledFromProcessor).toBeNull();

    // Reconcile write: fields + sources replaced, flag set, no desk submitter.
    const reconciled = await repo.update({
      disputeId: dispute.id,
      expect: { status: "APPROVED", assembledVersion: 2 },
      status: "SUBMITTED",
      fields: { productDescription: "from processor" },
      sources: { ...sources, order: "not_applicable" },
      submittedByHumanId: null,
      reconciledFromProcessor: true,
    });
    expect(reconciled).toMatchObject({
      status: "SUBMITTED",
      fields: { productDescription: "from processor" },
      submittedByHumanId: null,
      reconciledFromProcessor: true,
    });
    expect(reconciled.sources.order).toBe("not_applicable");
    const deskRow = (await makeDisputesRepo(p).listForDesk({ status: "open", limit: 5 })).items.find(
      (r) => r.id === dispute.id,
    );
    expect(deskRow?.evidenceReconciledFromProcessor).toBe(true);

    // 1:1 — a second package for the same dispute is impossible.
    await expect(
      p.disputeEvidence.create({
        data: {
          disputeId: dispute.id,
          fields: {},
          sources: {},
          assembledAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("updateEvidenceDetails writes the mirror columns and is a no-op for an unknown dispute", async () => {
    const p = requireRuntime();
    const repo = makeDisputesRepo(p);
    const seeded = await seedDispute({
      stripeDisputeId: "dp_mirror",
      status: "OPEN",
      evidenceDueBy: new Date("2026-05-25T00:00:00.000Z"),
    });

    const updated = await repo.updateEvidenceDetails({
      stripeDisputeId: "dp_mirror",
      evidenceHasEvidence: true,
      evidencePastDue: false,
      evidenceSubmissionCount: 1,
    });
    expect(updated).toMatchObject({
      id: seeded.id,
      evidenceHasEvidence: true,
      evidencePastDue: false,
      evidenceSubmissionCount: 1,
      evidenceSubmittedAt: null,
      // dueBy untouched when not supplied.
      evidenceDueBy: new Date("2026-05-25T00:00:00.000Z"),
    });

    const submitted = await repo.updateEvidenceDetails({
      stripeDisputeId: "dp_mirror",
      evidenceDueBy: null,
      evidenceHasEvidence: true,
      evidencePastDue: false,
      evidenceSubmissionCount: 1,
      evidenceSubmittedAt: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(submitted?.evidenceDueBy).toBeNull();
    expect(submitted?.evidenceSubmittedAt).toEqual(new Date("2026-05-20T00:00:00.000Z"));

    expect(
      await repo.updateEvidenceDetails({
        stripeDisputeId: "dp_unknown",
        evidenceHasEvidence: false,
        evidencePastDue: false,
        evidenceSubmissionCount: 0,
      }),
    ).toBeNull();
    expect(await repo.getById(seeded.id)).toMatchObject({ id: seeded.id });
    expect(await repo.getById("nope")).toBeNull();
  });

  test("listForDesk: open sorted by evidenceDueBy ASC NULLS LAST with a keyset cursor across the NULL boundary; closed by closedAt DESC NULLS LAST", async () => {
    const p = requireRuntime();
    const repo = makeDisputesRepo(p);
    const evidenceRepo = makeDisputeEvidenceRepo(p);

    const dueSoon = await seedDispute({
      stripeDisputeId: "dp_due_soon",
      status: "OPEN",
      evidenceDueBy: new Date("2026-05-20T00:00:00.000Z"),
    });
    const dueLater = await seedDispute({
      stripeDisputeId: "dp_due_later",
      status: "UNDER_REVIEW",
      evidenceDueBy: new Date("2026-05-28T00:00:00.000Z"),
    });
    const noDue = await seedDispute({
      stripeDisputeId: "dp_no_due",
      status: "NEEDS_TRIAGE",
      evidenceDueBy: null,
      linked: false,
    });
    const wonRecent = await seedDispute({
      stripeDisputeId: "dp_won",
      status: "WON",
      closedAt: new Date("2026-05-10T00:00:00.000Z"),
    });
    const lostOld = await seedDispute({
      stripeDisputeId: "dp_lost",
      status: "LOST",
      closedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const lostNoClose = await seedDispute({
      stripeDisputeId: "dp_lost_noclose",
      status: "LOST",
      closedAt: null,
    });
    await evidenceRepo.upsertDraft({
      disputeId: dueSoon.id,
      fields: { productDescription: "x" },
      sources: {} as never,
      assembledAt: new Date(),
    });

    // Open: soonest deadline first, never-due last; joined display fields.
    const openAll = await repo.listForDesk({ status: "open", limit: 10 });
    expect(openAll.items.map((r) => r.id)).toEqual([dueSoon.id, dueLater.id, noDue.id]);
    expect(openAll.nextCursor).toBeNull();
    expect(openAll.items[0]).toMatchObject({
      stripeDisputeId: "dp_due_soon",
      orderId,
      orderKind: "TICKETING",
      buyerHumanId: buyerId,
      buyerName: "Buyer Person",
      eventId,
      eventTitle: "Rock Show",
      ownerOrgId: orgId,
      ownerOrgName: "Drkmttr Collective",
      evidenceStatus: "DRAFT",
      evidenceAssembledVersion: 1,
    });
    expect(openAll.items[2]).toMatchObject({
      stripeDisputeId: "dp_no_due",
      orderId: null,
      buyerName: null,
      eventTitle: null,
      evidenceStatus: null,
    });

    // Cursoring one at a time walks the same order, including the step from
    // the last non-null deadline onto the NULL tail.
    const page1 = await repo.listForDesk({ status: "open", limit: 1 });
    expect(page1.items.map((r) => r.id)).toEqual([dueSoon.id]);
    expect(page1.nextCursor).toBe(dueSoon.id);
    const page2 = await repo.listForDesk({ status: "open", limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([dueLater.id]);
    expect(page2.nextCursor).toBe(dueLater.id);
    const page3 = await repo.listForDesk({ status: "open", limit: 1, cursor: page2.nextCursor });
    expect(page3.items.map((r) => r.id)).toEqual([noDue.id]);
    expect(page3.nextCursor).toBeNull();

    // A cursor from the OTHER tab (or garbage) restarts from the top.
    const restarted = await repo.listForDesk({ status: "open", limit: 10, cursor: wonRecent.id });
    expect(restarted.items.map((r) => r.id)).toEqual([dueSoon.id, dueLater.id, noDue.id]);

    // Closed: newest close first, never-closed last.
    const closed = await repo.listForDesk({ status: "closed", limit: 10 });
    expect(closed.items.map((r) => r.id)).toEqual([wonRecent.id, lostOld.id, lostNoClose.id]);
    const closed1 = await repo.listForDesk({ status: "closed", limit: 2 });
    expect(closed1.items.map((r) => r.id)).toEqual([wonRecent.id, lostOld.id]);
    const closed2 = await repo.listForDesk({ status: "closed", limit: 2, cursor: closed1.nextCursor });
    expect(closed2.items.map((r) => r.id)).toEqual([lostNoClose.id]);
    expect(closed2.nextCursor).toBeNull();

    // All: every row, open ordering.
    const all = await repo.listForDesk({ status: "all", limit: 10 });
    expect(all.items).toHaveLength(6);
    expect(all.items[0]?.id).toBe(dueSoon.id);
  });

  test("orders.setPaymentCardChecks round-trips through getById and null clears", async () => {
    const p = requireRuntime();
    const orders = makeOrdersRepo(p);
    await orders.setPaymentCardChecks(orderId, {
      addressLine1Check: "pass",
      addressPostalCodeCheck: "fail",
      cvcCheck: null,
    });
    expect((await orders.getById(orderId))?.paymentCardChecks).toEqual({
      addressLine1Check: "pass",
      addressPostalCodeCheck: "fail",
      cvcCheck: null,
    });
    await orders.setPaymentCardChecks(orderId, null);
    expect((await orders.getById(orderId))?.paymentCardChecks).toBeNull();
  });
});
